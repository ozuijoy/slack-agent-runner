/**
 * The rules for the bot's long-term memory. The I/O is in src/memory-store.ts (GitHub) and
 * box/memory.mjs (the sandbox side); the doors are GET and POST /sandbox/memory in src/index.ts.
 *
 * The memory is Claude Code's OWN auto memory. The runner points `autoMemoryDirectory` at a folder
 * in the sandbox, and Claude reads its MEMORY.md index at the start of every session and writes
 * notes there as it learns. We add no memory skill and no recall tool, only the plumbing that makes
 * the folder outlive the sandbox: it is stored in a git repo (MEMORY_REPO), ONE FOLDER PER CHANNEL.
 *
 * Why git: memory is a prompt-injection channel that lasts. Claude reads text anyone can write, and
 * whatever it learns from that is replayed into every later thread in the channel. In git a bad
 * note is a commit you can read, diff and revert.
 *
 * THE BOUNDARY. A sandbox never gets a token that reaches the memory repo. The runner pulls and
 * pushes through the Worker with its one-turn token, and the Worker picks the folder from the
 * token's channel claim, never from the request. So a channel only ever sees and writes its own
 * folder, and a private channel's notes are never shared with anyone. (The turn's GitHub token is
 * minted for every repo EXCEPT the memory repo: src/github.ts.)
 *
 * Only Markdown files are synced: that is all auto memory writes, and it keeps the store text.
 */

/** Far above what auto memory writes (an index plus a few dozen short notes). */
export const MAX_FILES = 200
export const MAX_FILE_BYTES = 100_000
export const MAX_TOTAL_BYTES = 2_000_000

/** The index auto memory loads at session start. Its conflicts keep both sides' lines. */
export const INDEX_FILE = 'MEMORY.md'

/** The channel's folder in the repo. Slack ids are letters and digits; anything else is dropped. */
export function channelDir(channel: string): string {
  const cleaned = String(channel ?? '').replace(/[^A-Za-z0-9]/g, '')
  if (!cleaned) throw new Error('no channel to keep memory for')
  return cleaned
}

/**
 * A path inside the channel's folder, as the sandbox names it: `MEMORY.md`, `topic/note.md`.
 * Plain names only, so no path can climb out of the folder (`..`), hide (`.git`), or be absolute.
 */
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/

export function isMemoryPath(path: unknown): path is string {
  if (typeof path !== 'string' || !path.endsWith('.md')) return false
  const parts = path.split('/')
  return parts.length <= 4 && parts.every((p) => SEGMENT.test(p) && !p.includes('..'))
}

/** Git's id for a file's bytes: SHA-1 of "blob <size>\0<bytes>". The sandbox computes the same. */
export async function blobSha(content: string): Promise<string> {
  const bytes = new TextEncoder().encode(content)
  const header = new TextEncoder().encode(`blob ${bytes.length}\0`)
  const all = new Uint8Array(header.length + bytes.length)
  all.set(header)
  all.set(bytes, header.length)
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', all))
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export interface MemoryChange {
  path: string
  /** The new text, or null when the file was deleted. */
  content: string | null
}

export interface PushBody {
  /** What the sandbox pulled: path -> blob sha. The merge compares against it. */
  base: Record<string, string>
  changes: MemoryChange[]
}

export type CheckedPush = { ok: true; push: PushBody } | { ok: false; error: string }

/** Checks what the sandbox sent. Paths are relative to the channel's folder; the folder is not theirs to name. */
export function checkPush(body: unknown): CheckedPush {
  const b = body as { base?: unknown; changes?: unknown } | null
  if (!b || typeof b !== 'object') return { ok: false, error: 'missing body' }
  if (!Array.isArray(b.changes)) return { ok: false, error: 'changes must be a list' }
  if (b.changes.length > MAX_FILES) return { ok: false, error: `over ${MAX_FILES} changes` }

  const base: Record<string, string> = {}
  if (b.base && typeof b.base === 'object') {
    for (const [path, sha] of Object.entries(b.base as Record<string, unknown>)) {
      if (isMemoryPath(path) && typeof sha === 'string' && /^[0-9a-f]{40}$/.test(sha)) base[path] = sha
    }
  }

  const changes: MemoryChange[] = []
  const seen = new Set<string>()
  let total = 0
  for (const c of b.changes as Array<{ path?: unknown; content?: unknown }>) {
    if (!isMemoryPath(c?.path)) return { ok: false, error: `not a memory path: ${String(c?.path).slice(0, 120)}` }
    if (seen.has(c.path)) return { ok: false, error: `${c.path} is listed twice` }
    seen.add(c.path)
    if (c.content === null) {
      changes.push({ path: c.path, content: null })
      continue
    }
    if (typeof c.content !== 'string') return { ok: false, error: `${c.path}: content must be text or null` }
    const size = new TextEncoder().encode(c.content).length
    if (size > MAX_FILE_BYTES) return { ok: false, error: `${c.path} is over ${MAX_FILE_BYTES} bytes` }
    total += size
    if (total > MAX_TOTAL_BYTES) return { ok: false, error: `the changes are over ${MAX_TOTAL_BYTES} bytes` }
    changes.push({ path: c.path, content: c.content })
  }
  return { ok: true, push: { base, changes } }
}

export type MergeStep =
  | { kind: 'write'; path: string; content: string }
  | { kind: 'delete'; path: string }
  /** Both sides changed the index: keep both sides' lines (needs the remote text). */
  | { kind: 'union'; path: string; content: string }

/**
 * Turns a sandbox's changes into what to commit, given the folder as it is now (`remote`, path ->
 * sha). Two threads in one channel can run at once, so the remote may have moved since this sandbox
 * pulled. The rules, per file:
 *
 *   - Unchanged remotely since the pull (remote sha = base sha): the sandbox's version wins.
 *   - Already what the sandbox has: nothing to do.
 *   - Changed on both sides: the index keeps both sides' lines; a note keeps the remote version and
 *     the sandbox's version is saved beside it as `<name>.conflict-<turnId>.md`, so neither is lost
 *     and neither is glued into the other.
 *   - A delete only lands if nobody changed the file since the pull.
 */
export async function planMerge(
  remote: Record<string, string>,
  push: PushBody,
  turnId: string,
): Promise<MergeStep[]> {
  const steps: MergeStep[] = []
  for (const change of push.changes) {
    const now = remote[change.path]
    const then = push.base[change.path]
    if (change.content === null) {
      if (now !== undefined && now === then) steps.push({ kind: 'delete', path: change.path })
      continue
    }
    if (now === (await blobSha(change.content))) continue
    if (now === then) {
      steps.push({ kind: 'write', path: change.path, content: change.content })
    } else if (change.path.split('/').pop() === INDEX_FILE) {
      steps.push({ kind: 'union', path: change.path, content: change.content })
    } else {
      steps.push({ kind: 'write', path: conflictPath(change.path, turnId), content: change.content })
    }
  }
  return steps
}

/** Where a losing note goes: beside the original, named for the turn that wrote it. */
export function conflictPath(path: string, turnId: string) {
  const id = String(turnId).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || 'unknown'
  return `${path.slice(0, -'.md'.length)}.conflict-${id}.md`
}

/** The remote's lines, then each of the sandbox's lines the remote does not already have. */
export function unionLines(remote: string, local: string): string {
  if (!remote) return local
  if (!local) return remote
  const have = new Set(remote.split('\n').filter((l) => l.trim()))
  const extra = local.split('\n').filter((l) => l.trim() && !have.has(l))
  if (!extra.length) return remote
  return `${remote.endsWith('\n') ? remote : `${remote}\n`}${extra.join('\n')}\n`
}

/** The commit message, so `git log` says which thread taught the bot what. */
export function commitMessage(channel: string, threadTs: string, steps: MergeStep[]) {
  const files = [...new Set(steps.map((s) => s.path))]
  const head = `memory: ${channel} thread ${threadTs}`
  return `${head}\n\n${files.map((f) => `- ${f}`).join('\n')}\n`
}

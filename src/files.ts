import { readClaims, signClaims } from './callback-token.ts'

/**
 * The rules for files, both ways. The I/O is in src/index.ts (the doors) and box/files.mjs and
 * box/tools.mjs (the sandbox side).
 *
 * IN: files people drop in the thread reach Claude as files on disk. The Worker never holds the
 * bytes and the sandbox never holds the bot token. When a turn starts, the Worker writes a
 * MANIFEST into the sandbox: for each file the turn's own messages carried, a GRANT, a signed
 * ticket for that one file in that one thread. Before Claude starts, the runner swaps each grant
 * for the bytes at GET /sandbox/file, which checks the grant, asks Slack whether the file really is
 * in this channel, and streams it through with the bot token.
 *
 * Why not one download door that takes a file id? `files:read` lets the bot token read every file
 * in every channel the bot is in. A door taking any id would let a prompt-injected Claude pull files
 * from other channels. A grant can only be minted here, from files Slack sent us in THIS thread's
 * events, and the sandbox holds no key to forge one for any other file.
 *
 * OUT: Claude posts files and canvases into its own thread with box/tools.mjs, which calls
 * POST /sandbox/upload and POST /sandbox/canvas with the turn's `tools` token. The channel and
 * thread come from the token, never the request, so the doors can only ever post into this thread.
 */

/** Per file, both ways. A choice, not a platform limit: Slack takes 1 GB. */
export const MAX_FILE_BYTES = 100 * 1024 * 1024
/** Files downloaded per turn. The rest are listed for Claude with the reason. */
export const MAX_FILES_PER_TURN = 10
/** An upload the Worker holds in memory while it passes it to Slack. Under the Worker's 128 MB. */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024
/** Slack's limit for a canvas is far higher; this keeps a runaway canvas out of the thread. */
export const MAX_CANVAS_CHARS = 200_000
/** Slack's limit for a message, which is what an upload comment becomes. */
export const MAX_COMMENT_CHARS = 4000
/** Where the runner puts downloaded files, under ~/work. */
export const FILES_DIR = 'slack-files'

/** What the thread stores about a file from a Slack event. The rest is read from Slack at download. */
export interface SlackFileRef {
  id: string
  name: string
  size?: number
  mimetype?: string
  /** Hosted outside Slack (a Drive or Dropbox link): there are no bytes to fetch. */
  external?: boolean
}

/** Pulls the file refs out of an event's `files`. Anything without an id is dropped. */
export function filesFromEvent(files: unknown): SlackFileRef[] {
  if (!Array.isArray(files)) return []
  const refs: SlackFileRef[] = []
  for (const f of files as Array<Record<string, unknown>>) {
    if (!f || typeof f.id !== 'string' || !/^F\w+$/.test(f.id)) continue
    refs.push({
      id: f.id,
      name: typeof f.name === 'string' ? f.name : typeof f.title === 'string' ? f.title : 'file',
      ...(typeof f.size === 'number' ? { size: f.size } : {}),
      ...(typeof f.mimetype === 'string' ? { mimetype: f.mimetype } : {}),
      ...(hostedOutsideSlack(f) ? { external: true } : {}),
    })
  }
  // A message carries at most a handful; a cap keeps a strange event from bloating the thread's state.
  return refs.slice(0, 50)
}

/**
 * Slack's file objects say a file is hosted elsewhere in more than one way. A `file_share` event
 * can also carry a stub with no URL (`file_access: check_file_info`), which is NOT external: the
 * download door reads the full object from files.info.
 */
export function hostedOutsideSlack(file: Record<string, unknown> | null | undefined) {
  return Boolean(file?.is_external) || file?.mode === 'external'
}

/** A Slack file name is user-controlled. Keep it readable, and keep it out of the filesystem's way. */
export function safeName(name: unknown): string {
  const base = String(name ?? '').split(/[\\/]/).pop() ?? ''
  const clean = base.replace(/[^\w.\- ]/g, '_').replace(/^[.\s]+/, '').trim().slice(0, 100)
  return clean || 'file'
}

export interface FileGrantClaims {
  channel: string
  threadTs: string
  fileId: string
  exp: number
}

export type ManifestEntry =
  | { id: string; name: string; path: string; size?: number; mimetype?: string; from: string; grant: string }
  | { name: string; from: string; error: string }

/**
 * The manifest for one turn: every file its messages carried, oldest first, deduped. Each file
 * gets a grant, or an error that reaches Claude as is, so it can tell the person rather than
 * silently skip the file. `path` is relative to ~/work and starts with the file id, so two files
 * with the same name never overwrite each other.
 */
export async function manifestFor(
  secret: string,
  opts: { channel: string; threadTs: string; exp: number; messages: Array<{ user: string; files?: SlackFileRef[] }> },
): Promise<ManifestEntry[]> {
  const seen = new Set<string>()
  const entries: ManifestEntry[] = []
  let granted = 0
  for (const m of opts.messages) {
    for (const f of m.files ?? []) {
      if (seen.has(f.id)) continue
      seen.add(f.id)
      const name = safeName(f.name)
      if (f.external) {
        entries.push({ name, from: m.user, error: 'hosted outside Slack, so it was not downloaded' })
      } else if (typeof f.size === 'number' && f.size > MAX_FILE_BYTES) {
        entries.push({ name, from: m.user, error: `too large (${human(f.size)}; the limit is ${human(MAX_FILE_BYTES)})` })
      } else if (granted >= MAX_FILES_PER_TURN) {
        entries.push({ name, from: m.user, error: `over the ${MAX_FILES_PER_TURN}-file limit for one turn, so it was not downloaded; ask for it to be sent again` })
      } else {
        granted++
        const grant = await signClaims(secret, 'file', { channel: opts.channel, threadTs: opts.threadTs, fileId: f.id, exp: opts.exp } satisfies FileGrantClaims)
        entries.push({
          id: f.id,
          name,
          path: `${FILES_DIR}/${f.id}-${name}`,
          ...(f.size !== undefined ? { size: f.size } : {}),
          ...(f.mimetype ? { mimetype: f.mimetype } : {}),
          from: m.user,
          grant,
        })
      }
    }
  }
  return entries
}

/** The claims of a file grant, or the reason it is refused. */
export async function verifyFileGrant(secret: string, grant: string | null | undefined, now = Date.now()) {
  const read = await readClaims<FileGrantClaims>(secret, 'file', grant, now)
  if (!read.ok) return read
  const { channel, threadTs, fileId } = read.claims
  if (typeof channel !== 'string' || typeof threadTs !== 'string' || typeof fileId !== 'string') {
    return { ok: false as const, reason: 'malformed grant' }
  }
  return read
}

/**
 * Is this file (a files.info object) shared into `channel`? The grant says which channel the file
 * came from; this checks Slack agrees, so a grant can never fetch a file that has left the channel.
 * Slack answers in two shapes and both are needed: `shares` is capped per file, and the flat lists
 * cover a file shared into many channels.
 */
export function fileSharedIn(file: Record<string, unknown> | null | undefined, channel: string): boolean {
  if (!file || !channel) return false
  const shares = (file.shares ?? {}) as Record<string, Record<string, unknown> | undefined>
  for (const bucket of [shares.public, shares.private]) {
    if (bucket && Object.prototype.hasOwnProperty.call(bucket, channel)) return true
  }
  return [file.channels, file.groups, file.ims].some((list) => Array.isArray(list) && list.includes(channel))
}

/**
 * The headers the download door sends with a file's bytes. `content-length` only when Slack's
 * response was not compressed: fetch() decodes a gzip body but keeps the compressed length, and a
 * body announced at that length is cut short. `x-file-size` is what files.info says, so the runner
 * can refuse a short file rather than hand Claude half of it.
 */
export function downloadHeaders(upstream: Headers, file: { size?: unknown }): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': upstream.get('content-type') || 'application/octet-stream' }
  const encoding = (upstream.get('content-encoding') ?? '').trim().toLowerCase()
  const length = upstream.get('content-length')
  if (length && (!encoding || encoding === 'identity')) headers['content-length'] = length
  if (Number.isSafeInteger(file.size) && (file.size as number) >= 0) headers['x-file-size'] = String(file.size)
  return headers
}

/**
 * Slack answers a download it will not serve (no `files:read` on the token) with its sign-in page
 * and a 200. An HTML body for a file that is not HTML is that page, not the file.
 */
export function looksLikeSignInPage(upstream: Headers, file: { mimetype?: unknown }) {
  const type = (upstream.get('content-type') ?? '').toLowerCase()
  return type.startsWith('text/html') && file.mimetype !== 'text/html'
}

export interface UploadRequest {
  filename: string
  title?: string
  comment?: string
}

/**
 * Checks an upload before its body is read: the declared size and the text fields, which arrive as
 * percent-encoded headers. Returns the cleaned fields, or the refusal.
 */
export function checkUpload(headers: {
  contentLength: string | null
  filename: string | null
  title: string | null
  comment: string | null
}): { ok: true; upload: UploadRequest; size: number } | { ok: false; status: number; error: string } {
  const n = Number(headers.contentLength)
  if (headers.contentLength === null || !Number.isInteger(n) || n < 0) return { ok: false, status: 411, error: 'content-length required' }
  if (n === 0) return { ok: false, status: 400, error: 'empty file: Slack refuses one' }
  if (n > MAX_UPLOAD_BYTES) return { ok: false, status: 413, error: `file over ${human(MAX_UPLOAD_BYTES)}` }
  const filename = decode(headers.filename)
  if (!filename) return { ok: false, status: 400, error: 'x-filename required' }
  const comment = decode(headers.comment)
  if (comment && comment.length > MAX_COMMENT_CHARS) {
    return { ok: false, status: 400, error: `comment is ${comment.length} characters; the limit is ${MAX_COMMENT_CHARS}` }
  }
  const title = cleanTitle(decode(headers.title))
  return {
    ok: true,
    size: n,
    upload: { filename: safeName(filename), ...(title ? { title } : {}), ...(comment ? { comment } : {}) },
  }
}

/** Checks a canvas request body. Returns the cleaned fields, or the refusal. */
export function checkCanvas(body: unknown): { ok: true; title: string; markdown: string } | { ok: false; error: string } {
  const b = (body ?? {}) as { title?: unknown; markdown?: unknown }
  const title = cleanTitle(typeof b.title === 'string' ? b.title : '')
  if (!title) return { ok: false, error: 'a canvas needs a title' }
  if (typeof b.markdown !== 'string' || !b.markdown.trim()) return { ok: false, error: 'a canvas needs some markdown' }
  if (b.markdown.length > MAX_CANVAS_CHARS) {
    return { ok: false, error: `canvas is ${b.markdown.length} characters; the limit is ${MAX_CANVAS_CHARS}` }
  }
  return { ok: true, title, markdown: b.markdown }
}

/** The line posted under a new canvas, so the thread can open it. */
export function canvasLinkText(title: string, permalink: string | null) {
  const safe = title.replace(/[<>|]/g, '')
  return permalink ? `:page_facing_up: Canvas: <${permalink}|${safe}>` : `:page_facing_up: I made a canvas, "${safe}", but Slack gave me no link to it.`
}

/** A title is free text; only control characters go, and it is kept to one line. */
function cleanTitle(title: string | null) {
  return (title ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 200)
}

function decode(value: string | null) {
  if (value === null) return ''
  try {
    return decodeURIComponent(value)
  } catch {
    return ''
  }
}

function human(n: number) {
  return n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`
}

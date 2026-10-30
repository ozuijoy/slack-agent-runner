// The sandbox side of the bot's memory (the rules are in src/memory.ts).
//
// Claude Code's own auto memory writes notes into one folder. Before each turn the runner pulls the
// channel's notes from the Worker's /sandbox/memory door into that folder and points auto memory at
// it; after the turn it sends back what changed. The Worker keeps them in a git repo, one folder per
// channel, and picks the folder from the runner's token. Nothing here holds a GitHub token.
//
// The folder lives as long as the thread's sandbox, so a push can fail (the Worker mid-deploy) and
// the next turn must not throw those notes away. So the runner keeps a BASE file: what each note was
// at the last sync. A note that differs from its base is a local edit not yet pushed, and a pull
// leaves it alone, along with its base entry; the next push sends it against that base.

import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Matches isMemoryPath in src/memory.ts: Markdown, plain names, at most 4 deep. */
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/
export function isMemoryPath(path) {
  if (typeof path !== 'string' || !path.endsWith('.md')) return false
  const parts = path.split('/')
  return parts.length <= 4 && parts.every((p) => SEGMENT.test(p) && !p.includes('..'))
}

/** Git's blob id, the same one GitHub reports, so both sides compare notes by it. */
export function blobSha(content) {
  const bytes = Buffer.from(content, 'utf8')
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
}

/** Every note in the folder: path -> { sha, content }. Links are skipped: they are not notes. */
export function readLocal(dir) {
  const out = {}
  const walk = (rel) => {
    let names = []
    try {
      names = readdirSync(join(dir, rel))
    } catch {
      return
    }
    for (const name of names) {
      const path = rel ? `${rel}/${name}` : name
      const st = lstatSync(join(dir, path))
      if (st.isSymbolicLink()) continue
      if (st.isDirectory()) walk(path)
      else if (st.isFile() && isMemoryPath(path)) {
        const content = readFileSync(join(dir, path), 'utf8')
        out[path] = { sha: blobSha(content), content }
      }
    }
  }
  walk('')
  return out
}

/**
 * What a pull does to the folder. `remote` is the channel's notes (path -> sha), `base` the last
 * sync, `local` the folder now (path -> sha). Unpushed local edits stay; everything else becomes
 * the remote. The new base is the remote, except for a path that still holds an unpushed edit or
 * delete: that one keeps the base the edit was made from. Otherwise the next push would claim the
 * edit was made on top of the remote's current version, and the Worker would let it overwrite
 * another thread's change instead of saving it beside as a conflict.
 */
export function planPull({ remote, base, local }) {
  const pending = (path) => local[path] !== base[path]
  const write = Object.keys(remote).filter((p) => !pending(p) && local[p] !== remote[p])
  const remove = Object.keys(local).filter((p) => !(p in remote) && !pending(p))
  const next = { ...remote }
  for (const p of new Set([...Object.keys(local), ...Object.keys(base)])) {
    // Already what the remote has (a push that landed but could not save its base): in sync.
    if (!pending(p) || local[p] === remote[p]) continue
    if (p in base) next[p] = base[p]
    else delete next[p]
  }
  return { write, remove, base: next }
}

/** What changed since the base: new or edited notes with their text, deleted ones as null. */
export function changesSince(base, local) {
  const changes = []
  for (const [path, { sha, content }] of Object.entries(local)) if (base[path] !== sha) changes.push({ path, content })
  for (const path of Object.keys(base)) if (!(path in local)) changes.push({ path, content: null })
  return changes
}

/** The base file, or an empty one. It also names the turn that wrote it. */
export function loadBase(file) {
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'))
    return { turnId: String(data.turnId ?? ''), base: data.base && typeof data.base === 'object' ? data.base : {} }
  } catch {
    return { turnId: '', base: {} }
  }
}

/**
 * Writes the base. After a push, only if this turn still owns it: the push runs after the lock is
 * freed, so the next turn may have pulled (and written its own base) in the meantime.
 */
export function saveBase(file, base, turnId, { onlyIfOwner = false } = {}) {
  if (onlyIfOwner && loadBase(file).turnId !== turnId) return false
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(`${file}.part`, JSON.stringify({ turnId, base }))
  renameSync(`${file}.part`, file)
  return true
}

/**
 * Pulls the channel's notes into `dir`. Returns `{ ok: true, base }`, or `{ ok: false, error }` and
 * leaves the folder as it was. Never throws: a turn without memory still answers.
 */
export async function pull({ url, token, turnId, dir, baseFile, timeoutMs = 30_000 }) {
  try {
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${token}`, 'x-turn-id': turnId },
      signal: AbortSignal.timeout(timeoutMs),
    })
    const answer = await res.json().catch(() => ({}))
    if (!res.ok || !Array.isArray(answer?.files)) return { ok: false, error: answer?.error || `the Worker answered ${res.status}` }

    const files = answer.files.filter((f) => isMemoryPath(f?.path) && typeof f.content === 'string')
    const remote = Object.fromEntries(files.map((f) => [f.path, blobSha(f.content)]))
    const text = Object.fromEntries(files.map((f) => [f.path, f.content]))
    const localNotes = readLocal(dir)
    const local = Object.fromEntries(Object.entries(localNotes).map(([p, n]) => [p, n.sha]))
    const plan = planPull({ remote, base: loadBase(baseFile).base, local })

    mkdirSync(dir, { recursive: true })
    for (const path of plan.write) {
      mkdirSync(dirname(join(dir, path)), { recursive: true })
      writeFileSync(join(dir, path), text[path])
    }
    for (const path of plan.remove) rmSync(join(dir, path), { force: true })
    saveBase(baseFile, plan.base, turnId)
    return { ok: true, base: plan.base, count: files.length }
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) }
  }
}

/** Sends the changes. True when the Worker stored them (or there were none). A few quick tries. */
export async function push({ url, token, turnId, base, changes, baseFile, local, attempts = 3, timeoutMs = 60_000 }) {
  if (!changes.length) return true
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-turn-id': turnId },
        body: JSON.stringify({ turnId, base, changes }),
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (res.ok) {
        // What we sent is what the Worker has now (or merged with), so it is the new base.
        saveBase(baseFile, Object.fromEntries(Object.entries(local).map(([p, n]) => [p, n.sha])), turnId, { onlyIfOwner: true })
        return true
      }
      console.error(`memory push refused: ${res.status} ${await res.text()}`)
      if (res.status < 500) return false
    } catch (err) {
      console.error(`memory push attempt ${attempt} failed:`, err?.message ?? err)
    }
    if (attempt < attempts) await new Promise((r) => setTimeout(r, 2_000 * attempt))
  }
  return false
}

/**
 * Turns Claude Code's auto memory on and points it at `dir`, or off when the pull failed (a turn
 * must not write notes it cannot load next time). User settings, merged, so nothing else is lost.
 */
export function writeMemorySettings(settingsFile, dir) {
  let settings = {}
  try {
    if (existsSync(settingsFile)) settings = JSON.parse(readFileSync(settingsFile, 'utf8')) ?? {}
  } catch {
    settings = {}
  }
  if (dir) {
    settings.autoMemoryEnabled = true
    settings.autoMemoryDirectory = dir
  } else {
    settings.autoMemoryEnabled = false
    delete settings.autoMemoryDirectory
  }
  mkdirSync(dirname(settingsFile), { recursive: true })
  writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`)
}

/** The line added to the prompt when memory could not be loaded. Empty when it was. */
export function memoryNote(result) {
  return result.ok ? '' : `(Your memory for this channel could not be loaded this turn: ${result.error}. Nothing you learn now will be saved.)`
}

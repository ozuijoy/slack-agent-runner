// Files from Slack: the runner downloads the turn's files before Claude starts.
//
// The Worker wrote a manifest (src/files.ts manifestFor): per file, a path under ~/work and a GRANT,
// a signed ticket for that one file. Each grant is swapped for the bytes at the Worker's
// /sandbox/file door, which holds the Slack token. The sandbox never does. The runner then deletes
// the manifest and tells Claude where the files are, at the end of its prompt.

import { createWriteStream, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/** One file may take this long; a stuck download must not eat the turn. */
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000

/** Claude keeps at least this much of the turn (or half of what is left, if less) after downloads. */
const CLAUDE_RESERVE_MS = 5 * 60_000

/** A file is not started with less time than this left: it would only time out. */
const MIN_DOWNLOAD_MS = 5_000

/** The status line in Slack while files come in. */
export const DOWNLOAD_ACTIVITY = 'Downloading files…'

/**
 * When the downloads must be done, for a turn ending at `turnDeadline`. Ten slow files at five
 * minutes each would otherwise run past the turn's own deadline and into the thread's lost-turn alarm.
 */
export function downloadDeadline(turnDeadline, now) {
  const left = Math.max(0, turnDeadline - now)
  return turnDeadline - Math.min(CLAUDE_RESERVE_MS, Math.ceil(left / 2))
}

/**
 * Downloads every granted file into `workDir`, one after another, all of them by `deadline` (epoch
 * ms). Never throws: a file that fails, or is skipped for lack of time or a Stop (`signal`), comes
 * back with its `error`, so Claude can say so. Entries the Worker refused up front keep theirs.
 */
export async function downloadAll({ manifest, url, workDir, fetchImpl = fetch, deadline = Infinity, signal, now = Date.now }) {
  const results = []
  for (const entry of Array.isArray(manifest) ? manifest : []) {
    if (!entry?.grant) {
      results.push({ name: String(entry?.name ?? 'file'), from: entry?.from, error: String(entry?.error ?? 'no grant') })
      continue
    }
    const left = deadline - now()
    if (signal?.aborted) {
      results.push({ name: entry.name, from: entry.from, error: 'was not downloaded: the turn was stopped' })
      continue
    }
    if (left < MIN_DOWNLOAD_MS) {
      results.push({ name: entry.name, from: entry.from, error: 'was not downloaded: the turn ran out of time for downloads' })
      continue
    }
    try {
      const timeout = AbortSignal.timeout(Math.floor(Math.min(DOWNLOAD_TIMEOUT_MS, left)))
      const size = await download(entry, { url, workDir, fetchImpl, signal: signal ? AbortSignal.any([timeout, signal]) : timeout })
      results.push({ name: entry.name, from: entry.from, path: entry.path, size, mimetype: entry.mimetype })
    } catch (err) {
      results.push({ name: entry.name, from: entry.from, error: `could not be downloaded: ${String(err?.message ?? err).slice(0, 300)}` })
    }
  }
  return results
}

async function download(entry, { url, workDir, fetchImpl, signal }) {
  // The path comes from the Worker, but a path must still never leave the work folder.
  const target = resolve(workDir, String(entry.path))
  if (!target.startsWith(resolve(workDir) + sep)) throw new Error('bad path')
  mkdirSync(dirname(target), { recursive: true })

  const res = await fetchImpl(url, {
    headers: { authorization: `Bearer ${entry.grant}` },
    signal,
  })
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '')
    throw new Error(`${res.status} ${errorOf(detail)}`.trim())
  }
  // Written under a temporary name, so Claude never finds half a file under the real one.
  const part = `${target}.part`
  try {
    await pipeline(Readable.fromWeb(res.body), createWriteStream(part))
    const got = statSync(part).size
    const expected = Number(res.headers.get('x-file-size'))
    if (res.headers.get('x-file-size') !== null && Number.isInteger(expected) && got !== expected) {
      throw new Error(`got ${got} of ${expected} bytes`)
    }
    renameSync(part, target)
    return got
  } finally {
    rmSync(part, { force: true })
  }
}

function errorOf(text) {
  try {
    return String(JSON.parse(text)?.error ?? '')
  } catch {
    return text.slice(0, 200)
  }
}

/** What Claude reads about the files, after its prompt. Empty when there were none. */
export function filesNote(results) {
  if (!results.length) return ''
  const lines = results.map((r) => {
    const who = r.from ? ` from <@${r.from}>` : ''
    if (r.error) return `- ${r.name}${who}: ${r.error}`
    const meta = [humanSize(r.size), r.mimetype].filter(Boolean).join(', ')
    return `- ${r.path} (${meta})${who}`
  })
  return ['', 'Files sent with these messages (paths are relative to ~/work, your working folder):', ...lines].join('\n')
}

function humanSize(n) {
  if (typeof n !== 'number') return ''
  return n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`
}

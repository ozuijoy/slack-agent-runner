/**
 * The live turn, for the web UI's transcript page (/ui/follow). The R2 backups (src/transcripts.ts)
 * hold every finished turn; this is what the page shows of the turn that is running NOW.
 *
 * The sandbox reads Claude's stream (box/progress.mjs `liveEntries`) and sends new entries with
 * each progress report. The thread's Durable Object keeps them under their own storage key, next to
 * the thread, and the page reads them back.
 *
 * 1. ONLY THE RUNNING TURN WRITES. Entries are kept only when the token's turn is the one running in
 *    the token's thread, so a late or stale sandbox cannot add to another turn's log.
 * 2. A NEW TURN STARTS A NEW LOG. The previous turn's log stays until then, so the page still shows
 *    it while its R2 backup is on its way.
 * 3. CAPPED. The sandbox is untrusted: each entry is a known kind with capped text, a report carries
 *    at most MAX_ENTRIES_PER_REPORT, and the log keeps the newest MAX_LIVE_ENTRIES within
 *    MAX_LIVE_CHARS. The page renders every field as text, never as HTML.
 */

export const LIVE_KINDS = ['prompt', 'text', 'thinking', 'tool', 'result', 'error'] as const
export type LiveKind = (typeof LIVE_KINDS)[number]

export interface LiveEntry {
  kind: LiveKind
  /** A tool's name, for `tool`. */
  name?: string
  text: string
  /** When the Worker took it in (ms). */
  at: number
}

export interface LiveLog {
  turnId: string
  startedAt: number
  entries: LiveEntry[]
  /** How many entries were dropped off the front (rule 3), so the page can say so. */
  dropped: number
}

export const MAX_LIVE_TEXT = 4000
export const MAX_ENTRIES_PER_REPORT = 100
export const MAX_LIVE_ENTRIES = 600
/**
 * The whole log's text, in characters. It is one Durable Object value, which Cloudflare caps at
 * 2 MB, so the log stays well under that whatever the entries hold.
 */
export const MAX_LIVE_CHARS = 400_000

/** What the sandbox sent, kept to known kinds and capped (rule 3). Anything else is dropped. */
export function checkLiveEntries(raw: unknown, now: number): LiveEntry[] {
  if (!Array.isArray(raw)) return []
  const out: LiveEntry[] = []
  for (const item of raw.slice(0, MAX_ENTRIES_PER_REPORT)) {
    const e = item as { kind?: unknown; name?: unknown; text?: unknown } | null
    if (!e || !LIVE_KINDS.includes(e.kind as LiveKind)) continue
    const text = typeof e.text === 'string' ? clip(e.text, MAX_LIVE_TEXT) : ''
    const entry: LiveEntry = { kind: e.kind as LiveKind, text, at: now }
    if (typeof e.name === 'string' && e.name) entry.name = clip(e.name, 100)
    out.push(entry)
  }
  return out
}

/**
 * Adds a report's entries to the log, starting a fresh log for a new turn (rule 2). The caller has
 * already checked that `turnId` is the turn running in this thread (rule 1).
 */
export function appendLive(log: LiveLog | undefined, turnId: string, startedAt: number, entries: LiveEntry[]): LiveLog {
  const next: LiveLog = log && log.turnId === turnId ? { ...log, entries: [...log.entries] } : { turnId, startedAt, entries: [], dropped: 0 }
  next.entries.push(...entries)
  let over = Math.max(0, next.entries.length - MAX_LIVE_ENTRIES)
  let chars = next.entries.reduce((n, e, i) => (i < over ? n : n + e.text.length + (e.name?.length ?? 0)), 0)
  while (chars > MAX_LIVE_CHARS && over < next.entries.length - 1) {
    chars -= next.entries[over].text.length + (next.entries[over].name?.length ?? 0)
    over++
  }
  if (over > 0) {
    next.entries.splice(0, over)
    next.dropped += over
  }
  return next
}

export interface LiveView {
  /** The turn running now, if any. */
  running: { turnId: string; startedAt: number; model?: string; stopping: boolean } | null
  /** The newest turn's log: the running one's, or the last finished one's until a new turn starts. */
  log: LiveLog | null
}

function clip(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

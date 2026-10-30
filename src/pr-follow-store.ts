import { dbAll, dbChanges, dbFirst } from './db.ts'
import type { Env } from './env.ts'
import { MAX_PENDING_LINES, WAKE_DELAY_MS, type PrRef, type WakeCounter } from './pr-follow.ts'

/**
 * Followed PRs in D1 (the rules: src/pr-follow.ts). Each write is ONE conditional statement, so two
 * webhook deliveries, or a delivery and the sweep, can run at once without losing a line or firing a
 * batch twice.
 */
type DbEnv = Pick<Env, 'DB'>

export interface FollowRow extends WakeCounter {
  repo: string
  number: number
  channel: string
  thread_ts: string
  origin: string
  url: string
  title: string | null
  followed_by: string | null
  status: string
  pending: string | null
  pending_since: number | null
}

const COLUMNS =
  'repo, number, channel, thread_ts, origin, url, title, followed_by, status, pending, pending_since, wake_day, wake_count, stop_noted_day'

export interface NewFollow extends PrRef {
  channel: string
  threadTs: string
  origin: string
  url: string
  title: string | null
  followedBy: string | null
}

/**
 * Follows a PR from a thread (rule 1). Following it again, from any thread, moves it there and
 * makes it active; the day's wake count stays, so re-following cannot reset the cap.
 */
export async function followPr(env: DbEnv, f: NewFollow, now = Date.now()) {
  await dbChanges(
    env,
    `INSERT INTO pr_follows (repo, number, channel, thread_ts, origin, url, title, followed_by, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
     ON CONFLICT (repo, number) DO UPDATE SET channel = excluded.channel, thread_ts = excluded.thread_ts,
       origin = excluded.origin, url = excluded.url, title = excluded.title, followed_by = excluded.followed_by,
       status = 'active', updated_at = excluded.updated_at`,
    f.repo,
    f.number,
    f.channel,
    f.threadTs,
    f.origin,
    f.url,
    f.title,
    f.followedBy,
    now,
    now,
  )
}

/** Stops following, only from the thread that follows it. False when that thread does not. */
export async function unfollowPr(env: DbEnv, ref: PrRef, thread: { channel: string; threadTs: string }, now = Date.now()) {
  const changed = await dbChanges(
    env,
    `UPDATE pr_follows SET status = 'ended', pending = NULL, pending_since = NULL, updated_at = ?
     WHERE repo = ? AND number = ? AND channel = ? AND thread_ts = ? AND status = 'active'`,
    now,
    ref.repo,
    ref.number,
    thread.channel,
    thread.threadTs,
  )
  return changed > 0
}

export async function getFollow(env: DbEnv, ref: PrRef): Promise<FollowRow | null> {
  return dbFirst<FollowRow>(env, `SELECT ${COLUMNS} FROM pr_follows WHERE repo = ? AND number = ?`, ref.repo, ref.number)
}

/** The numbers of a repo's followed PRs, to match a commit status against. */
export async function activeNumbers(env: DbEnv, repo: string): Promise<number[]> {
  const rows = await dbAll<{ number: number }>(env, "SELECT number FROM pr_follows WHERE repo = ? AND status = 'active'", repo)
  return rows.map((r) => r.number)
}

/**
 * Adds one event line to a followed PR's batch (rule 5), in one statement: only while it is
 * active, not if the same line already waits, and not past MAX_PENDING_LINES. The batch's clock
 * starts at its first line. False when nothing was added (not followed, a repeat, or full).
 */
export async function addEvent(env: DbEnv, ref: PrRef, line: string, now = Date.now()) {
  const changed = await dbChanges(
    env,
    `UPDATE pr_follows SET pending = json_insert(COALESCE(pending, '[]'), '$[#]', ?),
       pending_since = COALESCE(pending_since, ?), updated_at = ?
     WHERE repo = ? AND number = ? AND status = 'active'
       AND json_array_length(COALESCE(pending, '[]')) < ?
       AND NOT EXISTS (SELECT 1 FROM json_each(COALESCE(pr_follows.pending, '[]')) WHERE value = ?)`,
    line,
    now,
    now,
    ref.repo,
    ref.number,
    MAX_PENDING_LINES,
    line,
  )
  return changed > 0
}

/** Ends a follow on merge or close (rule 4). The row as it was when this call ended it, or null. */
export async function endFollow(env: DbEnv, ref: PrRef, now = Date.now()): Promise<FollowRow | null> {
  const row = await getFollow(env, ref)
  if (!row || row.status !== 'active') return null
  const changed = await dbChanges(
    env,
    `UPDATE pr_follows SET status = 'ended', pending = NULL, pending_since = NULL, updated_at = ?
     WHERE repo = ? AND number = ? AND status = 'active' AND channel = ? AND thread_ts = ?`,
    now,
    ref.repo,
    ref.number,
    row.channel,
    row.thread_ts,
  )
  return changed ? row : null
}

/** Batches that have waited long enough (rule 5). */
export async function dueWakes(env: DbEnv, now: number) {
  return dbAll<FollowRow>(
    env,
    `SELECT ${COLUMNS} FROM pr_follows WHERE status = 'active' AND pending_since IS NOT NULL AND pending_since <= ? ORDER BY pending_since`,
    now - WAKE_DELAY_MS,
  )
}

/**
 * Takes a due batch and stores the new counter, in one statement. It lands only if the batch is
 * exactly the one read (no line arrived since, no other sweep took it, the PR was not closed), so a
 * batch fires once; a line that arrived meanwhile is picked up by the next sweep.
 */
export async function claimBatch(env: DbEnv, row: FollowRow, counter: WakeCounter, now: number) {
  const changed = await dbChanges(
    env,
    `UPDATE pr_follows SET pending = NULL, pending_since = NULL, wake_day = ?, wake_count = ?, stop_noted_day = ?, updated_at = ?
     WHERE repo = ? AND number = ? AND status = 'active' AND pending_since = ? AND pending = ?`,
    counter.wake_day,
    counter.wake_count,
    counter.stop_noted_day,
    now,
    row.repo,
    row.number,
    row.pending_since,
    row.pending,
  )
  return changed > 0
}

/**
 * Undoes a claim whose wake never reached the thread (Slack or the thread refused): the day's
 * counter goes back to what it was, only if no later claim changed it, and the lines join the
 * batch again, so the next sweep tries once more instead of the events vanishing. Their clock
 * restarts, so a Slack that keeps failing is retried every WAKE_DELAY_MS, not every minute.
 */
export async function releaseBatch(env: DbEnv, row: FollowRow, claimed: WakeCounter, lines: string[], now = Date.now()) {
  await dbChanges(
    env,
    `UPDATE pr_follows SET wake_day = ?, wake_count = ?, stop_noted_day = ?, updated_at = ?
     WHERE repo = ? AND number = ? AND status = 'active' AND wake_day IS ? AND wake_count = ? AND stop_noted_day IS ?`,
    row.wake_day,
    row.wake_count,
    row.stop_noted_day,
    now,
    row.repo,
    row.number,
    claimed.wake_day,
    claimed.wake_count,
    claimed.stop_noted_day,
  )
  for (const line of lines) await addEvent(env, row, line, now)
}

/** The batch's lines. A row someone edited by hand into something else is an empty batch. */
export function pendingLines(row: Pick<FollowRow, 'pending'>): string[] {
  try {
    const value = JSON.parse(row.pending ?? '[]')
    return Array.isArray(value) ? value.filter((l): l is string => typeof l === 'string') : []
  } catch {
    return []
  }
}

import type { Env } from './env.ts'

/**
 * The D1 database. Tables are made by the SQL files in migrations/, which `npm run setup` applies.
 * Always bind values with `?`; never build SQL from text a person or a sandbox sent.
 */
export async function dbRun(env: Pick<Env, 'DB'>, sql: string, ...params: unknown[]) {
  await env.DB.prepare(sql).bind(...params).run()
}

export async function dbAll<T>(env: Pick<Env, 'DB'>, sql: string, ...params: unknown[]): Promise<T[]> {
  const { results } = await env.DB.prepare(sql).bind(...params).all<T>()
  return results
}

export async function dbFirst<T>(env: Pick<Env, 'DB'>, sql: string, ...params: unknown[]): Promise<T | null> {
  return env.DB.prepare(sql).bind(...params).first<T>()
}

export interface TranscriptRow {
  key: string
  channel: string
  thread_ts: string
  turn_id: string
  bytes: number
  created_at: number
}

/** Indexes one uploaded transcript, so pages can list a thread's turns without listing R2. */
export async function recordTranscript(env: Pick<Env, 'DB'>, row: TranscriptRow) {
  await dbRun(
    env,
    'INSERT OR REPLACE INTO transcripts (key, channel, thread_ts, turn_id, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    row.key,
    row.channel,
    row.thread_ts,
    row.turn_id,
    row.bytes,
    row.created_at,
  )
}

export interface ThreadSummary {
  channel: string
  thread_ts: string
  /** When its newest backup landed (ms). */
  last_at: number
  turns: number
}

/** The threads with the newest backups, for the UI's front page and the App Home tab. */
export async function recentThreads(env: Pick<Env, 'DB'>, limit = 50): Promise<ThreadSummary[]> {
  return dbAll<ThreadSummary>(
    env,
    `SELECT channel, thread_ts, MAX(created_at) AS last_at, COUNT(*) AS turns FROM transcripts
     GROUP BY channel, thread_ts ORDER BY last_at DESC LIMIT ?`,
    limit,
  )
}

/** One thread's backups, newest first. Each is the whole session up to that turn. */
export async function threadTranscripts(env: Pick<Env, 'DB'>, channel: string, threadTs: string, limit = 200): Promise<TranscriptRow[]> {
  return dbAll<TranscriptRow>(
    env,
    'SELECT key, channel, thread_ts, turn_id, bytes, created_at FROM transcripts WHERE channel = ? AND thread_ts = ? ORDER BY created_at DESC LIMIT ?',
    channel,
    threadTs,
    limit,
  )
}

/** Runs a write and returns how many rows it changed. A claim is "did my insert land?". */
export async function dbChanges(env: Pick<Env, 'DB'>, sql: string, ...params: unknown[]): Promise<number> {
  const result = await env.DB.prepare(sql).bind(...params).run()
  return result.meta?.changes ?? 0
}

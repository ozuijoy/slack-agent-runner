import type { Env } from './env.ts'
import type { ManifestEntry } from './files.ts'

/**
 * ②: the turn queue for a machine of your own (runner/README.md).
 *
 * A sandbox used to be the thread's memory: the checkout, the files, the Claude session all stayed
 * on its disk between turns. With no sandbox, every one of those has to live somewhere that
 * outlives a turn, and D1 is the only such place the app already has. So a job carries everything a
 * turn needs to start (its prompt, its envs, its file grants), and the session comes back to D1 when
 * the turn ends.
 *
 * D1 is also the queue, rather than a Durable Object, because it is strongly consistent and already
 * bound here: `claimJob` is one conditional UPDATE, so two machines asking at the same millisecond
 * still get one job between them and never the same job twice.
 */

/**
 * How long a machine may hold a job before another may take it.
 *
 * Longer than the heartbeat gap (the daemon reports every 30 s) so a slow turn keeps its job, and
 * short enough that a laptop that sleeps mid-turn does not strand a thread for long.
 */
export const LEASE_MS = 180_000

/** D1 stores at most 2 MB in a row. A gzipped session usually fits in one; when it does not, chunk. */
export const CHUNK_BYTES = 1_500_000

/** Larger than this is not a session. Refuse it rather than fill the database with one thread. */
export const MAX_SESSION_BYTES = 20 * 1024 * 1024

/**
 * Everything one turn needs, assembled by src/turn.ts and handed to the queue.
 *
 * This used to be the argument list of `launchTurn`, which wrote the same things into a sandbox. The
 * fields did not change when the sandbox went away; only who reads them.
 */
export interface Launch {
  channel: string
  threadTs: string
  turnId: string
  sessionId: string
  prompt: string
  callbackUrl: string
  /** Where run-turn.mjs posts this turn's answer, with the token below. */
  callbackToken: string
  /** Where run-turn.mjs uploads the transcript after the turn, with the same token. */
  transcriptUrl: string
  /** Where run-turn.mjs reports what Claude is doing, and learns whether to stop. Same token. */
  progressUrl: string
  /** Where run-turn.mjs pulls the channel's memory before the turn and pushes it after. Same token. */
  memoryUrl: string
  /** The Worker's address. Claude's tools (box/tools.mjs) call its /sandbox/* doors. */
  origin: string
  /** Claude's own token for those doors: post a file or a canvas into this thread. */
  toolsToken: string
  /** The files the turn's messages carried, each with its download grant (src/files.ts). */
  files: ManifestEntry[]
  /** The Claude model id for `claude --model`. */
  model: string
  claudeEnvs: Record<string, string>
  /** The channel's secrets (src/channels.ts), for Claude. Only this channel's. */
  channelEnvs: Record<string, string>
  githubToken: string | null
  /** When the turn must end, in ms since the epoch. */
  deadline: number
}

/** One job: a turn, addressed to whichever machine asks first. */
export interface RunnerJob {
  /** The turn id, and the job's id: one turn, one row. */
  jobId: string
  channel: string
  threadTs: string
  turnId: string
  /** Where this thread's Claude session lives in `session_chunks`. */
  sessionKey: string
  prompt: string
  model: string
  deadline: number
  /**
   * Exactly the envs a turn used to get from the sandbox, so run-turn.mjs cannot tell where it runs.
   * The prompt is not on a command line; the daemon writes it to a file the same way.
   */
  env: Record<string, string>
  /** The grants for the files the turn's messages carried (src/files.ts). */
  files: ManifestEntry[]
  /** When the job was made, for a log line that says how long it waited. */
  createdAt: number
}

/** One session per THREAD, never per turn: a thread is one conversation, and `--resume` needs it. */
export function sessionKey(channel: string, threadTs: string): string {
  return `${channel}/${threadTs}`
}

/** How many rows a session of this size takes. Zero bytes is still one chunk, so "exists" is plain. */
export function chunkCount(bytes: number): number {
  return Math.max(1, Math.ceil(bytes / CHUNK_BYTES))
}

/** Queues one turn. Replaces any earlier row for the same turn, so a retried job is not run twice. */
export async function enqueueTurn(env: Env, launch: Launch): Promise<void> {
  const job: RunnerJob = {
    jobId: launch.turnId,
    channel: launch.channel,
    threadTs: launch.threadTs,
    turnId: launch.turnId,
    sessionKey: sessionKey(launch.channel, launch.threadTs),
    prompt: launch.prompt,
    model: launch.model,
    deadline: launch.deadline,
    // The same list, in the same order, the sandbox used to get: a channel secret must never win
    // over a name the runner relies on, and the names are checked in src/channels.ts.
    env: {
      ...launch.channelEnvs,
      ...launch.claudeEnvs,
      ...(launch.githubToken ? { GH_TOKEN: launch.githubToken } : {}),
      HISTFILE: '/dev/null',
      TURN_ID: launch.turnId,
      SESSION_ID: launch.sessionId,
      CALLBACK_URL: launch.callbackUrl,
      CALLBACK_TOKEN: launch.callbackToken,
      TRANSCRIPT_URL: launch.transcriptUrl,
      PROGRESS_URL: launch.progressUrl,
      MEMORY_URL: launch.memoryUrl,
      ...(launch.files.length ? { FILE_URL: new URL('/sandbox/file', launch.origin).toString() } : {}),
      AGENT_API_URL: launch.origin,
      AGENT_TOOLS_TOKEN: launch.toolsToken,
      CLAUDE_MODEL: launch.model,
      TURN_DEADLINE: String(launch.deadline),
      SLACK_CHANNEL: launch.channel,
      SLACK_THREAD_TS: launch.threadTs,
    },
    files: launch.files,
    createdAt: Date.now(),
  }
  await env.DB.prepare(
    `INSERT OR REPLACE INTO runner_jobs
       (id, channel, thread_ts, turn_id, payload, status, lease_until, attempts, runner, note, created_at)
     VALUES (?, ?, ?, ?, ?, 'queued', NULL, 0, NULL, NULL, ?)`,
  )
    .bind(job.jobId, job.channel, job.threadTs, job.turnId, JSON.stringify(job), job.createdAt)
    .run()
}

/**
 * Hands the oldest waiting job to `runner`, or null when there is none.
 *
 * Two statements because the second is the one that decides: the UPDATE only matches a job that is
 * still free, so a machine that lost the race gets `changes === 0` and asks again instead of running
 * a turn another machine is already running.
 */
export async function claimJob(env: Env, runner: string, now = Date.now()): Promise<RunnerJob | null> {
  const row = await env.DB.prepare(
    `SELECT id, payload FROM runner_jobs
      WHERE status = 'queued' OR (status = 'leased' AND lease_until < ?)
      ORDER BY created_at LIMIT 1`,
  )
    .bind(now)
    .first<{ id: string; payload: string }>()
  if (!row) return null

  const took = await env.DB.prepare(
    `UPDATE runner_jobs SET status = 'leased', runner = ?, lease_until = ?, attempts = attempts + 1
      WHERE id = ? AND (status = 'queued' OR (status = 'leased' AND lease_until < ?))`,
  )
    .bind(runner, now + LEASE_MS, row.id, now)
    .run()
  if ((took.meta?.changes ?? 0) !== 1) return null
  return JSON.parse(row.payload) as RunnerJob
}

/** Says "still working". False means the lease was taken away and the turn should stop. */
export async function extendLease(env: Env, jobId: string, runner: string, now = Date.now()): Promise<boolean> {
  const res = await env.DB.prepare(
    `UPDATE runner_jobs SET lease_until = ? WHERE id = ? AND runner = ? AND status = 'leased'`,
  )
    .bind(now + LEASE_MS, jobId, runner)
    .run()
  return (res.meta?.changes ?? 0) === 1
}

/** Ends a job. `note` is what the log (and the next reader) gets to see about a failed turn. */
export async function finishJob(env: Env, jobId: string, runner: string, ok: boolean, note = ''): Promise<void> {
  await env.DB.prepare(
    `UPDATE runner_jobs SET status = ?, lease_until = NULL, note = ? WHERE id = ? AND runner = ?`,
  )
    .bind(ok ? 'done' : 'failed', note.slice(0, 500), jobId, runner)
    .run()
}

/**
 * The job this machine is holding, for the doors that carry a thread's data.
 *
 * Every session read and write goes through this: the bearer token says "some machine", this says
 * which job, so a machine holding one thread's job cannot read another thread's conversation.
 */
export async function leasedJob(env: Env, jobId: string, runner: string): Promise<RunnerJob | null> {
  const row = await env.DB.prepare(
    `SELECT payload FROM runner_jobs WHERE id = ? AND runner = ? AND status = 'leased'`,
  )
    .bind(jobId, runner)
    .first<{ payload: string }>()
  return row ? (JSON.parse(row.payload) as RunnerJob) : null
}

/** The thread's session, or null when the thread has not had a turn yet. */
export async function readSession(env: Env, key: string): Promise<Uint8Array | null> {
  const rows = await env.DB.prepare(`SELECT bytes FROM session_chunks WHERE key = ? ORDER BY idx`)
    .bind(key)
    .all<{ bytes: ArrayBuffer | Uint8Array | number[] }>()
  const parts = rows.results ?? []
  if (!parts.length) return null
  const out = new Uint8Array(parts.reduce((n, p) => n + byteLength(p.bytes), 0))
  let at = 0
  for (const part of parts) {
    const chunk = toBytes(part.bytes)
    out.set(chunk, at)
    at += chunk.byteLength
  }
  return out
}

/** Stores the thread's session. One batch, so a half-written session is never readable. */
export async function writeSession(env: Env, key: string, bytes: Uint8Array): Promise<void> {
  if (bytes.byteLength > MAX_SESSION_BYTES) {
    throw new Error(`session for ${key} is ${bytes.byteLength} bytes, over the ${MAX_SESSION_BYTES} limit`)
  }
  const statements = [env.DB.prepare(`DELETE FROM session_chunks WHERE key = ?`).bind(key)]
  for (let i = 0; i < chunkCount(bytes.byteLength); i++) {
    const slice = bytes.subarray(i * CHUNK_BYTES, Math.min((i + 1) * CHUNK_BYTES, bytes.byteLength))
    statements.push(env.DB.prepare(`INSERT INTO session_chunks (key, idx, bytes) VALUES (?, ?, ?)`).bind(key, i, slice))
  }
  statements.push(
    env.DB.prepare(
      `INSERT INTO sessions (key, bytes, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET bytes = excluded.bytes, updated_at = excluded.updated_at`,
    ).bind(key, bytes.byteLength, Date.now()),
  )
  await env.DB.batch(statements)
}

/** D1 hands BLOBs back as ArrayBuffer, but a local run has given us the others. */
function toBytes(value: ArrayBuffer | Uint8Array | number[]): Uint8Array {
  if (value instanceof Uint8Array) return value
  if (Array.isArray(value)) return new Uint8Array(value)
  return new Uint8Array(value)
}

function byteLength(value: ArrayBuffer | Uint8Array | number[]): number {
  return value instanceof ArrayBuffer ? value.byteLength : value.length
}
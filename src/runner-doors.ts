import type { Env } from './env.ts'
import { claimJob, extendLease, finishJob, MAX_SESSION_BYTES, readSession, type RunnerJob, writeSession } from './runner-jobs.ts'

/**
 * ②: the doors your own machine knocks on (runner/runner-daemon.mjs).
 *
 * They are not `/sandbox/*`: those carry a one-turn token and are called BY the turn. These are
 * called by the machine that RUNS turns, so they carry one long-lived bearer token and do the three
 * things the sandbox used to do for free — hand over work, say "still alive", and keep a thread's
 * session between turns.
 *
 *   POST /runner/next      Wait for a turn. Long-polls, because a Worker has no wall-clock limit
 *                          while the client stays connected, so an idle machine costs a request
 *                          per 25 seconds rather than one per second.
 *   POST /runner/lease     Still working. Answered false when the lease was taken away.
 *   POST /runner/finish    Done, or failed and why.
 *   GET  /runner/box       The runner and tools the turn runs from, versioned so they cache.
 *   GET  /runner/session   The thread's Claude session.
 *   PUT  /runner/session   The thread's Claude session, after the turn.
 *
 * Everything but `/next` and `/box` needs the job this machine is holding, so a machine with one
 * thread's job can reach that thread's session and no other.
 */

/** How often the long poll looks, and the longest it looks. */
const POLL_MS = 1_500
const MAX_WAIT_MS = 25_000

/** Node's setTimeout has no 0 meaning "next tick" problem here: the loop always waits at least once. */
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** The runner bundle, handed in by src/index.ts: only the Worker can read box/ as text. */
export interface BoxBundle {
  version: string
  files: Record<string, string>
}

export async function runnerDoor(request: Request, env: Env, url: URL, box: BoxBundle): Promise<Response> {
  if (!env.RUNNER_SECRET) return new Response('runner doors are closed: RUNNER_SECRET is not set\n', { status: 404 })
  const runner = request.headers.get('x-runner-id') ?? ''
  if (!(await authorised(env, request)) || !runner) return new Response('unauthorised\n', { status: 401 })

  if (url.pathname === '/runner/next' && request.method === 'POST') return runnerNext(request, env, runner)
  if (url.pathname === '/runner/lease' && request.method === 'POST') return runnerLease(request, env, runner)
  if (url.pathname === '/runner/finish' && request.method === 'POST') return runnerFinish(request, env, runner)
  if (url.pathname === '/runner/box' && request.method === 'GET') return json(box)
  if (url.pathname === '/runner/session' && request.method === 'GET') return runnerSessionGet(request, env, runner, url)
  if (url.pathname === '/runner/session' && request.method === 'PUT') return runnerSessionPut(request, env, runner, url)
  return new Response('not found\n', { status: 404 })
}

/** Waits for a job, then answers with it, or 204 when the wait ran out. */
async function runnerNext(request: Request, env: Env, runner: string): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { waitMs?: number }
  const waitMs = Math.min(Math.max(Number(body.waitMs) || 0, 0), MAX_WAIT_MS)
  const until = Date.now() + waitMs
  for (;;) {
    const job = await claimJob(env, runner)
    if (job) return json(job)
    if (Date.now() >= until) return new Response(null, { status: 204 })
    await sleep(Math.min(POLL_MS, Math.max(0, until - Date.now())))
  }
}

async function runnerLease(request: Request, env: Env, runner: string): Promise<Response> {
  const { jobId } = (await request.json().catch(() => ({}))) as { jobId?: string }
  if (!jobId) return json({ error: 'jobId is required' }, 400)
  return json({ held: await extendLease(env, jobId, runner) })
}

async function runnerFinish(request: Request, env: Env, runner: string): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { jobId?: string; ok?: boolean; note?: string }
  if (!body.jobId) return json({ error: 'jobId is required' }, 400)
  await finishJob(env, body.jobId, runner, Boolean(body.ok), body.note ?? '')
  return json({ ok: true })
}

async function runnerSessionGet(request: Request, env: Env, runner: string, url: URL): Promise<Response> {
  const job = await jobFor(env, runner, url)
  if (!job) return new Response('no such job on this machine\n', { status: 403 })
  const bytes = await readSession(env, job.sessionKey)
  if (!bytes) return new Response(null, { status: 404 })
  return new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } })
}

async function runnerSessionPut(request: Request, env: Env, runner: string, url: URL): Promise<Response> {
  const job = await jobFor(env, runner, url)
  if (!job) return new Response('no such job on this machine\n', { status: 403 })
  const declared = Number(request.headers.get('content-length') ?? 0)
  if (declared > MAX_SESSION_BYTES) return new Response('session too large\n', { status: 413 })
  const bytes = new Uint8Array(await request.arrayBuffer())
  try {
    await writeSession(env, job.sessionKey, bytes)
  } catch (err) {
    return new Response(`${(err as Error).message}\n`, { status: 413 })
  }
  return json({ ok: true, bytes: bytes.byteLength })
}

/**
 * The job named in `?job=`, or null: the check that keeps threads apart.
 *
 * The runner id is the test, not the lease: a turn that overran its lease still owns the session it
 * was writing, and losing it at the upload would cost the thread its whole conversation.
 */
async function jobFor(env: Env, runner: string, url: URL): Promise<RunnerJob | null> {
  const jobId = url.searchParams.get('job') ?? ''
  if (!jobId) return null
  const row = await env.DB.prepare(`SELECT payload FROM runner_jobs WHERE id = ? AND runner = ?`)
    .bind(jobId, runner)
    .first<{ payload: string }>()
  return row ? (JSON.parse(row.payload) as RunnerJob) : null
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** Constant-time over equal lengths, so the bearer token cannot be guessed a byte at a time. */
async function authorised(env: Env, request: Request): Promise<boolean> {
  const header = request.headers.get('authorization') ?? ''
  const got = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : ''
  if (!got) return false
  const [a, b] = [new TextEncoder().encode(got), new TextEncoder().encode(env.RUNNER_SECRET ?? '')]
  if (a.byteLength !== b.byteLength) return false
  let diff = 0
  for (let i = 0; i < a.byteLength; i++) diff |= a[i]! ^ b[i]!
  return diff === 0
}
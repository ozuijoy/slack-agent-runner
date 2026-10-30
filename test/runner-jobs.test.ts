// ②: the turn queue and its doors. What a job carries, how two machines cannot run the same turn,
// and what the doors refuse.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Env } from '../src/env.ts'
import { runnerDoor } from '../src/runner-doors.ts'
import { CHUNK_BYTES, chunkCount, claimJob, enqueueTurn, LEASE_MS, type Launch, sessionKey } from '../src/runner-jobs.ts'

const launch = (over: Partial<Launch> = {}): Launch => ({
  channel: 'C1',
  threadTs: '111.222',
  turnId: 'turn-1',
  sessionId: 'sess-1',
  prompt: 'hello',
  callbackUrl: 'https://w.example/sandbox/callback',
  callbackToken: 'cb',
  transcriptUrl: 'https://w.example/sandbox/transcript',
  progressUrl: 'https://w.example/sandbox/progress',
  memoryUrl: 'https://w.example/sandbox/memory',
  origin: 'https://w.example',
  toolsToken: 'tools',
  files: [],
  model: 'claude-sonnet-5',
  claudeEnvs: { ANTHROPIC_API_KEY: 'sk-ant' },
  channelEnvs: { MY_SECRET: 'hunter2' },
  githubToken: null,
  deadline: 1_700_000_000_000,
  ...over,
})

/** Just enough D1 to see what enqueueTurn stores, and to make claimJob lose a race. */
function fakeDb(updateChanges: number) {
  const seen: { sql: string; args: unknown[] }[] = []
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          seen.push({ sql, args })
          return {
            run: async () => ({ meta: { changes: updateChanges } }),
            first: async () => ({ id: 'turn-1', payload: JSON.stringify({ jobId: 'turn-1' }) }),
          }
        },
      }
    },
  }
  return { db, seen }
}

test('a thread is one session, whichever turn asks for it', () => {
  assert.equal(sessionKey('C1', '111.222'), 'C1/111.222')
})

test('a session is chunked under D1’s 2 MB row limit', () => {
  assert.equal(chunkCount(0), 1)
  assert.equal(chunkCount(1), 1)
  assert.equal(chunkCount(CHUNK_BYTES), 1)
  assert.equal(chunkCount(CHUNK_BYTES + 1), 2)
  assert.ok(CHUNK_BYTES < 2 * 1024 * 1024)
})

test('the bundle a machine downloads is exactly the box/ directory', () => {
  // src/box-src.ts lists the same names, but it can only be loaded inside the Worker (box/*.md and
  // *.mjs are text imports there), so this checks the side a test can see.
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'box')
  assert.deepEqual(readdirSync(root).sort(), [
    'CLAUDE.md',
    'files.mjs',
    'inbox-hook.mjs',
    'inbox.mjs',
    'memory.mjs',
    'progress.mjs',
    'run-turn.mjs',
    'tools.mjs',
  ])
})

test('a job carries the envs run-turn.mjs reads, and no file URL when no file came', async () => {
  const { db, seen } = fakeDb(0)
  await enqueueTurn({ DB: db } as unknown as Env, launch())
  const insert = seen.find((s) => s.sql.includes('INSERT OR REPLACE INTO runner_jobs'))!
  assert.equal(insert.args[0], 'turn-1')
  assert.equal(insert.args[4] && typeof insert.args[4], 'string')
  const job = JSON.parse(insert.args[4] as string)
  assert.equal(job.sessionKey, 'C1/111.222')
  assert.equal(job.env.PROMPT_FILE, undefined, 'the daemon owns the prompt path, not the Worker')
  assert.equal(job.env.CALLBACK_URL, 'https://w.example/sandbox/callback')
  assert.equal(job.env.AGENT_TOOLS_TOKEN, 'tools')
  assert.equal(job.env.SLACK_THREAD_TS, '111.222')
  assert.equal(job.env.MY_SECRET, 'hunter2')
  assert.equal(job.env.FILE_URL, undefined)
  assert.equal(job.env.GH_TOKEN, undefined)
})

test('a job with files and a GitHub token carries their addresses', async () => {
  const { db, seen } = fakeDb(0)
  const files = [{ path: 'a.png', url: 'https://w.example/sandbox/file?g=1', bytes: 3 }] as unknown as Launch['files']
  await enqueueTurn({ DB: db } as unknown as Env, launch({ files, githubToken: 'ghs_x' }))
  const job = JSON.parse(seen.find((s) => s.sql.includes('INSERT OR REPLACE'))!.args[4] as string)
  assert.equal(job.env.FILE_URL, 'https://w.example/sandbox/file')
  assert.equal(job.env.GH_TOKEN, 'ghs_x')
  assert.equal(job.files.length, 1)
})

test('a machine that loses the claim does not run the turn', async () => {
  const { db } = fakeDb(0)
  assert.equal(await claimJob({ DB: db } as unknown as Env, 'box-1', Date.now()), null)
})

test('a machine that wins the claim gets the job and a lease on it', async () => {
  const { db, seen } = fakeDb(1)
  const now = 1_700_000_000_000
  const job = await claimJob({ DB: db } as unknown as Env, 'box-1', now)
  assert.equal(job?.jobId, 'turn-1')
  const update = seen.find((s) => s.sql.includes('SET status'))!
  assert.equal(update.args[0], 'box-1')
  assert.equal(update.args[1], now + LEASE_MS)
})

test('the doors are shut when no runner is configured, and to the wrong bearer', async () => {
  const url = new URL('https://w.example/runner/next')
  const box = { version: 'v', files: {} }
  const call = (env: Partial<Env>, headers: Record<string, string> = {}) =>
    runnerDoor(new Request(url, { method: 'POST', headers }), env as Env, url, box)

  assert.equal((await call({})).status, 404)
  const closed = await call({ RUNNER_SECRET: 'right' }, { authorization: 'Bearer wrong', 'x-runner-id': 'box-1' })
  assert.equal(closed.status, 401)
  const anonymous = await call({ RUNNER_SECRET: 'right' }, { authorization: 'Bearer right' })
  assert.equal(anonymous.status, 401, 'a machine with no id cannot hold a lease')
})
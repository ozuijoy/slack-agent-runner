// Routines: the cron rules (src/routines.ts), the D1 store against SQLite built from migrations/
// (src/routine-store.ts), the sweep that fires them (src/routine-fire.ts), the thread rules a run
// starts with (src/thread.ts), and Claude's `routine` command (box/tools.mjs).
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { sweepRoutines } from '../src/routine-fire.ts'
import { claimRun, createRoutine, deleteRoutine, dueRoutines, getRoutine, listRoutines, listRuns, setRoutineStatus, updateRoutine } from '../src/routine-store.ts'
import { checkRoutineAction, checkTimezone, escapeSlack, nextRunAt, parseCron, runHeader, runPrompt, type Cron } from '../src/routines.ts'
import { abortStart, acceptRoutineRun, authorView, emptyThread, finish, type ThreadData } from '../src/thread.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const { parseArgs, run, formatRoutines } = await import(pathToFileURL(join(root, 'box', 'tools.mjs')).href)

const cron = (expr: string): Cron => {
  const c = parseCron(expr)
  assert.ok(c.ok, `${expr} parses`)
  return c.value
}
const at = (iso: string) => Date.parse(iso)
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString())

// ---------------------------------------------------------------------------------------------
// Cron and time zones.

test('cron fields: lists, ranges, steps and names', () => {
  const c = cron('*/15 9-17/4 1,15 jan-mar MON-fri')
  assert.deepEqual([...c.minutes], [0, 15, 30, 45])
  assert.deepEqual([...c.hours], [9, 13, 17])
  assert.deepEqual([...c.days], [1, 15])
  assert.deepEqual([...c.months], [1, 2, 3])
  assert.deepEqual([...c.weekdays], [1, 2, 3, 4, 5])
  assert.deepEqual([...cron('0 0 * * 7').weekdays], [0], '7 is Sunday')
  assert.deepEqual([...cron('5/20 * * * *').minutes], [5, 25, 45])
})

test('bad cron is refused with the field that is wrong', () => {
  for (const bad of ['', '* * * *', '* * * * * *', '60 * * * *', '* 24 * * *', '* * 0 * *', '* * * 13 *', '* * * * 8', '*/0 * * * *', '5-1 * * * *', 'x * * * *', '1-2-3 * * * *']) {
    assert.equal(parseCron(bad).ok, false, bad)
  }
  const r = parseCron('0 25 * * *')
  assert.ok(!r.ok && r.error.includes('hour'))
})

test('next run: every minute, and a weekly time in a time zone across daylight saving', () => {
  assert.equal(iso(nextRunAt(cron('* * * * *'), 'UTC', at('2026-10-30T10:00:30Z'))), '2026-10-30T10:01:00.000Z')
  // Monday 9:00 in London: GMT in November, BST in July.
  assert.equal(iso(nextRunAt(cron('0 9 * * 1'), 'Europe/London', at('2026-10-30T12:00:00Z'))), '2026-11-02T09:00:00.000Z')
  assert.equal(iso(nextRunAt(cron('0 9 * * 1'), 'Europe/London', at('2026-07-01T00:00:00Z'))), '2026-07-06T08:00:00.000Z')
  // A half-hour offset.
  assert.equal(iso(nextRunAt(cron('0 9 * * *'), 'Asia/Kolkata', at('2026-10-30T00:00:00Z'))), '2026-10-30T03:30:00.000Z')
  // 02:30 does not exist in New York on the day the clocks go forward: the next one is the day after.
  assert.equal(iso(nextRunAt(cron('30 2 * * *'), 'America/New_York', at('2026-03-08T05:00:00Z'))), '2026-03-09T06:30:00.000Z')
  // Strictly after: a run due now is not due again now.
  assert.equal(iso(nextRunAt(cron('0 9 * * *'), 'UTC', at('2026-10-30T09:00:00Z'))), '2026-10-31T09:00:00.000Z')
})

test('next run: the hour the clocks go back is read twice, and a pinned time fires once', () => {
  // New York, 1 Nov 2026: 01:30 EDT (05:30Z), then 01:30 EST (06:30Z). Only the first fires.
  const ny = 'America/New_York'
  assert.equal(iso(nextRunAt(cron('30 1 * * *'), ny, at('2026-11-01T04:00:00Z'))), '2026-11-01T05:30:00.000Z')
  assert.equal(iso(nextRunAt(cron('30 1 * * *'), ny, at('2026-11-01T05:30:00Z'))), '2026-11-02T06:30:00.000Z')
  // London, 25 Oct 2026: 01:15 BST (00:15Z), then 01:15 GMT (01:15Z).
  assert.equal(iso(nextRunAt(cron('15 1 * * *'), 'Europe/London', at('2026-10-25T00:15:00Z'))), '2026-10-26T01:15:00.000Z')
  // Lord Howe goes back half an hour: 01:45 is read at 14:45Z and again at 15:15Z; the next is 6 Apr at +10:30.
  assert.equal(iso(nextRunAt(cron('45 1 * * *'), 'Australia/Lord_Howe', at('2026-04-04T14:45:00Z'))), '2026-04-05T15:15:00.000Z')
  // A routine that runs every hour keeps running through the repeated hour.
  assert.equal(iso(nextRunAt(cron('30 * * * *'), ny, at('2026-11-01T05:30:00Z'))), '2026-11-01T06:30:00.000Z')
  assert.equal(iso(nextRunAt(cron('* * * * *'), ny, at('2026-11-01T05:59:00Z'))), '2026-11-01T06:00:00.000Z')
})

test('both day fields set: a day matching either one fires, as in cron', () => {
  // The 13th, or any Friday. 2026-11-06 is a Friday, before the 13th.
  assert.equal(iso(nextRunAt(cron('0 0 13 * 5'), 'UTC', at('2026-11-01T00:00:00Z'))), '2026-11-06T00:00:00.000Z')
  assert.equal(iso(nextRunAt(cron('0 0 13 * *'), 'UTC', at('2026-11-01T00:00:00Z'))), '2026-11-13T00:00:00.000Z')
})

test('time zones are checked and spelled as the runtime spells them', () => {
  assert.deepEqual(checkTimezone('Europe/London'), { ok: true, value: 'Europe/London' })
  assert.equal(checkTimezone('Mars/Olympus').ok, false)
  assert.equal(checkTimezone('').ok, false)
  assert.equal(checkTimezone(null).ok, false)
})

// ---------------------------------------------------------------------------------------------
// What the sandbox may ask.

test('a create is checked: prompt, cron that fires, time zone, model', () => {
  assert.deepEqual(checkRoutineAction({ action: 'create', prompt: ' check CI ', cron: ' 0  9 * * 1 ' }), {
    ok: true,
    value: { action: 'create', prompt: 'check CI', cron: '0 9 * * 1' },
  })
  assert.deepEqual(checkRoutineAction({ action: 'create', prompt: 'x', cron: '0 9 * * *', timezone: 'Asia/Tokyo', model: 'haiku' }), {
    ok: true,
    value: { action: 'create', prompt: 'x', cron: '0 9 * * *', timezone: 'Asia/Tokyo', model: 'haiku' },
  })
  assert.equal(checkRoutineAction({ action: 'create', prompt: '', cron: '0 9 * * *' }).ok, false)
  assert.equal(checkRoutineAction({ action: 'create', prompt: 'x'.repeat(4001), cron: '0 9 * * *' }).ok, false)
  assert.equal(checkRoutineAction({ action: 'create', prompt: 'x', cron: 'every monday' }).ok, false)
  assert.equal(checkRoutineAction({ action: 'create', prompt: 'x', cron: '0 9 * * *', timezone: 'Nowhere' }).ok, false)
  assert.equal(checkRoutineAction({ action: 'create', prompt: 'x', cron: '0 9 * * *', model: 'gpt' }).ok, false)
  const never = checkRoutineAction({ action: 'create', prompt: 'x', cron: '0 9 30 2 *' })
  assert.ok(!never.ok && never.error.includes('never fires'))
})

test('no limit on frequency: every minute is allowed', () => {
  assert.equal(checkRoutineAction({ action: 'create', prompt: 'x', cron: '* * * * *' }).ok, true)
})

test('the other actions take an id, and nothing names a channel', () => {
  assert.deepEqual(checkRoutineAction({ action: 'list', channel: 'COTHER' }), { ok: true, value: { action: 'list' } })
  assert.deepEqual(checkRoutineAction({ action: 'pause', id: 'abcde12345' }), { ok: true, value: { action: 'pause', id: 'abcde12345' } })
  assert.equal(checkRoutineAction({ action: 'delete', id: '../x' }).ok, false)
  assert.equal(checkRoutineAction({ action: 'drop' }).ok, false)
  assert.equal(checkRoutineAction(null).ok, false)
})

test('a run shows the prompt as written: no mention, no link', () => {
  assert.equal(escapeSlack('<!channel> & <https://x|y>'), '&lt;!channel&gt; &amp; &lt;https://x|y&gt;')
  const header = runHeader({ id: 'abcde12345', prompt: 'ping <!here>\nthen stop', cron: '0 9 * * 1', timezone: 'UTC', created_by: 'U1' })
  assert.match(header, /Routine\* `abcde12345`/)
  assert.match(header, /made by <@U1>/)
  assert.ok(!header.includes('<!here>'))
  assert.match(header, /> ping &lt;!here&gt;\n> then stop/)
  assert.match(runPrompt({ id: 'abcde12345', prompt: 'check CI', cron: '0 9 * * 1', timezone: 'UTC' }), /scheduled run of routine abcde12345[\s\S]*\n\ncheck CI$/)
})

// ---------------------------------------------------------------------------------------------
// The store.

/** Enough of D1 for src/db.ts, with run() answering `meta.changes` as D1 does. */
function fakeD1() {
  const sqlite = new DatabaseSync(':memory:')
  for (const file of readdirSync(join(root, 'migrations')).filter((f) => f.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(join(root, 'migrations', file), 'utf8'))
  }
  const DB = {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          const stmt = sqlite.prepare(sql)
          const args = params as never[]
          return {
            run: async () => ({ meta: { changes: Number(stmt.run(...args).changes) } }),
            all: async () => ({ results: stmt.all(...args).map((r) => ({ ...r })) }),
            first: async () => {
              const row = stmt.get(...args)
              return row ? { ...row } : null
            },
          }
        },
      }
    },
  }
  return { sqlite, env: { DB } as never as { DB: D1Database } }
}

const NOW = at('2026-10-30T08:00:30Z')
const newRoutine = (channel = 'CHANNELA', cronExpr = '0 9 * * *') => ({
  channel,
  prompt: 'check CI',
  cron: cronExpr,
  timezone: 'UTC',
  model: null,
  origin: 'https://agent.example',
  createdBy: 'U1',
  createdThreadTs: '100.0',
})

test('a routine is saved active with its first run, and a channel sees only its own', async () => {
  const { env } = fakeD1()
  const a = await createRoutine(env, newRoutine('CHANNELA'), NOW)
  await createRoutine(env, newRoutine('CHANNELB'), NOW)
  assert.equal(a.status, 'active')
  assert.equal(iso(a.next_run_at), '2026-10-30T09:00:00.000Z')
  assert.match(a.id, /^[a-z0-9]{10}$/)

  const listed = await listRoutines(env, 'CHANNELA')
  assert.equal(listed.length, 1)
  assert.equal(listed[0].id, a.id)
  assert.match(listed[0].nextRun!, /09:00 \(UTC\)/)
  assert.equal((await listRoutines(env, null)).length, 2, 'the web UI sees all')
})

test('another channel cannot pause, resume or delete a routine', async () => {
  const { env } = fakeD1()
  const a = await createRoutine(env, newRoutine('CHANNELA'), NOW)
  assert.equal(await setRoutineStatus(env, 'CHANNELB', a.id, 'paused'), null)
  assert.equal(await deleteRoutine(env, 'CHANNELB', a.id), false)
  assert.equal((await getRoutine(env, null, a.id))?.status, 'active')
})

test('pause clears the next run; resume counts it from now, not from before the pause', async () => {
  const { env } = fakeD1()
  const a = await createRoutine(env, newRoutine(), NOW)
  const paused = await setRoutineStatus(env, 'CHANNELA', a.id, 'paused', NOW)
  assert.equal(paused?.status, 'paused')
  assert.equal(paused?.nextRunAt, null)
  assert.equal((await dueRoutines(env, at('2026-11-05T00:00:00Z'))).length, 0, 'a paused routine is never due')
  const resumed = await setRoutineStatus(env, 'CHANNELA', a.id, 'active', at('2026-11-05T12:00:00Z'))
  assert.equal(iso(resumed!.nextRunAt), '2026-11-06T09:00:00.000Z')
})

test('delete removes the routine and its runs', async () => {
  const { env, sqlite } = fakeD1()
  const a = await createRoutine(env, newRoutine(), NOW)
  const due = at('2026-10-30T09:00:10Z')
  await claimRun(env, (await dueRoutines(env, due))[0], due)
  assert.equal(await deleteRoutine(env, 'CHANNELA', a.id), true)
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM routine_runs').get()?.n, 0)
  assert.equal(await getRoutine(env, null, a.id), null)
})

test('a run is claimed once, even by two sweeps that read the same due routine', async () => {
  const { env } = fakeD1()
  const a = await createRoutine(env, newRoutine(), NOW)
  const t = at('2026-10-30T09:00:05Z')
  const [first] = await dueRoutines(env, t)
  const [second] = await dueRoutines(env, t)
  assert.ok(await claimRun(env, first, t))
  assert.equal(await claimRun(env, second, t), null)
  const after = await getRoutine(env, null, a.id)
  assert.equal(iso(after!.next_run_at), '2026-10-31T09:00:00.000Z')
  assert.equal(after!.last_run_at, t)
  assert.equal((await listRuns(env, a.id)).length, 1)
})

test('a sweep that died after its claim does not leave the routine stuck', async () => {
  const { env, sqlite } = fakeD1()
  const a = await createRoutine(env, newRoutine(), NOW)
  const t = at('2026-10-30T09:00:05Z')
  const [due] = await dueRoutines(env, t)
  // The claim landed, then the sweep died before moving the routine on.
  sqlite.prepare("INSERT INTO routine_runs (id, routine_id, due_at, status, created_at) VALUES ('r1', ?, ?, 'starting', ?)").run(a.id, due.next_run_at, t)
  assert.equal(await claimRun(env, due, t), null, 'not fired twice')
  assert.equal(iso((await getRoutine(env, null, a.id))!.next_run_at), '2026-10-31T09:00:00.000Z', 'but moved on')
})

test('after an outage a routine fires once, not once per missed run', async () => {
  const { env } = fakeD1()
  const a = await createRoutine(env, newRoutine('CHANNELA', '*/5 * * * *'), NOW)
  const back = at('2026-10-30T10:02:00Z')
  const [due] = await dueRoutines(env, back)
  assert.ok(await claimRun(env, due, back))
  assert.equal(iso((await getRoutine(env, null, a.id))!.next_run_at), '2026-10-30T10:05:00.000Z')
  assert.equal((await dueRoutines(env, back)).length, 0)
})

test('a routine paused between the read and the claim does not fire', async () => {
  const { env } = fakeD1()
  const a = await createRoutine(env, newRoutine(), NOW)
  const t = at('2026-10-30T09:00:05Z')
  const [due] = await dueRoutines(env, t)
  await setRoutineStatus(env, 'CHANNELA', a.id, 'paused', t)
  assert.equal(await claimRun(env, due, t), null)
})

// ---------------------------------------------------------------------------------------------
// Firing: a new root message and a turn in its thread.

function fakeWorld(db: { DB: D1Database }, opts: { failPost?: string; failQueue?: boolean } = {}) {
  const threads = new Map<string, ThreadData>()
  const sent: unknown[] = []
  const slack: Array<{ method: string; body: Record<string, unknown> }> = []
  let ts = 200
  const stub = (name: string) => ({
    async acceptRoutineRun(channel: string, threadTs: string, origin: string, msg: never, model: never, channelModel: never) {
      const data = threads.get(name) ?? emptyThread(channel, threadTs, origin)
      threads.set(name, data)
      return acceptRoutineRun(data, msg, { model, channelModel, now: Date.now(), newTurnId: () => `turn-${name}` })
    },
    async abortStart(turn: never) {
      abortStart(threads.get(name)!, turn)
    },
  })
  const env = {
    ...db,
    SLACK_BOT_TOKEN: 'xoxb-test',
    THREADS: { idFromName: (name: string) => name, get: (name: string) => stub(name) },
    TURNS: {
      async send(job: unknown) {
        if (opts.failQueue) throw new Error('queue down')
        sent.push(job)
      },
    },
  }
  const fetchImpl = async (url: string | URL, init?: RequestInit) => {
    const method = String(url).split('/api/')[1]
    const body = JSON.parse(String(init?.body ?? '{}'))
    slack.push({ method, body })
    if (method === 'chat.postMessage' && !body.thread_ts && opts.failPost) return Response.json({ ok: false, error: opts.failPost })
    return Response.json({ ok: true, ts: `${++ts}.0` })
  }
  return { env: env as never, threads, sent, slack, fetchImpl }
}

async function withFetch<T>(fetchImpl: typeof fetch, fn: () => Promise<T>) {
  const real = globalThis.fetch
  globalThis.fetch = fetchImpl
  try {
    return await fn()
  } finally {
    globalThis.fetch = real
  }
}

test('the sweep posts a new thread in the routine channel and starts a turn there', async () => {
  const { env: db, sqlite } = fakeD1()
  const a = await createRoutine(db, { ...newRoutine(), model: 'haiku', prompt: 'check CI <!channel>' }, NOW)
  const world = fakeWorld(db)
  const t = at('2026-10-30T09:00:05Z')
  await withFetch(world.fetchImpl as typeof fetch, () => sweepRoutines(world.env, t))

  const post = world.slack.find((c) => c.method === 'chat.postMessage')!
  assert.equal(post.body.channel, 'CHANNELA')
  assert.equal(post.body.thread_ts, undefined, 'a root message, not a reply')
  assert.ok(!String(post.body.text).includes('<!channel>'))

  assert.equal(world.sent.length, 1)
  const job = world.sent[0] as { channel: string; threadTs: string; origin: string; turn: { firstTurn: boolean; model: string; messages: Array<{ user: string; text: string }> } }
  assert.equal(job.channel, 'CHANNELA')
  assert.equal(job.threadTs, '201.0')
  assert.equal(job.origin, 'https://agent.example')
  assert.equal(job.turn.firstTurn, true)
  assert.equal(job.turn.model, 'haiku', "the routine's own model")
  assert.equal(job.turn.messages[0].user, 'U1')
  assert.match(job.turn.messages[0].text, new RegExp(`routine ${a.id}`))

  const [runRow] = await listRuns(db, a.id)
  assert.equal(runRow.status, 'started')
  assert.equal(runRow.thread_ts, '201.0')

  // The next minute's sweep finds nothing due.
  await withFetch(world.fetchImpl as typeof fetch, () => sweepRoutines(world.env, t + 60_000))
  assert.equal(world.sent.length, 1)
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM routine_runs').get()?.n, 1)
})

test("a run with no model of its own uses the channel's default", async () => {
  const { env: db, sqlite } = fakeD1()
  sqlite.prepare("INSERT INTO channel_settings (channel, watched, default_model, updated_at) VALUES ('CHANNELA', 0, 'sonnet', 1)").run()
  await createRoutine(db, newRoutine(), NOW)
  const world = fakeWorld(db)
  await withFetch(world.fetchImpl as typeof fetch, () => sweepRoutines(world.env, at('2026-10-30T09:00:05Z')))
  assert.equal((world.sent[0] as { turn: { model: string } }).turn.model, 'sonnet')
})

test('a run Slack will not post is recorded as failed, and the routine keeps its schedule', async () => {
  const { env: db } = fakeD1()
  const a = await createRoutine(db, newRoutine(), NOW)
  const world = fakeWorld(db, { failPost: 'not_in_channel' })
  await withFetch(world.fetchImpl as typeof fetch, () => sweepRoutines(world.env, at('2026-10-30T09:00:05Z')))
  const [runRow] = await listRuns(db, a.id)
  assert.equal(runRow.status, 'failed')
  assert.match(runRow.error!, /not_in_channel/)
  assert.equal(world.sent.length, 0)
  const after = await getRoutine(db, null, a.id)
  assert.equal(after?.status, 'active')
  assert.equal(iso(after!.next_run_at), '2026-10-31T09:00:00.000Z')
})

test('a run whose turn cannot be queued frees its thread and says so', async () => {
  const { env: db } = fakeD1()
  const a = await createRoutine(db, newRoutine(), NOW)
  const world = fakeWorld(db, { failQueue: true })
  await withFetch(world.fetchImpl as typeof fetch, () => sweepRoutines(world.env, at('2026-10-30T09:00:05Z')))
  const [runRow] = await listRuns(db, a.id)
  assert.equal(runRow.status, 'failed')
  assert.equal([...world.threads.values()][0].running, null)
  assert.ok(world.slack.some((c) => c.body.thread_ts === '201.0' && /could not start/.test(String(c.body.text))))
})

// ---------------------------------------------------------------------------------------------
// The thread rules a run and the door use.

test("a run starts like a mention, on the routine's model; a thread's own pick is not overwritten", () => {
  const data = emptyThread('C1', '200.0', 'https://agent.example')
  const r = acceptRoutineRun(data, { ts: '200.0', user: 'U1', text: 'go' }, { model: 'sonnet', now: 1, newTurnId: () => 't1' })
  assert.equal(r.action, 'start')
  if (r.action === 'start') assert.equal(r.turn.model, 'sonnet')
  const known = { ...emptyThread('C1', '300.0', 'o'), known: true, model: 'haiku' as const }
  acceptRoutineRun(known, { ts: '300.1', user: 'U1', text: 'go' }, { model: 'opus', now: 1, newTurnId: () => 't2' })
  assert.equal(known.model, 'haiku')
})

test('the door reads the creator from the running turn, and nothing once it is over', () => {
  const data = emptyThread('C1', '100.0', 'o')
  const r = acceptRoutineRun(data, { ts: '100.0', user: 'U7', text: 'every monday' }, { now: 1, newTurnId: () => 't1' })
  assert.equal(r.action, 'start')
  assert.deepEqual(authorView(data, 't1'), { running: true, author: 'U7' })
  assert.deepEqual(authorView(data, 'other'), { running: false })
  finish(data, 't1', { now: 2, newTurnId: () => 'x', answered: true })
  assert.deepEqual(authorView(data, 't1'), { running: false })
})

// ---------------------------------------------------------------------------------------------
// Claude's command.

test('routine command line', () => {
  assert.deepEqual(parseArgs(['routine', 'create', '--cron', '0 9 * * 1', '--tz', 'Europe/London', '--model', 'sonnet', '--prompt', 'check CI']), {
    command: 'routine',
    action: 'create',
    cron: '0 9 * * 1',
    timezone: 'Europe/London',
    model: 'sonnet',
    prompt: 'check CI',
  })
  assert.deepEqual(parseArgs(['routine', 'list']), { command: 'routine', action: 'list' })
  assert.deepEqual(parseArgs(['routine', 'pause', 'abcde12345']), { command: 'routine', action: 'pause', id: 'abcde12345' })
  assert.ok(parseArgs(['routine', 'create', '--prompt', 'x']).error, 'needs --cron')
  assert.ok(parseArgs(['routine', 'create', '--cron', '* * * * *']).error, 'needs --prompt')
  assert.ok(parseArgs(['routine', 'create', '--cron', '0', '9', '--prompt', 'x']).error, 'an unquoted cron is refused')
  assert.ok(parseArgs(['routine', 'create', '--cron', '* * * * *', '--prompt', 'x', '--channel', 'C9']).error, 'no way to name another channel')
  assert.ok(parseArgs(['routine', 'list', '--tz', 'UTC']).error)
  assert.ok(parseArgs(['routine', 'delete']).error)
  assert.ok(parseArgs(['routine', 'edit', 'x']).error)
  assert.ok(parseArgs(['routine']).error)
})

test('routine command calls the routines door with the tools token', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const env = { AGENT_API_URL: 'https://w.example', AGENT_TOOLS_TOKEN: 'tok', TURN_ID: 't1' }
  const fetchImpl = async (url: URL, init: RequestInit) => {
    calls.push({ url: String(url), init })
    return Response.json({ ok: true, routine: { id: 'abcde12345', cron: '0 9 * * 1', timezone: 'Europe/London', nextRun: 'Mon 2 Nov, 09:00 (Europe/London)' } })
  }
  const out = await run({ command: 'routine', action: 'create', cron: '0 9 * * 1', prompt: 'check CI' }, { env, fetchImpl })
  assert.equal(calls[0].url, 'https://w.example/sandbox/routines')
  assert.equal((calls[0].init.headers as Record<string, string>).authorization, 'Bearer tok')
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { turnId: 't1', action: 'create', cron: '0 9 * * 1', prompt: 'check CI' })
  assert.match(out, /Made routine abcde12345/)
  assert.match(out, /Next run: Mon 2 Nov, 09:00/)

  assert.equal(formatRoutines([]), 'This channel has no routines.')
  const listed = formatRoutines([{ id: 'abcde12345', cron: '0 9 * * 1', timezone: 'UTC', status: 'paused', prompt: 'check CI', createdBy: 'U1' }])
  assert.match(listed, /abcde12345 · `0 9 \* \* 1` UTC · paused by <@U1>\n {2}check CI/)

  const refuse = async () => Response.json({ ok: false, error: 'no routine x in this channel' }, { status: 404 })
  await assert.rejects(run({ command: 'routine', action: 'delete', id: 'x' }, { env, fetchImpl: refuse }), /refused: no routine x/)
})

test('the web UI edits a routine: an active one is rescheduled from now, a paused one stays paused', async () => {
  const { env } = fakeD1()
  const a = await createRoutine(env, newRoutine('CHANNELA'), NOW)
  const edited = await updateRoutine(env, a.id, { prompt: 'check CD', cron: '30 10 * * *', timezone: 'Asia/Tokyo', model: 'haiku' }, NOW)
  assert.equal(edited?.prompt, 'check CD')
  assert.equal(edited?.channel, 'CHANNELA', 'a routine stays in the channel it was made in')
  assert.equal(edited?.model, 'haiku')
  assert.equal(iso(edited!.nextRunAt), '2026-10-31T01:30:00.000Z')

  await setRoutineStatus(env, null, a.id, 'paused', NOW)
  const pausedEdit = await updateRoutine(env, a.id, { prompt: 'x', cron: '0 9 * * *', timezone: 'UTC', model: null }, NOW)
  assert.equal(pausedEdit?.status, 'paused')
  assert.equal(pausedEdit?.nextRunAt, null)
  assert.equal(await updateRoutine(env, 'zzzzzzzzzz', { prompt: 'x', cron: '0 9 * * *', timezone: 'UTC', model: null }, NOW), null)
  await assert.rejects(updateRoutine(env, a.id, { prompt: 'x', cron: 'nope', timezone: 'UTC', model: null }, NOW))
})

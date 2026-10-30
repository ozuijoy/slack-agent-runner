import { dbAll, dbChanges, dbFirst, dbRun } from './db.ts'
import type { Env } from './env.ts'
import { newRoutineId, nextRunAt, parseCron, routineView, type RoutineRow } from './routines.ts'

/**
 * Routines in D1 (the rules: src/routines.ts). Every call that the sandbox reaches takes the
 * channel from the turn's token, and every query is scoped to it, so a thread only ever touches its
 * own channel's routines. A `channel` of null is for the web UI, which sees them all.
 */
type DbEnv = Pick<Env, 'DB'>

const COLUMNS =
  'id, channel, prompt, cron, timezone, model, status, origin, created_by, created_thread_ts, created_at, updated_at, next_run_at, last_run_at'

export interface NewRoutine {
  channel: string
  prompt: string
  cron: string
  timezone: string
  model: string | null
  origin: string
  createdBy: string | null
  createdThreadTs: string | null
}

/** Saves a routine, active, with its first run time. The cron was checked by checkRoutineAction. */
export async function createRoutine(env: DbEnv, r: NewRoutine, now = Date.now()): Promise<RoutineRow> {
  const cron = parseCron(r.cron)
  if (!cron.ok) throw new Error(cron.error)
  const id = newRoutineId()
  await dbRun(
    env,
    `INSERT INTO routines (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, NULL)`,
    id,
    r.channel,
    r.prompt,
    r.cron,
    r.timezone,
    r.model,
    r.origin,
    r.createdBy,
    r.createdThreadTs,
    now,
    now,
    nextRunAt(cron.value, r.timezone, now),
  )
  return (await getRoutine(env, null, id))!
}

export async function getRoutine(env: DbEnv, channel: string | null, id: string): Promise<RoutineRow | null> {
  return channel === null
    ? dbFirst<RoutineRow>(env, `SELECT ${COLUMNS} FROM routines WHERE id = ?`, id)
    : dbFirst<RoutineRow>(env, `SELECT ${COLUMNS} FROM routines WHERE id = ? AND channel = ?`, id, channel)
}

/** A channel's routines (or all, for the UI), oldest first. */
export async function listRoutines(env: DbEnv, channel: string | null) {
  const rows =
    channel === null
      ? await dbAll<RoutineRow>(env, `SELECT ${COLUMNS} FROM routines ORDER BY created_at`)
      : await dbAll<RoutineRow>(env, `SELECT ${COLUMNS} FROM routines WHERE channel = ? ORDER BY created_at`, channel)
  return rows.map(routineView)
}

/**
 * Pause or resume. Paused clears the next run, so the sweep skips it; resumed counts the next run
 * from now, so a long pause does not fire a missed run the moment it is resumed. Null when the
 * routine is not in that channel.
 */
export async function setRoutineStatus(env: DbEnv, channel: string | null, id: string, status: 'active' | 'paused', now = Date.now()) {
  const row = await getRoutine(env, channel, id)
  if (!row) return null
  let next: number | null = null
  if (status === 'active') {
    const cron = parseCron(row.cron)
    next = cron.ok ? nextRunAt(cron.value, row.timezone, now) : null
  }
  await dbRun(env, 'UPDATE routines SET status = ?, next_run_at = ?, updated_at = ? WHERE id = ?', status, next, now, id)
  return routineView((await getRoutine(env, null, id))!)
}

export interface RoutineEdit {
  prompt: string
  cron: string
  timezone: string
  model: string | null
}

/**
 * Changes a routine's prompt, schedule, time zone or model (the web UI's edit). An active routine's
 * next run is counted again from now on the new schedule; a paused one stays paused. Null when the
 * routine does not exist. The channel never changes: a routine runs where it was made.
 */
export async function updateRoutine(env: DbEnv, id: string, edit: RoutineEdit, now = Date.now()) {
  const row = await getRoutine(env, null, id)
  if (!row) return null
  const cron = parseCron(edit.cron)
  if (!cron.ok) throw new Error(cron.error)
  const next = row.status === 'active' ? nextRunAt(cron.value, edit.timezone, now) : null
  await dbRun(
    env,
    'UPDATE routines SET prompt = ?, cron = ?, timezone = ?, model = ?, next_run_at = ?, updated_at = ? WHERE id = ?',
    edit.prompt,
    edit.cron,
    edit.timezone,
    edit.model,
    next,
    now,
    id,
  )
  return routineView((await getRoutine(env, null, id))!)
}

/** Deletes a routine and its run records. False when it is not in that channel. */
export async function deleteRoutine(env: DbEnv, channel: string | null, id: string): Promise<boolean> {
  const row = await getRoutine(env, channel, id)
  if (!row) return false
  await dbRun(env, 'DELETE FROM routines WHERE id = ?', id)
  await dbRun(env, 'DELETE FROM routine_runs WHERE routine_id = ?', id)
  return true
}

export interface RunRow {
  id: string
  routine_id: string
  due_at: number
  status: string
  thread_ts: string | null
  error: string | null
  created_at: number
}

/** A routine's runs, newest first, for the UI. */
export async function listRuns(env: DbEnv, routineId: string, limit = 50) {
  return dbAll<RunRow>(
    env,
    'SELECT id, routine_id, due_at, status, thread_ts, error, created_at FROM routine_runs WHERE routine_id = ? ORDER BY due_at DESC LIMIT ?',
    routineId,
    limit,
  )
}

// ---------------------------------------------------------------------------------------------
// The sweep (src/routine-fire.ts).

/** Every active routine whose next run is due. */
export async function dueRoutines(env: DbEnv, now: number) {
  return dbAll<RoutineRow>(
    env,
    `SELECT ${COLUMNS} FROM routines WHERE status = 'active' AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at`,
    now,
  )
}

/**
 * Claims one due run (rule 5 in src/routines.ts) and moves the routine on to its next run.
 *
 * The claim is an insert of (routine, due time), which the table's unique key lets through once,
 * and only while the routine is still active and still due at that time. The move-on runs whether
 * or not this sweep won the claim, and only if nobody moved it already: a sweep that died between
 * the two steps must not leave the routine stuck on a run that can never be claimed again.
 * Returns the run id when this sweep should fire it, else null.
 */
export async function claimRun(env: DbEnv, routine: RoutineRow, now: number): Promise<string | null> {
  const due = routine.next_run_at
  if (due === null) return null
  const runId = crypto.randomUUID()
  const claimed = await dbChanges(
    env,
    `INSERT INTO routine_runs (id, routine_id, due_at, status, created_at)
     SELECT ?, id, next_run_at, 'starting', ? FROM routines WHERE id = ? AND status = 'active' AND next_run_at = ?
     ON CONFLICT (routine_id, due_at) DO NOTHING`,
    runId,
    now,
    routine.id,
    due,
  )
  // Counted from now, not from the due time: after an outage it fires once, not once per miss.
  const cron = parseCron(routine.cron)
  const next = cron.ok ? nextRunAt(cron.value, routine.timezone, Math.max(now, due)) : null
  await dbRun(
    env,
    'UPDATE routines SET next_run_at = ?, last_run_at = ? WHERE id = ? AND next_run_at = ?',
    next,
    claimed ? now : routine.last_run_at,
    routine.id,
    due,
  )
  return claimed ? runId : null
}

export async function markRun(env: DbEnv, runId: string, outcome: { status: 'started' | 'failed'; threadTs?: string | null; error?: string }) {
  await dbRun(
    env,
    'UPDATE routine_runs SET status = ?, thread_ts = COALESCE(?, thread_ts), error = ? WHERE id = ?',
    outcome.status,
    outcome.threadTs ?? null,
    outcome.error ? outcome.error.slice(0, 500) : null,
    runId,
  )
}

/**
 * The rules for routines: a prompt the bot runs on a schedule. The queries are in
 * src/routine-store.ts, the firing in src/routine-fire.ts, and the sandbox command in box/tools.mjs
 * (`routine create|list|pause|resume|delete`).
 *
 * 1. ANYONE CAN MAKE ONE, FROM A THREAD. Claude makes it with `node ~/.agent/tools.mjs routine
 *    create`, which calls POST /sandbox/routines with the turn's tools token. The routine's channel
 *    comes from the token, never the body, so a thread can only make, see, pause or delete its own
 *    channel's routines. A private channel's routines never show up anywhere else.
 * 2. EACH RUN IS A NEW THREAD. The bot posts a root message in the channel and starts a turn in it,
 *    with a fresh sandbox. A run never resumes an earlier run's session.
 * 3. NO LIMITS. Any number of routines, as often as every minute. Each run is a Claude turn and a
 *    sandbox, so a busy schedule costs money; the README says so.
 * 4. THE SCHEDULE IS CRON, IN A TIME ZONE. Five fields (minute hour day-of-month month
 *    day-of-week), read in an IANA time zone, so "every Monday 9am" stays 9am across daylight
 *    saving. As in cron, when both day fields are set, a day matching EITHER one fires.
 * 5. A RUN FIRES ONCE. The Cron Trigger sweeps every minute. A run is claimed by inserting a
 *    (routine, due time) row that cannot be inserted twice, so two overlapping sweeps never both
 *    fire it. A sweep that was missed (the Worker was down) fires the routine once when it comes
 *    back, not once per missed time.
 */

import { isModelAlias, type ModelAlias } from './models.ts'

export const MAX_PROMPT_CHARS = 4000

// ---------------------------------------------------------------------------------------------
// Cron.

export interface Cron {
  minutes: Set<number>
  hours: Set<number>
  days: Set<number>
  months: Set<number>
  weekdays: Set<number>
  /** Cron's day rule: with both day fields restricted, either may match. */
  daysStar: boolean
  weekdaysStar: boolean
}

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

export type Checked<T> = { ok: true; value: T } | { ok: false; error: string }

/** Parses a five-field cron expression. The error names the field that is wrong. */
export function parseCron(expr: unknown): Checked<Cron> {
  if (typeof expr !== 'string' || !expr.trim()) return { ok: false, error: 'The schedule is empty. Give a five-field cron, such as "0 9 * * 1".' }
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5) return { ok: false, error: `A cron has five fields (minute hour day month weekday); "${expr.trim()}" has ${fields.length}.` }
  const [m, h, dom, mon, dow] = fields
  const minutes = parseField(m, 0, 59, null)
  const hours = parseField(h, 0, 23, null)
  const days = parseField(dom, 1, 31, null)
  const months = parseField(mon, 1, 12, MONTH_NAMES, 1)
  const weekdays = parseField(dow, 0, 7, DAY_NAMES, 0)
  const bad = [
    ['minute', minutes],
    ['hour', hours],
    ['day-of-month', days],
    ['month', months],
    ['day-of-week', weekdays],
  ].find(([, set]) => set === null)
  if (bad) return { ok: false, error: `The ${bad[0]} field of "${expr.trim()}" is not valid cron.` }
  // 7 is Sunday too.
  if (weekdays!.delete(7)) weekdays!.add(0)
  return {
    ok: true,
    value: {
      minutes: minutes!,
      hours: hours!,
      days: days!,
      months: months!,
      weekdays: weekdays!,
      daysStar: dom.startsWith('*'),
      weekdaysStar: dow.startsWith('*'),
    },
  }
}

/** One field: `*`, `5`, `1-5`, `*\/15`, `1-30/2`, `mon-fri`, and comma lists of those. */
function parseField(field: string, min: number, max: number, names: string[] | null, nameBase = 0): Set<number> | null {
  const out = new Set<number>()
  const value = (token: string): number | null => {
    if (/^\d+$/.test(token)) return Number(token)
    const i = names ? names.indexOf(token.toLowerCase()) : -1
    return i >= 0 ? i + nameBase : null
  }
  for (const part of field.split(',')) {
    const m = part.match(/^([^/]+)(?:\/(\d+))?$/)
    if (!m) return null
    const step = m[2] === undefined ? 1 : Number(m[2])
    if (step < 1) return null
    let lo: number
    let hi: number
    if (m[1] === '*') {
      lo = min
      hi = max
    } else {
      const [a, b, extra] = m[1].split('-')
      if (extra !== undefined) return null
      const start = value(a)
      if (start === null) return null
      lo = start
      // `5/15` means from 5 to the end, every 15.
      const end = b === undefined ? (m[2] === undefined ? start : max) : value(b)
      if (end === null) return null
      hi = end
    }
    if (lo < min || hi > max || lo > hi) return null
    for (let v = lo; v <= hi; v += step) out.add(v)
  }
  return out.size ? out : null
}

// ---------------------------------------------------------------------------------------------
// Time zones.

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatter(timeZone: string) {
  let f = formatters.get(timeZone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      weekday: 'short',
    })
    formatters.set(timeZone, f)
  }
  return f
}

/** An IANA time zone name, as the runtime spells it, or why it is not one. */
export function checkTimezone(tz: unknown): Checked<string> {
  if (typeof tz !== 'string' || !tz.trim()) return { ok: false, error: 'The time zone is empty.' }
  try {
    return { ok: true, value: new Intl.DateTimeFormat('en-US', { timeZone: tz.trim() }).resolvedOptions().timeZone }
  } catch {
    return { ok: false, error: `"${tz}" is not a time zone. Use an IANA name such as Europe/London or America/New_York.` }
  }
}

interface LocalTime {
  month: number
  day: number
  weekday: number
  hour: number
  minute: number
}

function localTime(ms: number, timeZone: string): LocalTime {
  const parts: Record<string, string> = {}
  for (const p of formatter(timeZone).formatToParts(new Date(ms))) parts[p.type] = p.value
  return {
    month: Number(parts.month),
    day: Number(parts.day),
    weekday: DAY_NAMES.indexOf(parts.weekday.toLowerCase().slice(0, 3)),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
  }
}

function dayMatches(cron: Cron, t: LocalTime) {
  if (!cron.months.has(t.month)) return false
  const dom = cron.days.has(t.day)
  const dow = cron.weekdays.has(t.weekday)
  if (!cron.daysStar && !cron.weekdaysStar) return dom || dow
  return dom && dow
}

/** Far enough for Feb 29 on a weekday-free cron; past it, a cron counts as never firing. */
const MAX_STEPS = 100_000
const MINUTE = 60_000

/**
 * The first minute strictly after `after` that the cron matches in `timeZone`, or null if none
 * comes within about ten years. Steps an hour at a time until the day and hour match, then jumps
 * to the matching minute. A daylight-saving change only moves the hour it is read in; every step
 * is checked again, so a jump never lands on a time that does not match.
 *
 * When the clocks go back, an hour is read twice. A routine pinned to an hour (anything but `*`
 * in the hour field) fires only on the first reading, as Vixie cron does; one that runs every hour
 * keeps running through both.
 */
export function nextRunAt(cron: Cron, timeZone: string, after: number): number | null {
  let t = Math.floor(after / MINUTE) * MINUTE + MINUTE
  for (let i = 0; i < MAX_STEPS; i++) {
    const local = localTime(t, timeZone)
    if (dayMatches(cron, local) && cron.hours.has(local.hour)) {
      if (cron.minutes.has(local.minute) && !(cron.hours.size < 24 && isRepeatedWallTime(t, local, timeZone))) return t
      const next = [...cron.minutes].filter((m) => m > local.minute).sort((a, b) => a - b)[0]
      if (next !== undefined) {
        t += (next - local.minute) * MINUTE
        continue
      }
    }
    t += (60 - local.minute) * MINUTE
  }
  return null
}

/** Shifts a fall-back can take: an hour almost everywhere, half an hour on Lord Howe, two in old rules. */
const FALL_BACK_SHIFTS = [30 * MINUTE, 60 * MINUTE, 120 * MINUTE]

/** True when the same local date and time was already read at an earlier instant: the repeated hour. */
function isRepeatedWallTime(t: number, local: LocalTime, timeZone: string) {
  return FALL_BACK_SHIFTS.some((shift) => {
    const earlier = localTime(t - shift, timeZone)
    return earlier.month === local.month && earlier.day === local.day && earlier.hour === local.hour && earlier.minute === local.minute
  })
}

/** A run time as people in the routine's time zone read it: "Mon 3 Nov, 09:00 (Europe/London)". */
export function formatRunTime(ms: number, timeZone: string): string {
  const text = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(ms))
  return `${text.replace(' at ', ', ')} (${timeZone})`
}

// ---------------------------------------------------------------------------------------------
// What the sandbox asks for.

export type RoutineAction =
  | { action: 'create'; prompt: string; cron: string; timezone?: string; model?: ModelAlias }
  | { action: 'list' }
  | { action: 'pause' | 'resume' | 'delete'; id: string }

/** Routine ids: 10 lower-case letters and digits (newRoutineId). */
export function isRoutineId(id: unknown): id is string {
  return typeof id === 'string' && /^[a-z0-9]{10}$/.test(id)
}

export function newRoutineId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10))
  return [...bytes].map((b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('')
}

/**
 * Checks what the sandbox sent. Reads only the action and its own fields; a channel, a thread or a
 * creator in the body is ignored (rule 1). The cron must parse AND fire at least once.
 */
export function checkRoutineAction(body: unknown, now = Date.now()): Checked<RoutineAction> {
  const b = (body ?? {}) as Record<string, unknown>
  const action = b.action
  if (action === 'list') return { ok: true, value: { action } }
  if (action === 'pause' || action === 'resume' || action === 'delete') {
    if (!isRoutineId(b.id)) return { ok: false, error: 'That is not a routine id. `routine list` shows them.' }
    return { ok: true, value: { action, id: b.id } }
  }
  if (action !== 'create') return { ok: false, error: 'The action must be create, list, pause, resume or delete.' }

  const prompt = typeof b.prompt === 'string' ? b.prompt.trim() : ''
  if (!prompt) return { ok: false, error: 'The routine needs a prompt: what to do on each run.' }
  if (prompt.length > MAX_PROMPT_CHARS) return { ok: false, error: `The prompt is over ${MAX_PROMPT_CHARS} characters.` }
  const cron = parseCron(b.cron)
  if (!cron.ok) return cron
  let timezone: string | undefined
  if (b.timezone !== undefined && b.timezone !== null && b.timezone !== '') {
    const tz = checkTimezone(b.timezone)
    if (!tz.ok) return tz
    timezone = tz.value
  }
  if (nextRunAt(cron.value, timezone ?? 'UTC', now) === null) return { ok: false, error: `"${String(b.cron).trim()}" never fires (no such date).` }
  let model: ModelAlias | undefined
  if (b.model !== undefined && b.model !== null && b.model !== '') {
    if (!isModelAlias(b.model)) return { ok: false, error: `Unknown model "${String(b.model)}". Use opus, sonnet or haiku, or leave it out for the channel's default.` }
    model = b.model
  }
  const value: RoutineAction = { action, prompt, cron: String(b.cron).trim().split(/\s+/).join(' ') }
  if (timezone) value.timezone = timezone
  if (model) value.model = model
  return { ok: true, value }
}

// ---------------------------------------------------------------------------------------------
// What a run says.

export interface RoutineRow {
  id: string
  channel: string
  prompt: string
  cron: string
  timezone: string
  model: string | null
  status: string
  origin: string
  created_by: string | null
  created_thread_ts: string | null
  created_at: number
  updated_at: number
  next_run_at: number | null
  last_run_at: number | null
}

/** Slack reads &, < and > as markup; a prompt is shown as written, never as a mention or a link. */
export function escapeSlack(text: string) {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

/** The root message a run posts. Its thread is where Claude answers. */
export function runHeader(r: Pick<RoutineRow, 'id' | 'prompt' | 'cron' | 'timezone' | 'created_by'>): string {
  const by = r.created_by ? ` · made by <@${r.created_by}>` : ''
  const quoted = escapeSlack(r.prompt.length > 600 ? `${r.prompt.slice(0, 600)}…` : r.prompt)
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n')
  return `:repeat: *Routine* \`${r.id}\` · \`${r.cron}\` (${r.timezone})${by}\n${quoted}`
}

/** What Claude reads as the run's message. It says nobody is waiting live, and how to stop it. */
export function runPrompt(r: Pick<RoutineRow, 'id' | 'prompt' | 'cron' | 'timezone'>): string {
  return [
    `This is a scheduled run of routine ${r.id} (\`${r.cron}\`, ${r.timezone}), in a new thread.`,
    'Nobody asked live: do the task and make your reply the result.',
    `(To change the schedule, people can ask you to pause or delete routine ${r.id}.)`,
    '',
    r.prompt,
  ].join('\n')
}

/** One routine as the sandbox and the UI see it. */
export function routineView(r: RoutineRow) {
  return {
    id: r.id,
    channel: r.channel,
    prompt: r.prompt,
    cron: r.cron,
    timezone: r.timezone,
    model: r.model,
    status: r.status,
    createdBy: r.created_by,
    createdAt: r.created_at,
    nextRunAt: r.next_run_at,
    nextRun: r.next_run_at === null ? null : formatRunTime(r.next_run_at, r.timezone),
    lastRunAt: r.last_run_at,
  }
}

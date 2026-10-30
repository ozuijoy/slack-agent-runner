/**
 * The rules for the web UI (/ui): what its API accepts. The routes are in src/ui-routes.ts, the
 * pages in ui/, and the sign-in check in src/access.ts.
 *
 * 1. EVERY /ui PATH IS BEHIND ACCESS, pages and API alike (src/access.ts).
 * 2. A CHANGE MUST COME FROM THE PAGE. A write is a POST with a JSON body and an Origin header equal
 *    to the Worker's own. A form on another site cannot send JSON without the browser asking first,
 *    and cannot fake the Origin, so a signed-in person's Access cookie cannot be used against them.
 * 3. THE UI SEES EVERY CHANNEL. It is for the bot's owner, so unlike a thread (which only sees its
 *    own channel's routines) it lists and edits all of them. Who may open it is set in Access.
 * 4. SECRETS ARE WRITE-ONLY. The page can set or delete a channel secret and see its name; a value
 *    never comes back out (src/channels.ts).
 * 5. THE UI HAS ITS OWN HOST. Cloudflare Access can only put a path behind sign-in on a domain in
 *    your own Cloudflare account; on workers.dev its one switch covers the whole host, which would
 *    lock Slack and GitHub out. So the UI lives on a custom domain (UI_HOST, attached to this Worker
 *    by `npm run setup`), Access covers that host, and Slack and GitHub stay on workers.dev. Every
 *    link to the UI uses UI_HOST. Without UI_HOST and Access both set, the UI is not set up.
 * 6. A JOB NEVER POINTS AT THE UI HOST. A routine stores the origin its sandbox reports back to, and
 *    the sandbox has no Access cookie, so on UI_HOST every report would land on Access's sign-in
 *    page and the answer would be lost. A routine made on the UI takes WORKER_URL (the workers.dev
 *    address, written by `npm run setup`), never the address the page was loaded from.
 */

import { accessConfig } from './access.ts'
import { isChannelId, type Checked } from './channels.ts'
import { isModelAlias, type ModelAlias } from './models.ts'
import { checkRoutineAction, isRoutineId } from './routines.ts'
import { transcriptPrefix } from './transcripts.ts'

/** Rule 2. Null when the request may change something, else why not. */
export function checkWrite(req: { method: string; contentType: string | null; origin: string | null; selfOrigin: string }): string | null {
  if (req.method !== 'POST') return 'changes are POST requests'
  if (!(req.contentType ?? '').toLowerCase().startsWith('application/json')) return 'changes are sent as JSON'
  if (req.origin !== req.selfOrigin) return 'changes must come from this site'
  return null
}

/**
 * Rule 5: UI_HOST as a bare lowercase hostname, or null. A URL, a path or a port is trimmed or
 * refused, and so is a workers.dev host: Access cannot cover one path there without covering Slack's.
 */
export function normaliseUiHost(raw: string | undefined): string | null {
  const host = (raw ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '')
  if (!/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host)) return null
  if (host === 'workers.dev' || host.endsWith('.workers.dev')) return null
  return host
}

/** Rule 5: `https://<UI_HOST>` when the UI is set up (its host and Access both), else null. */
export function uiOrigin(env: { UI_HOST?: string; ACCESS_TEAM_DOMAIN?: string; ACCESS_AUD?: string }): string | null {
  const host = normaliseUiHost(env.UI_HOST)
  return host && accessConfig(env) ? `https://${host}` : null
}

/**
 * Rule 6: the Worker's own (workers.dev) origin from WORKER_URL, or null when it is unset, not an
 * https URL, or the UI's host.
 */
export function workerOrigin(env: { WORKER_URL?: string; UI_HOST?: string; ACCESS_TEAM_DOMAIN?: string; ACCESS_AUD?: string }): string | null {
  let origin: string
  try {
    const url = new URL((env.WORKER_URL ?? '').trim())
    if (url.protocol !== 'https:') return null
    origin = url.origin
  } catch {
    return null
  }
  const ui = normaliseUiHost(env.UI_HOST)
  return ui && origin === `https://${ui}` ? null : origin
}

/** A Slack message ts, as a thread id: seconds, a dot, microseconds. */
export function isThreadTs(ts: unknown): ts is string {
  return typeof ts === 'string' && /^\d{9,11}\.\d{6}$/.test(ts)
}

/** A transcript object key in the given thread (src/transcripts.ts transcriptKey), and nothing else. */
export function isTranscriptKeyFor(key: unknown, channel: string, threadTs: string): key is string {
  if (typeof key !== 'string' || !isChannelId(channel) || !isThreadTs(threadTs)) return false
  const prefix = transcriptPrefix(channel, threadTs)
  return key.startsWith(prefix) && /^\d{9,11}\.\d{6}-[A-Za-z0-9-]{1,64}\.jsonl\.gz$/.test(key.slice(prefix.length))
}

// ---------------------------------------------------------------------------------------------
// Routines.

export type UiRoutineAction =
  | { action: 'create'; channel: string; prompt: string; cron: string; timezone: string; model: ModelAlias | null }
  | { action: 'update'; id: string; prompt: string; cron: string; timezone: string; model: ModelAlias | null }
  | { action: 'pause' | 'resume' | 'delete'; id: string }

/**
 * What the Routines page sent. The prompt, schedule, time zone and model follow the same rules as
 * a routine made from a thread (checkRoutineAction); the time zone defaults to UTC.
 */
export function checkUiRoutine(body: unknown, now = Date.now()): Checked<UiRoutineAction> {
  const b = (body ?? {}) as Record<string, unknown>
  if (b.action === 'pause' || b.action === 'resume' || b.action === 'delete') {
    if (!isRoutineId(b.id)) return { ok: false, error: 'That is not a routine id.' }
    return { ok: true, value: { action: b.action, id: b.id } }
  }
  if (b.action !== 'create' && b.action !== 'update') return { ok: false, error: 'The action must be create, update, pause, resume or delete.' }
  const fields = checkRoutineAction({ action: 'create', prompt: b.prompt, cron: b.cron, timezone: b.timezone, model: b.model }, now)
  if (!fields.ok) return fields
  if (fields.value.action !== 'create') return { ok: false, error: 'unexpected routine check' }
  const { prompt, cron } = fields.value
  const timezone = fields.value.timezone ?? 'UTC'
  const model = fields.value.model ?? null
  if (b.action === 'update') {
    if (!isRoutineId(b.id)) return { ok: false, error: 'That is not a routine id.' }
    return { ok: true, value: { action: 'update', id: b.id, prompt, cron, timezone, model } }
  }
  if (!isChannelId(b.channel)) return { ok: false, error: 'Give the channel id (C… or G…). In Slack: the channel name > About > Channel ID.' }
  if (b.channel.startsWith('D')) return { ok: false, error: 'A routine posts in a channel, not a DM.' }
  return { ok: true, value: { action: 'create', channel: b.channel, prompt, cron, timezone, model } }
}

// ---------------------------------------------------------------------------------------------
// Channels.

export type UiChannelAction =
  | { action: 'watch'; channel: string; watched: boolean }
  | { action: 'model'; channel: string; model: ModelAlias | null }
  | { action: 'set-secret'; channel: string; name: unknown; value: unknown }
  | { action: 'delete-secret'; channel: string; name: string }

/** What the Channels page sent. Secret names and values are checked again by the store. */
export function checkUiChannel(body: unknown): Checked<UiChannelAction> {
  const b = (body ?? {}) as Record<string, unknown>
  if (!isChannelId(b.channel)) return { ok: false, error: 'Give the channel id (C…, G… or D…). In Slack: the channel name > About > Channel ID.' }
  const channel = b.channel
  switch (b.action) {
    case 'watch':
      if (typeof b.watched !== 'boolean') return { ok: false, error: 'watched must be true or false.' }
      if (channel.startsWith('D')) return { ok: false, error: 'A DM needs no watching: every DM is for the bot.' }
      return { ok: true, value: { action: 'watch', channel, watched: b.watched } }
    case 'model':
      if (b.model !== null && b.model !== '' && !isModelAlias(b.model)) return { ok: false, error: `Unknown model "${String(b.model)}".` }
      return { ok: true, value: { action: 'model', channel, model: isModelAlias(b.model) ? b.model : null } }
    case 'set-secret':
      return { ok: true, value: { action: 'set-secret', channel, name: b.name, value: b.value } }
    case 'delete-secret':
      if (typeof b.name !== 'string' || !b.name) return { ok: false, error: 'Which secret?' }
      return { ok: true, value: { action: 'delete-secret', channel, name: b.name } }
    default:
      return { ok: false, error: 'The action must be watch, model, set-secret or delete-secret.' }
  }
}

// ---------------------------------------------------------------------------------------------
// Pages.

export const PAGES = ['threads', 'follow', 'routines', 'channels'] as const
export type Page = (typeof PAGES)[number]

/** The page for a path under /ui, or null. */
export function pageFor(pathname: string): Page | null {
  const rest = pathname.replace(/^\/ui\/?/, '').replace(/\/$/, '')
  if (rest === '') return 'threads'
  return (PAGES as readonly string[]).includes(rest) && rest !== 'threads' ? (rest as Page) : null
}

/** The shell page with its page name filled in. The name is from PAGES, never from the request. */
export function renderPage(shell: string, page: Page) {
  return shell.replaceAll('{{PAGE}}', page)
}

/** Headers for everything under /ui: no framing, no outside scripts, no caching of private data. */
export function uiHeaders(contentType: string): Record<string, string> {
  return {
    'content-type': contentType,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
    'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  }
}

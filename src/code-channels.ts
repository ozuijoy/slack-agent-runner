/**
 * The rules for Slack code channels, a BETA Slack feature: a channel bound to one agent session,
 * with tabs the agent writes (an HTML page, a diff, Block Kit) and a session status. Slack's methods
 * are `agents.conversations.*` and `agents.sessions.*`, scope `code_channels:manage`. The door is
 * POST /sandbox/code-channel in src/index.ts, and the sandbox command is `code-channel` in
 * box/tools.mjs.
 *
 * 1. A CLOSED ACTION SET. create, post, view, status, archive and summary, nothing else. There is
 *    no delete and no kick; any other action is refused by name.
 * 2. THE ORIGIN IS THE TOKEN'S THREAD. `create` links the new channel to the thread the turn's
 *    tools token names, never one from the body. `summary` posts into the thread SLACK says the
 *    code channel was opened from, never one the sandbox names.
 * 3. NO CODE CHANNEL FROM A CODE CHANNEL. A turn running in one cannot open another. The calling
 *    channel is read fresh from Slack, and a failed read refuses the create (it fails CLOSED), so a
 *    channel opened from a thread can never open the next one in a loop.
 * 4. THE CONTEXT ROOT NEVER STARTS A TURN. Slack posts a "Context from #origin" message at the top
 *    of a new code channel, as the person who opened it, quoting the origin message, @mention and
 *    all. It is recognised by the block ids Slack stamps on it and skipped (src/index.ts).
 * 5. `post` WRITES ONLY INTO OUR OWN CODE CHANNEL. Slack answers `agents.conversations.listViews`
 *    only for a code channel this app is the agent of, so that is asked first. The other actions
 *    rely on Slack's own agent check.
 * 6. FEATURE OFF IS A FALLBACK, NOT A FAILURE. If Slack says code channels are off (the beta is not
 *    enabled, the method is unknown, the scope was never granted), the thread gets ONE note saying
 *    so, and Claude is told to keep working in the thread.
 * 7. ARCHIVE FROM OUTSIDE. A turn inside the code channel cannot archive it: its own answer would
 *    then post into an archived channel. Archive it from the thread that opened it.
 * 8. ONLY THE OPENER OR A TURN INSIDE TOUCHES IT. The channel in a post, view, status or archive
 *    body is only a request. The door reads that channel from Slack and acts only when Slack's
 *    origin for it is the token's thread, or (not for archive) the turn runs inside the channel.
 *    A failed read refuses, as in rule 3. So a thread elsewhere cannot write into, or archive,
 *    a code channel some other thread (maybe in a private channel) opened.
 */

export type Checked<T> = { ok: true; value: T } | { ok: false; error: string }

export const ACTIONS = ['create', 'post', 'view', 'status', 'archive', 'summary'] as const
export type Action = (typeof ACTIONS)[number]

export const VIEW_TYPES = ['html', 'diff', 'block_kit'] as const
export type ViewType = (typeof VIEW_TYPES)[number]

/** The statuses a turn may set. `closed` comes only with `archive`. */
export const STATUSES = ['processing', 'active', 'suspended'] as const

export const MAX_NAME_CHARS = 80
export const MAX_TEXT_CHARS = 3800
/** Slack holds an html or diff tab to 1 MB. */
export const MAX_VIEW_BYTES = 1024 * 1024
export const MAX_VIEW_NAME_CHARS = 80
export const MAX_BLOCKS = 50

export interface View {
  type: ViewType
  name?: string
  view_key?: string
  content?: string
  blocks?: unknown[]
  base_branch?: string
  head_branch?: string
}

export type CodeChannelAction =
  | { action: 'create'; name: string }
  | { action: 'post'; channel: string; text: string }
  | { action: 'view'; channel: string; view: View }
  | { action: 'status'; channel: string; status: (typeof STATUSES)[number] }
  | { action: 'archive'; channel: string }
  | { action: 'summary'; text: string }

const CHANNEL_ID = /^[CG][A-Z0-9]{2,20}$/
const VIEW_KEY = /^[A-Za-z0-9_-]{1,64}$/
const BRANCH = /^[A-Za-z0-9._/-]{1,200}$/

/** What the sandbox sent (rule 1). Only the named fields are read; a thread or origin is ignored. */
export function checkCodeChannelAction(body: unknown): Checked<CodeChannelAction> {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const action = b.action
  if (typeof action !== 'string' || !(ACTIONS as readonly string[]).includes(action)) {
    return { ok: false, error: `unknown code-channel action ${JSON.stringify(action ?? null)}; the actions are ${ACTIONS.join(', ')}` }
  }
  if (action === 'create') {
    const name = typeof b.name === 'string' ? b.name.trim() : ''
    if (!name) return { ok: false, error: 'create needs a name' }
    if (name.length > MAX_NAME_CHARS) return { ok: false, error: `the name is over ${MAX_NAME_CHARS} characters` }
    return { ok: true, value: { action, name } }
  }
  if (action === 'summary') {
    const text = checkText(b.text)
    return text.ok ? { ok: true, value: { action, text: text.value } } : text
  }
  const channel = b.channel
  if (typeof channel !== 'string' || !CHANNEL_ID.test(channel)) return { ok: false, error: `${action} needs a channel id, such as C0123ABCD` }
  if (action === 'archive') return { ok: true, value: { action, channel } }
  if (action === 'post') {
    const text = checkText(b.text)
    return text.ok ? { ok: true, value: { action, channel, text: text.value } } : text
  }
  if (action === 'status') {
    if (!(STATUSES as readonly unknown[]).includes(b.status)) return { ok: false, error: `status is one of ${STATUSES.join(', ')}` }
    return { ok: true, value: { action, channel, status: b.status as (typeof STATUSES)[number] } }
  }
  const view = checkView(b.view)
  return view.ok ? { ok: true, value: { action: 'view', channel, view: view.value } } : view
}

function checkText(text: unknown): Checked<string> {
  if (typeof text !== 'string' || !text.trim()) return { ok: false, error: 'the text is empty' }
  if (text.length > MAX_TEXT_CHARS) return { ok: false, error: `the text is over ${MAX_TEXT_CHARS} characters` }
  return { ok: true, value: text }
}

/** A tab. Only the fields Slack documents for these types are kept; anything else is dropped. */
export function checkView(input: unknown): Checked<View> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'view needs a tab' }
  const v = input as Record<string, unknown>
  const type = v.type ?? 'html'
  if (!(VIEW_TYPES as readonly unknown[]).includes(type)) return { ok: false, error: `the tab type is one of ${VIEW_TYPES.join(', ')}` }
  const out: View = { type: type as ViewType }
  if (v.name !== undefined) {
    if (typeof v.name !== 'string' || !v.name.trim() || v.name.length > MAX_VIEW_NAME_CHARS) return { ok: false, error: `the tab name is 1 to ${MAX_VIEW_NAME_CHARS} characters` }
    out.name = v.name.trim()
  }
  if (v.view_key !== undefined) {
    if (typeof v.view_key !== 'string' || !VIEW_KEY.test(v.view_key)) return { ok: false, error: 'the tab key is letters, digits, - and _ (64 at most)' }
    out.view_key = v.view_key
  }
  if (out.type === 'block_kit') {
    if (!Array.isArray(v.blocks) || !v.blocks.length) return { ok: false, error: 'a block_kit tab needs a JSON array of blocks' }
    if (v.blocks.length > MAX_BLOCKS) return { ok: false, error: `a block_kit tab holds ${MAX_BLOCKS} blocks at most` }
    out.blocks = v.blocks
    return { ok: true, value: out }
  }
  if (typeof v.content !== 'string' || !v.content) return { ok: false, error: `a ${out.type} tab needs content` }
  if (new TextEncoder().encode(v.content).byteLength > MAX_VIEW_BYTES) return { ok: false, error: 'the tab content is over 1 MB' }
  out.content = v.content
  if (out.type === 'diff') {
    for (const key of ['base_branch', 'head_branch'] as const) {
      if (v[key] === undefined) continue
      if (typeof v[key] !== 'string' || !BRANCH.test(v[key] as string)) return { ok: false, error: `${key} is not a branch name` }
      out[key] = v[key] as string
    }
  }
  return { ok: true, value: out }
}

// ---------------------------------------------------------------------------------------------
// What Slack says about a channel.

/** A DM (D…) is never a code channel, so it is never asked about. */
export function canBeCodeChannel(channel: string): boolean {
  return CHANNEL_ID.test(channel)
}

/** Is this conversations.info channel a code channel? (rule 3) */
export function isCodeChannel(info: Record<string, any> | null | undefined): boolean {
  return info?.properties?.record_channel?.record_type === 'agent_channel'
}

/**
 * The thread a code channel was opened from, from Slack's own record of it (rule 2): the session's
 * origin link, else the `C…-<ts>` tail of the record id. Null when Slack does not say.
 */
export function codeChannelOrigin(info: Record<string, any> | null | undefined): { channel: string; threadTs: string } | null {
  if (!isCodeChannel(info)) return null
  const link = info!.properties?.agent_session?.origin_link
  if (typeof link?.channel_id === 'string' && CHANNEL_ID.test(link.channel_id) && typeof link?.ts === 'string' && /^\d+\.\d+$/.test(link.ts)) {
    return { channel: link.channel_id, threadTs: link.ts }
  }
  const m = /([CG][A-Z0-9]+)-(\d{10}\.\d{6})$/.exec(String(info!.properties?.record_channel?.record_id ?? ''))
  return m ? { channel: m[1], threadTs: m[2] } : null
}

const ORIGIN_BLOCK_PREFIX = 'agent_channel_origin_'

/** Is this event the Context root Slack posts at the top of a new code channel? (rule 4) */
export function isContextRoot(event: { blocks?: unknown } | null | undefined): boolean {
  const blocks = Array.isArray(event?.blocks) ? event!.blocks : []
  return blocks.some((b) => typeof (b as { block_id?: unknown })?.block_id === 'string' && (b as { block_id: string }).block_id.startsWith(ORIGIN_BLOCK_PREFIX))
}

// ---------------------------------------------------------------------------------------------
// Slack's answers.

/** Slack's errors that mean "code channels are off here" (rule 6). */
const FEATURE_OFF = new Set([
  'feature_disabled',
  'feature_not_enabled',
  'not_enabled',
  'team_not_enabled',
  'user_not_enabled',
  'unknown_method',
  'missing_scope',
  'not_allowed_token_type',
])

/** Slack's error code out of a slackApi error message (`slack <method>: <code>`). */
export function slackErrorCode(message: string): string {
  const m = /^slack [\w.]+: (\S+)$/.exec(message.trim())
  return m ? m[1] : message.trim()
}

export function isFeatureOff(code: string): boolean {
  return FEATURE_OFF.has(code)
}

/** The create errors that are about the origin link, not the channel. Each gets one retry without it. */
export const ORIGIN_ERRORS = new Set(['invalid_origin_link', 'origin_channel_externally_shared', 'origin_channel_is_file_channel', 'user_not_enabled'])

/** Slack makes a create idempotent on the session id: the same thread gets the same channel back. */
export function sessionId(channel: string, threadTs: string) {
  return `${channel}-${threadTs}`
}

/** The one note a thread gets when code channels are off (rule 6). */
export function featureOffNote(code: string) {
  return `:information_source: Slack code channels are not turned on for this workspace or app (Slack said \`${code}\`), so I'll keep working here in the thread.`
}

/** What the sandbox is told instead, so Claude does not try again. */
export function featureOffHint(code: string) {
  return `Slack code channels are off here (${code}). Do not try code-channel again in this turn: keep working in this thread and put everything in your reply. The thread has been told once.`
}

/** The line in the calling thread that points people at the new channel. */
export function openedNote(channel: string) {
  return `:thread: Opened code channel <#${channel}> for this thread.`
}

/** The summary as it appears in the origin thread. */
export function summaryText(codeChannel: string, text: string) {
  return `:checkered_flag: *Summary from <#${codeChannel}>*\n${text}`
}

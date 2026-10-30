import {
  canBeCodeChannel,
  codeChannelOrigin,
  featureOffHint,
  featureOffNote,
  isCodeChannel,
  isFeatureOff,
  openedNote,
  ORIGIN_ERRORS,
  sessionId,
  slackErrorCode,
  summaryText,
  type CodeChannelAction,
} from './code-channels.ts'

/**
 * What POST /sandbox/code-channel does with one checked action. The rules are in
 * src/code-channels.ts; this is the Slack side. Slack is reached through `deps`, so the tests can
 * drive every path without Cloudflare. `caller` is the turn's thread, from its tools token only.
 */
export interface CodeChannelDeps {
  /** A Slack Web API call with the bot token; throws `slack <method>: <code>` on an error. */
  slack(method: string, args: Record<string, unknown>): Promise<Record<string, any>>
  /** Posts Markdown into a thread. */
  postInThread(channel: string, threadTs: string, markdown: string): Promise<void>
  /** Posts Markdown at the top level of a channel. */
  postInChannel(channel: string, markdown: string): Promise<void>
  /** True the first time this thread asks for `key` (src/thread.ts rule 10). */
  noteOnce(key: string): Promise<boolean>
}

export interface Caller {
  channel: string
  threadTs: string
  /** Who sent the running turn's newest message. Invited into a channel they open. */
  author?: string
}

export type DoorAnswer = { status: number; body: Record<string, unknown> }

export const FEATURE_OFF_NOTE_KEY = 'code-channels-off'

export async function codeChannelAction(deps: CodeChannelDeps, caller: Caller, action: CodeChannelAction): Promise<DoorAnswer> {
  try {
    switch (action.action) {
      case 'create':
        return await create(deps, caller, action.name)
      case 'post': {
        const refused = await mayTouch(deps, caller, action.channel, true)
        if (refused) return refused
        return await post(deps, action.channel, action.text)
      }
      case 'view': {
        const refused = await mayTouch(deps, caller, action.channel, true)
        if (refused) return refused
        const made = await deps.slack('agents.conversations.setView', { channel_id: action.channel, ...action.view })
        return ok({ channel: action.channel, view_id: made.view_id ?? null, view_key: made.view_key ?? action.view.view_key ?? null })
      }
      case 'status': {
        const refused = await mayTouch(deps, caller, action.channel, true)
        if (refused) return refused
        await deps.slack('agents.sessions.setStatus', { channel_id: action.channel, status: action.status })
        return ok({ channel: action.channel, status: action.status })
      }
      case 'archive':
        return await archive(deps, caller, action.channel)
      case 'summary':
        return await summary(deps, caller, action.text)
    }
  } catch (err) {
    return await slackFailed(deps, caller, (err as Error).message)
  }
}

function ok(body: Record<string, unknown>): DoorAnswer {
  return { status: 200, body: { ok: true, ...body } }
}

function refuse(status: number, error: string, extra: Record<string, unknown> = {}): DoorAnswer {
  return { status, body: { ok: false, error, ...extra } }
}

/**
 * Slack refused. Feature off (rule 6) posts ONE note in the calling thread, ever, and tells Claude
 * to keep working there; anything else hands Slack's own error code back.
 */
async function slackFailed(deps: CodeChannelDeps, caller: Caller, message: string): Promise<DoorAnswer> {
  const code = slackErrorCode(message)
  if (!isFeatureOff(code)) return refuse(502, code)
  try {
    if (await deps.noteOnce(FEATURE_OFF_NOTE_KEY)) await deps.postInThread(caller.channel, caller.threadTs, featureOffNote(code))
  } catch (err) {
    console.warn('could not post the code-channels-off note:', (err as Error).message)
  }
  return refuse(409, code, { fallback: true, hint: featureOffHint(code) })
}

/**
 * Is the caller's channel a code channel? Read fresh from Slack. `null` when Slack cannot say: the
 * caller refuses then (rule 3 fails closed). A DM is never one, and is not asked about.
 */
async function callerIsCodeChannel(deps: CodeChannelDeps, channel: string): Promise<{ yes: boolean; info: Record<string, any> | null } | null> {
  if (!canBeCodeChannel(channel)) return { yes: false, info: null }
  try {
    const json = await deps.slack('conversations.info', { channel })
    const info = (json.channel as Record<string, any> | undefined) ?? null
    return { yes: isCodeChannel(info), info }
  } catch (err) {
    console.warn(`code-channel: could not read ${channel}:`, (err as Error).message)
    return null
  }
}

/**
 * Rule 8: the channel named in the body is only a request. A turn may act on a code channel only
 * from the thread Slack says opened it, or (when `insideOk`) from a turn running inside that
 * channel. Both sides come from the token and from Slack, never the body. Returns the refusal, or
 * null to go on. An unreadable channel refuses (fails closed, as create does).
 */
async function mayTouch(deps: CodeChannelDeps, caller: Caller, channel: string, insideOk: boolean): Promise<DoorAnswer | null> {
  if (insideOk && channel === caller.channel) return null
  const there = await callerIsCodeChannel(deps, channel)
  if (!there) return refuse(503, 'code_channel_lookup_failed', { hint: 'Slack could not say what that channel is. Try again in a minute.' })
  if (!there.yes) return refuse(403, 'not_a_code_channel', { hint: `${channel} is not a code channel.` })
  const origin = codeChannelOrigin(there.info)
  if (!origin || origin.channel !== caller.channel || origin.threadTs !== caller.threadTs) {
    console.log(`code-channel: refused ${caller.channel}/${caller.threadTs} acting on ${channel} (opened from ${origin ? `${origin.channel}/${origin.threadTs}` : 'unknown'})`)
    return refuse(403, 'not_your_code_channel', { hint: 'Only the thread that opened a code channel, or a turn inside it, can act on it.' })
  }
  return null
}

async function create(deps: CodeChannelDeps, caller: Caller, name: string): Promise<DoorAnswer> {
  // Rule 3: never from inside a code channel, and never on a guess.
  const here = await callerIsCodeChannel(deps, caller.channel)
  if (!here) return refuse(503, 'code_channel_lookup_failed', { hint: 'Slack could not say what this channel is. Try again in a minute.' })
  if (here.yes) {
    console.log(`code-channel: refused a nested create from ${caller.channel}`)
    return refuse(403, 'code_channel_nested', { hint: 'This turn runs in a code channel already; work here instead.' })
  }

  // Rule 2: the origin is the token's thread. Slack is idempotent on the session id.
  const base = { name, session_id: sessionId(caller.channel, caller.threadTs) }
  let made: Record<string, any>
  let originError: string | undefined
  try {
    made = await deps.slack('agents.conversations.create', { ...base, origin_channel_id: caller.channel, origin_message_ts: caller.threadTs })
  } catch (err) {
    const code = slackErrorCode((err as Error).message)
    if (!ORIGIN_ERRORS.has(code)) throw err
    // The channel is still worth having; it just will not point back at this thread.
    originError = code
    made = await deps.slack('agents.conversations.create', base)
  }
  const channel = (made.channel_id ?? made.channel?.id) as unknown
  if (typeof channel !== 'string' || !canBeCodeChannel(channel)) return refuse(502, 'slack gave no channel id')

  // The person who asked is let in, so they can see it. Best effort: the channel exists either way.
  let invited = false
  if (caller.author) {
    try {
      await deps.slack('conversations.invite', { channel, users: caller.author })
      invited = true
    } catch (err) {
      const code = slackErrorCode((err as Error).message)
      invited = code === 'already_in_channel' || code === 'cant_invite_self'
      if (!invited) console.warn(`code-channel: could not invite ${caller.author} into ${channel}: ${code}`)
    }
  }
  await deps.postInThread(caller.channel, caller.threadTs, openedNote(channel)).catch((err) => console.warn('could not post the opened note:', err.message))
  console.log(`code-channel: made ${channel} from ${caller.channel}/${caller.threadTs}`)
  return ok({ channel, originLinked: !originError, ...(originError ? { originError } : {}), invited })
}

/** Rule 5: only into a code channel this app is the agent of. */
async function post(deps: CodeChannelDeps, channel: string, text: string): Promise<DoorAnswer> {
  try {
    await deps.slack('agents.conversations.listViews', { channel_id: channel })
  } catch (err) {
    const code = slackErrorCode((err as Error).message)
    if (isFeatureOff(code)) throw err
    return refuse(403, 'not_your_code_channel', { reason: code })
  }
  await deps.postInChannel(channel, text)
  return ok({ channel })
}

/** Rule 7: only from the thread that opened it (rule 8). The session is closed first, so Slack shows it done. */
async function archive(deps: CodeChannelDeps, caller: Caller, channel: string): Promise<DoorAnswer> {
  if (channel === caller.channel) {
    return refuse(403, 'archive_from_inside', { hint: 'Your answer would post into an archived channel. Archive it from the thread that opened it.' })
  }
  const refused = await mayTouch(deps, caller, channel, false)
  if (refused) return refused
  await deps.slack('agents.sessions.setStatus', { channel_id: channel, status: 'closed' }).catch((err) => {
    // Archive is what was asked; a status that did not stick does not stop it, unless it was off.
    if (isFeatureOff(slackErrorCode(err.message))) throw err
    console.warn(`code-channel: could not close the session of ${channel}:`, err.message)
  })
  await deps.slack('agents.conversations.archive', { channel_id: channel })
  return ok({ channel })
}

/** Rule 2: from inside a code channel, into the thread Slack says it was opened from. */
async function summary(deps: CodeChannelDeps, caller: Caller, text: string): Promise<DoorAnswer> {
  const here = await callerIsCodeChannel(deps, caller.channel)
  if (!here) return refuse(503, 'code_channel_lookup_failed', { hint: 'Slack could not say what this channel is. Try again in a minute.' })
  if (!here.yes) return refuse(403, 'not_in_a_code_channel', { hint: 'summary runs only in a turn inside a code channel; this thread is a normal one.' })
  try {
    await deps.slack('agents.conversations.listViews', { channel_id: caller.channel })
  } catch (err) {
    const code = slackErrorCode((err as Error).message)
    if (isFeatureOff(code)) throw err
    return refuse(403, 'not_your_code_channel', { reason: code })
  }
  const origin = codeChannelOrigin(here.info)
  if (!origin) return refuse(409, 'no_origin_thread', { hint: 'Slack does not say which thread opened this channel.' })
  await deps.postInThread(origin.channel, origin.threadTs, summaryText(caller.channel, text))
  return ok({ channel: caller.channel, origin })
}

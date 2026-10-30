/**
 * The rules for one Slack thread, as plain functions over plain data so they can be tested
 * without Cloudflare. src/thread-state.ts stores the data and calls these.
 *
 * These rules hold here:
 *
 * 1. ONE TURN AT A TIME. Two `claude --resume` runs on one session write into the same transcript
 *    and break it for good. A message that arrives while a turn runs waits in `pending`, and the
 *    next turn takes every waiting message at once.
 * 2. EACH SLACK MESSAGE RUNS ONCE. Slack sends a mention twice (as `app_mention` and as `message`)
 *    and retries anything we answer slowly, so messages are deduped by their `ts`.
 * 3. A THREAD STARTS WITH A MENTION, or with a root message in a watched channel (src/channels.ts).
 *    After that, every reply in the thread goes to the bot, with or without a mention.
 * 4. NO TURN STARTS WHILE THE SANDBOX IS BEING PAUSED. A pause request that lands after a turn
 *    started would freeze that turn mid-run, so messages wait until the pause is done.
 * 5. A MODEL PICK IS NOT A TURN. `!model sonnet` sets the thread's model and gets a short reply;
 *    it never starts Claude. A running turn keeps its model; the pick applies from the next turn.
 * 6. STOP IS A REQUEST, NOT A RELEASE. The Stop button only marks the running turn; the sandbox
 *    sees the mark on its next progress report, ends Claude and reports back, and THAT frees the
 *    thread. Freeing it at the click would let the next turn `--resume` the session while the
 *    stopped Claude may still be writing to it (rule 1).
 * 7. A FOLLOW-UP CAN JOIN THE RUNNING TURN, AND IS NEVER LOST. A plain follow-up (no files, the
 *    same model, nothing queued before it, no Stop pressed) goes into the running turn's `inbox`
 *    instead of `pending`. The sandbox fetches it on its next progress report and Claude reads it at
 *    its next tool step (box/inbox.mjs). It counts as answered ONLY when the sandbox says Claude
 *    took it AND the turn ended with an answer. Every other case (not taken in time, the turn
 *    failed, was stopped or was lost) puts it back in `pending`, so it runs as the next turn. A
 *    race can cost a second answer; it can never cost a message.
 * 8. SEARCH USES THE TURN'S NEWEST ACTION TOKEN. Slack lets the bot search only with the
 *    `action_token` from an @mention or DM event, and it expires soon after. The running turn keeps
 *    the newest one its messages or follow-ups carried; the search door reads it, nothing else.
 * 9. THE CHANNEL'S DEFAULT MODEL IS READ AS MESSAGES ARRIVE. The thread keeps the default the
 *    newest message came with, and a turn's model is fixed from it when the turn starts (rule 5):
 *    the thread's own `!model` pick, then that default, then opus. A message whose channel settings
 *    could not be read leaves the remembered default alone.
 * 10. A THREAD IS TOLD SOMETHING ONCE. A note keyed in `notes` (say, "code channels are off here",
 *    src/code-channels.ts rule 6) is posted the first time only, however many turns ask for it.
 */

import type { SlackFileRef } from './files.ts'
import { describeModel, modelChoices, resolveModel, type ModelAlias, type ModelCommand } from './models.ts'

export interface SlackMessage {
  ts: string
  user: string
  text: string
  /** The message carries files. It always waits for a turn of its own (rule 7). */
  hasFiles?: boolean
  /** The files, for the turn to download (src/files.ts). */
  files?: SlackFileRef[]
  /**
   * Slack's short-lived search permission from this message's event (src/search.ts). Kept by the
   * Worker; it never goes into a prompt or a sandbox.
   */
  actionToken?: string
}

export interface Turn {
  turnId: string
  messages: SlackMessage[]
  /** True for the first turn in a thread: the prompt then includes the earlier thread messages. */
  firstTurn: boolean
  /** When the thread started this turn. The turn's time limit counts from here, everywhere. */
  startedAt: number
  /** The model this turn runs on, fixed when the turn starts (rule 5). */
  model: ModelAlias
}

export interface ThreadData {
  channel: string
  threadTs: string
  /** The Worker's own address, so a sandbox started from a queue job knows where to report back. */
  origin: string
  known: boolean
  seen: string[]
  running: RunningTurn | null
  pending: SlackMessage[]
  lastActivityAt: number
  /** Set once the idle pause has been sent, so the alarm does not send it twice. */
  parked: boolean
  /** Set while a pause call is in flight (rule 4). */
  pausing: boolean
  /** The thread's `!model` pick. Unset means the channel's default (rule 9). */
  model?: ModelAlias
  /** The channel's default model, as of the newest message (rule 9). Unset means opus. */
  channelModel?: ModelAlias
  /**
   * Set when a `!model` message made the thread ours before any turn ran, so the first real turn
   * still reads the earlier messages. Cleared once a turn finishes.
   */
  historyUnread?: boolean
  /** The once-only notes this thread has been given (rule 10). */
  notes?: string[]
}

export interface RunningTurn {
  turnId: string
  startedAt: number
  /** The live status message (src/status.ts), once the turn's job has posted it. */
  statusTs?: string
  /** Who pressed Stop, once someone has (rule 6). */
  stopRequestedBy?: string
  /** The model the turn runs on. A follow-up joins it only on the same model (rule 7). */
  model?: ModelAlias
  /** Follow-ups handed to this turn while it runs (rule 7), oldest first. */
  inbox?: SlackMessage[]
  /** The newest search permission among the turn's messages and follow-ups (rule 8). */
  actionToken?: string
  /** Who sent the turn's newest message: a routine made in this turn is theirs (src/routines.ts). */
  author?: string
}

/** How many message ids to remember for dedupe. Slack retries within minutes, not days. */
const SEEN_LIMIT = 200

/** Time for a finished turn's reply to reach us before the turn counts as lost. */
export const LOST_TURN_MARGIN_MS = 5 * 60_000

type Clock = { now: number; newTurnId: () => string }

/**
 * What the events route read from the channel's settings for this message (rule 9). `undefined`
 * means it could not read them, and the thread keeps what it had; `null` means no default.
 */
export type ChannelModel = ModelAlias | null | undefined

function noteChannelModel(data: ThreadData, channelModel: ChannelModel) {
  if (channelModel === undefined) return
  if (channelModel === null) delete data.channelModel
  else data.channelModel = channelModel
}

/** The model the thread's next turn runs on (rules 5 and 9). */
export function threadModel(data: ThreadData): ModelAlias {
  return resolveModel(data.model, data.channelModel)
}

export function emptyThread(channel: string, threadTs: string, origin: string): ThreadData {
  return {
    channel,
    threadTs,
    origin,
    known: false,
    seen: [],
    running: null,
    pending: [],
    lastActivityAt: 0,
    parked: true,
    pausing: false,
  }
}

export type AcceptResult =
  | { action: 'skip'; reason: string }
  | { action: 'queued' }
  | { action: 'midturn' }
  | { action: 'start'; turn: Turn }

export function accept(data: ThreadData, msg: SlackMessage, opts: Clock & { mention: boolean; channelModel?: ChannelModel }): AcceptResult {
  if (!data.known && !opts.mention) return { action: 'skip', reason: 'not-our-thread' }
  if (data.seen.includes(msg.ts)) return { action: 'skip', reason: 'duplicate' }

  remember(data, msg.ts)
  noteChannelModel(data, opts.channelModel)
  data.lastActivityAt = opts.now
  const firstTurn = !data.known || data.historyUnread === true
  data.known = true

  if (data.running && canJoinRunningTurn(data, msg)) {
    data.running.inbox = [...(data.running.inbox ?? []), msg]
    if (msg.actionToken) data.running.actionToken = msg.actionToken
    return { action: 'midturn' }
  }
  if (data.running || data.pausing) {
    data.pending.push(msg)
    return { action: 'queued' }
  }
  return { action: 'start', turn: begin(data, [msg], firstTurn, opts) }
}

/**
 * Rule 7: may this follow-up go into the running turn? Files need a turn of their own (they are
 * fetched when a turn starts), a Stop means the turn is ending, a message queued earlier must not
 * be overtaken, and a `!model` change since the turn started applies from the next turn.
 */
export function canJoinRunningTurn(data: ThreadData, msg: SlackMessage): boolean {
  const running = data.running
  if (!running || running.stopRequestedBy || msg.hasFiles) return false
  if (data.pending.length) return false
  return running.model !== undefined && running.model === threadModel(data)
}

export type ModelCommandResult = { action: 'skip'; reason: string } | { action: 'reply'; text: string }

/**
 * A `!model` message (rule 5). It follows rules 2 and 3 like any message: deduped, and only in a
 * thread that is ours or starts with a mention. It marks the thread as ours, so later replies reach
 * the bot, but it does not use up the first turn: that one still reads the earlier messages.
 */
export function applyModelCommand(
  data: ThreadData,
  msg: SlackMessage,
  command: ModelCommand,
  opts: { now: number; mention: boolean; channelModel?: ChannelModel },
): ModelCommandResult {
  if (!data.known && !opts.mention) return { action: 'skip', reason: 'not-our-thread' }
  if (data.seen.includes(msg.ts)) return { action: 'skip', reason: 'duplicate' }
  remember(data, msg.ts)
  noteChannelModel(data, opts.channelModel)
  data.lastActivityAt = opts.now
  if (!data.known) {
    data.known = true
    data.historyUnread = true
  }

  if (command.kind === 'unknown') {
    return { action: 'reply', text: `I don't know the model \`${command.given.replaceAll('`', '')}\`. Pick one of ${modelChoices()}.` }
  }
  if (command.kind === 'show') {
    const source = data.model ? '' : data.channelModel ? ", the channel's default" : ''
    return { action: 'reply', text: `This thread uses ${describeModel(threadModel(data))}${source}. Change it with \`!model <name>\` (${modelChoices()}).` }
  }
  data.model = command.alias
  const when = data.running ? ' from the next turn (the one running now keeps its model)' : ''
  return { action: 'reply', text: `This thread now uses ${describeModel(command.alias)}${when}.` }
}

/**
 * The job for a turn could not be queued. Undo the start so Slack's retry of the same event is
 * not dropped as a duplicate. Follow-ups that joined the turn while its job was being queued
 * (rule 7) already have their 📨 and stay in `seen`, so Slack's retry of them is skipped: they go
 * back in line instead, and the alarm runs them if no retry starts a turn first.
 */
export function abortStart(data: ThreadData, turn: Turn) {
  if (data.running?.turnId !== turn.turnId) return
  const inbox = data.running.inbox ?? []
  data.running = null
  const ids = new Set(turn.messages.map((m) => m.ts))
  data.seen = data.seen.filter((ts) => !ids.has(ts))
  data.pending.unshift(...inbox)
  if (!turn.firstTurn) return
  // The thread stays ours if a `!model` message made it ours, or a follow-up is waiting; either
  // way the first turn is still to come, so it still reads the history.
  if (inbox.length) data.historyUnread = true
  else if (!data.historyUnread) data.known = false
}

/**
 * The next turn's job could not be queued. Put its messages back; the alarm tries again.
 */
export function requeue(data: ThreadData, turn: Turn) {
  if (data.running?.turnId !== turn.turnId) return
  const { inbox } = data.running
  data.running = null
  data.pending.unshift(...turn.messages, ...(inbox ?? []))
}

export type FinishResult =
  | { accepted: false }
  | {
      accepted: true
      next: Turn | null
      statusTs?: string
      stoppedBy?: string
      /** Follow-ups this turn read and answered (rule 7): they get a ✅ and no turn of their own. */
      folded: SlackMessage[]
    }

/** How a turn ended. `taken` is the ts of every follow-up the sandbox says Claude read. */
export interface Outcome {
  answered: boolean
  taken?: string[]
}

/**
 * The turn is over (answer delivered or start failed). Returns the next turn if messages waited,
 * and the finished turn's status message, Stop and folded follow-ups, for the caller to tidy up.
 * Follow-ups the turn did not both read and answer go back in line first (rule 7).
 */
export function finish(data: ThreadData, turnId: string, opts: Clock & Partial<Outcome>): FinishResult {
  const running = data.running
  if (running?.turnId !== turnId) return { accepted: false }
  data.running = null
  data.historyUnread = undefined
  data.lastActivityAt = opts.now
  const { folded, returned } = settleInbox(running.inbox ?? [], { answered: opts.answered ?? false, taken: opts.taken })
  data.pending.unshift(...returned)
  return { accepted: true, next: takePending(data, opts), statusTs: running.statusTs, stoppedBy: running.stopRequestedBy, folded }
}

/**
 * Rule 7 in one place: which follow-ups a finished turn answered, and which go back in line. Only
 * ts the turn was actually handed count, whatever the sandbox claims.
 */
export function settleInbox(inbox: SlackMessage[], outcome: Outcome): { folded: SlackMessage[]; returned: SlackMessage[] } {
  if (!outcome.answered) return { folded: [], returned: [...inbox] }
  const taken = new Set(outcome.taken ?? [])
  return { folded: inbox.filter((m) => taken.has(m.ts)), returned: inbox.filter((m) => !taken.has(m.ts)) }
}

/**
 * Remembers the running turn's status message. False when the turn is no longer running (it
 * finished or was given up on while the message was being posted), so the caller deletes it.
 */
export function setStatus(data: ThreadData, turnId: string, statusTs: string): boolean {
  if (data.running?.turnId !== turnId) return false
  data.running.statusTs = statusTs
  return true
}

export type StopResult = { action: 'stopping' } | { action: 'already-stopping' } | { action: 'not-running' }

/** Someone pressed Stop on `turnId` (rule 6). Only the turn running now can be stopped. */
export function requestStop(data: ThreadData, turnId: string, user: string): StopResult {
  if (data.running?.turnId !== turnId) return { action: 'not-running' }
  if (data.running.stopRequestedBy) return { action: 'already-stopping' }
  data.running.stopRequestedBy = user
  return { action: 'stopping' }
}

export type ProgressView =
  | { running: false }
  | { running: true; startedAt: number; statusTs?: string; stop: boolean; inbox: SlackMessage[] }

/**
 * What a progress report from the sandbox needs: is the turn still on, should it stop, and the
 * follow-ups handed to it so far (rule 7). The whole inbox every time: the sandbox skips the ones
 * it already has, so a lost answer costs a delay, never a message.
 */
export function progressView(data: ThreadData | undefined, turnId: string): ProgressView {
  if (data?.running?.turnId !== turnId) return { running: false }
  const { startedAt, statusTs, stopRequestedBy, inbox } = data.running
  return { running: true, startedAt, statusTs, stop: Boolean(stopRequestedBy), inbox: stopRequestedBy ? [] : (inbox ?? []) }
}

/**
 * What the search door needs (rule 8): is `turnId` the turn running now, and the search permission
 * it holds, if any. A finished turn's sandbox gets nothing, so a late call cannot search.
 */
export function searchView(data: ThreadData | undefined, turnId: string): { running: false } | { running: true; actionToken?: string } {
  if (data?.running?.turnId !== turnId) return { running: false }
  const { actionToken } = data.running
  return actionToken ? { running: true, actionToken } : { running: true }
}

/**
 * Rule 10: true the first time `key` is asked for, when the caller posts the note; false after.
 * Only a running turn can ask, so a stale sandbox cannot post into the thread.
 */
export function noteOnce(data: ThreadData | undefined, turnId: string, key: string): boolean {
  if (!data || data.running?.turnId !== turnId) return false
  if (data.notes?.includes(key)) return false
  data.notes = [...(data.notes ?? []), key]
  return true
}

/** Read-only: is the turn still running, and who asked for it (src/routines.ts rule 1). */
export function authorView(data: ThreadData | undefined, turnId: string): { running: false } | { running: true; author?: string } {
  if (data?.running?.turnId !== turnId) return { running: false }
  const { author } = data.running
  return author ? { running: true, author } : { running: true }
}

/**
 * A routine's run (src/routines.ts rule 2): the bot posted a new root message and this is its
 * thread. It starts like a mention, on the routine's model if it has one, else the channel's.
 */
export function acceptRoutineRun(
  data: ThreadData,
  msg: SlackMessage,
  opts: Clock & { model?: ModelAlias | null; channelModel?: ChannelModel },
): AcceptResult {
  if (opts.model && !data.known) data.model = opts.model
  return accept(data, msg, { ...opts, mention: true })
}

export type AlarmResult =
  | { action: 'none' }
  | { action: 'wait'; until: number }
  | { action: 'pause' }
  | { action: 'start'; next: Turn }
  | { action: 'stale'; lostTurnId: string; lostStatusTs?: string; next: Turn | null }

/**
 * What the thread's alarm should do now.
 *
 * - A turn that ran past its limit (plus a margin for the reply to arrive) is treated as lost: its
 *   sandbox died or its callback never came. The thread is freed so it does not stay stuck forever.
 * - Messages waiting with no turn running (a queue send failed) start a turn.
 * - A quiet thread whose sandbox is still awake is paused.
 */
export function onAlarm(data: ThreadData, opts: Clock & { maxTurnMs: number; idlePauseMs: number }): AlarmResult {
  if (data.running) {
    const deadline = data.running.startedAt + opts.maxTurnMs + LOST_TURN_MARGIN_MS
    if (opts.now < deadline) return { action: 'wait', until: deadline }
    const { turnId: lostTurnId, statusTs: lostStatusTs, inbox } = data.running
    data.running = null
    data.lastActivityAt = opts.now
    // A lost turn answered nothing, so its follow-ups run next (rule 7).
    data.pending.unshift(...(inbox ?? []))
    return { action: 'stale', lostTurnId, lostStatusTs, next: takePending(data, opts) }
  }
  if (data.pausing) return { action: 'none' }
  const next = takePending(data, opts)
  if (next) return { action: 'start', next }
  if (data.parked) return { action: 'none' }
  const quietAt = data.lastActivityAt + opts.idlePauseMs
  if (opts.now < quietAt) return { action: 'wait', until: quietAt }
  data.pausing = true
  return { action: 'pause' }
}

/** The pause call returned. Starts the turn for any messages that arrived while it ran. */
export function afterPause(data: ThreadData, opts: Clock & { paused: boolean }): Turn | null {
  data.pausing = false
  if (opts.paused && !data.pending.length) data.parked = true
  return takePending(data, opts)
}

function remember(data: ThreadData, ts: string) {
  data.seen.push(ts)
  if (data.seen.length > SEEN_LIMIT) data.seen.splice(0, data.seen.length - SEEN_LIMIT)
}

function takePending(data: ThreadData, opts: Clock): Turn | null {
  if (!data.pending.length) return null
  const messages = data.pending.splice(0)
  return begin(data, messages, data.historyUnread === true, opts)
}

function begin(data: ThreadData, messages: SlackMessage[], firstTurn: boolean, opts: Clock): Turn {
  const turnId = opts.newTurnId()
  const model = threadModel(data)
  const actionToken = messages.findLast((m) => m.actionToken)?.actionToken
  const author = messages.at(-1)?.user
  data.running = { turnId, startedAt: opts.now, model, ...(actionToken ? { actionToken } : {}), ...(author ? { author } : {}) }
  data.parked = false
  return { turnId, messages, firstTurn, startedAt: opts.now, model }
}

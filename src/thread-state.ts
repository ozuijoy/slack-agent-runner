import { DurableObject } from 'cloudflare:workers'
import { idlePauseMs, maxTurnMs, type Env } from './env.ts'
import { pauseThreadSandbox } from './sandbox.ts'
import { deleteMessage, postInThread } from './slack.ts'
import {
  abortStart,
  accept,
  acceptRoutineRun,
  authorView,
  afterPause,
  applyModelCommand,
  emptyThread,
  finish,
  noteOnce,
  LOST_TURN_MARGIN_MS,
  onAlarm,
  progressView,
  requeue,
  requestStop,
  searchView,
  setStatus,
  type AcceptResult,
  type ChannelModel,
  type FinishResult,
  type ModelCommandResult,
  type Outcome,
  type ProgressView,
  type SlackMessage,
  type StopResult,
  type ThreadData,
  type Turn,
} from './thread.ts'
import type { ModelAlias, ModelCommand } from './models.ts'
import { enqueueTurn } from './turn.ts'
import { appendLive, type LiveEntry, type LiveLog, type LiveView } from './live.ts'

/** How soon the alarm retries a turn whose job could not be queued. */
const REQUEUE_DELAY_MS = 10_000

/**
 * One Durable Object per Slack thread (named `channel:threadTs`). The rules live in src/thread.ts;
 * this class loads the thread, applies a rule, and saves it.
 *
 * A Durable Object runs one call at a time ONLY between awaits on the network: while it waits on a
 * fetch, other calls run. So every method saves its changes before it calls out, and reloads the
 * thread after, never writing back a copy it loaded earlier.
 *
 * Its one alarm pauses the sandbox once the thread goes quiet, frees a thread whose turn never
 * reported back, and retries a turn whose job could not be queued.
 */
export class ThreadState extends DurableObject<Env> {
  async accept(channel: string, threadTs: string, origin: string, msg: SlackMessage, mention: boolean, channelModel?: ChannelModel): Promise<AcceptResult> {
    const data = await this.load(channel, threadTs, origin)
    data.origin = origin
    const result = accept(data, msg, { mention, channelModel, ...this.clock() })
    if (result.action !== 'skip') await this.save(data)
    if (result.action === 'start') await this.armAlarm(data)
    return result
  }

  /** A routine's run: the first message of a thread the bot just posted (src/routine-fire.ts). */
  async acceptRoutineRun(
    channel: string,
    threadTs: string,
    origin: string,
    msg: SlackMessage,
    model: ModelAlias | null,
    channelModel?: ChannelModel,
  ): Promise<AcceptResult> {
    const data = await this.load(channel, threadTs, origin)
    data.origin = origin
    const result = acceptRoutineRun(data, msg, { model, channelModel, ...this.clock() })
    if (result.action !== 'skip') await this.save(data)
    if (result.action === 'start') await this.armAlarm(data)
    return result
  }

  /** A `!model` message. Never starts a turn; the caller posts the reply. */
  async modelCommand(
    channel: string,
    threadTs: string,
    origin: string,
    msg: SlackMessage,
    command: ModelCommand,
    mention: boolean,
    channelModel?: ChannelModel,
  ): Promise<ModelCommandResult> {
    const data = await this.load(channel, threadTs, origin)
    const result = applyModelCommand(data, msg, command, { mention, channelModel, now: Date.now() })
    if (result.action !== 'skip') await this.save(data)
    return result
  }

  /** The events route could not queue the turn: undo it so Slack's retry runs it. */
  async abortStart(turn: Turn) {
    const data = await this.ctx.storage.get<ThreadData>('thread')
    if (!data) return
    abortStart(data, turn)
    await this.save(data)
    // Follow-ups returned to pending need the alarm to run them.
    await this.armAlarm(data)
  }

  /**
   * The turn is over. Starts the next turn if messages waited for this one, including follow-ups
   * the turn was handed but did not both read and answer (rule 7).
   */
  async finish(turnId: string, outcome: Outcome = { answered: false }): Promise<FinishResult> {
    const data = await this.ctx.storage.get<ThreadData>('thread')
    if (!data) return { accepted: false }
    const result = finish(data, turnId, { ...outcome, ...this.clock() })
    if (!result.accepted) return result
    await this.save(data)
    if (result.next) await this.start(result.next)
    await this.armAlarm((await this.ctx.storage.get<ThreadData>('thread'))!)
    return result
  }

  /** The running turn's status message, if its job already posted one (a retried job reuses it). */
  async statusOf(turnId: string): Promise<string | null> {
    const data = await this.ctx.storage.get<ThreadData>('thread')
    return data?.running?.turnId === turnId ? (data.running.statusTs ?? null) : null
  }

  /** Remembers the status message. False means the turn is over and the caller deletes it. */
  async setStatus(turnId: string, statusTs: string): Promise<boolean> {
    const data = await this.ctx.storage.get<ThreadData>('thread')
    if (!data || !setStatus(data, turnId, statusTs)) return false
    await this.save(data)
    return true
  }

  /** The Stop button (rule 6). Marks the turn; the sandbox ends it on its next progress report. */
  async requestStop(turnId: string, user: string): Promise<StopResult> {
    const data = await this.ctx.storage.get<ThreadData>('thread')
    if (!data) return { action: 'not-running' }
    const result = requestStop(data, turnId, user)
    if (result.action === 'stopping') await this.save(data)
    return result
  }

  /** Read-only: what a progress report from the sandbox needs, follow-ups for the turn included. */
  async progress(turnId: string): Promise<ProgressView> {
    return progressView(await this.ctx.storage.get<ThreadData>('thread'), turnId)
  }

  /** Read-only: the running turn's search permission, for the search door (rule 8). */
  async searchView(turnId: string) {
    return searchView(await this.ctx.storage.get<ThreadData>('thread'), turnId)
  }

  /** Read-only: whether the turn runs, and who asked for it, for the routines door. */
  async authorView(turnId: string) {
    return authorView(await this.ctx.storage.get<ThreadData>('thread'), turnId)
  }

  /**
   * The live turn's log for the web UI (src/live.ts). Kept only for the turn running now (rule 1),
   * under its own key so a long log never weighs on the thread record. No I/O between the read and
   * the write.
   */
  async appendLive(turnId: string, entries: LiveEntry[]): Promise<boolean> {
    const data = await this.ctx.storage.get<ThreadData>('thread')
    if (!data?.running || data.running.turnId !== turnId || !entries.length) return false
    const log = await this.ctx.storage.get<LiveLog>('live')
    await this.ctx.storage.put('live', appendLive(log, turnId, data.running.startedAt, entries))
    return true
  }

  /** Read-only: the running turn and the newest log, for the transcript page. */
  async liveView(): Promise<LiveView> {
    const data = await this.ctx.storage.get<ThreadData>('thread')
    const log = (await this.ctx.storage.get<LiveLog>('live')) ?? null
    const r = data?.running
    return {
      running: r ? { turnId: r.turnId, startedAt: r.startedAt, ...(r.model ? { model: r.model } : {}), stopping: Boolean(r.stopRequestedBy) } : null,
      log,
    }
  }

  /** Rule 10: true once per key per thread, saved before the caller posts the note. */
  async noteOnce(turnId: string, key: string): Promise<boolean> {
    const data = await this.ctx.storage.get<ThreadData>('thread')
    if (!noteOnce(data, turnId, key)) return false
    await this.save(data!)
    return true
  }

  async alarm() {
    const data = await this.ctx.storage.get<ThreadData>('thread')
    if (!data) return
    const result = onAlarm(data, { maxTurnMs: maxTurnMs(this.env), idlePauseMs: idlePauseMs(this.env), ...this.clock() })

    switch (result.action) {
      case 'none':
        return
      case 'wait':
        await this.ctx.storage.setAlarm(result.until)
        return
      case 'start':
        await this.save(data)
        await this.start(result.next)
        break
      case 'stale':
        await this.save(data)
        console.warn(`turn lost thread=${data.channel}:${data.threadTs} turn=${result.lostTurnId}`)
        await postInThread(this.env, data.channel, data.threadTs, ':warning: My last run stopped without a reply. Send your message again to retry.').catch(
          (err) => console.error('could not post the lost-turn note:', err),
        )
        if (result.lostStatusTs) await deleteMessage(this.env, data.channel, result.lostStatusTs)
        if (result.next) await this.start(result.next)
        break
      case 'pause': {
        // `pausing` is saved BEFORE the call, so a message that arrives while it runs waits
        // instead of starting a turn the pause would freeze.
        await this.save(data)
        let paused = false
        try {
          await pauseThreadSandbox(this.env, data.channel, data.threadTs)
          paused = true
        } catch (err) {
          console.error(`pause failed for ${data.channel}:${data.threadTs}; retrying in a minute:`, err)
        }
        const fresh = (await this.ctx.storage.get<ThreadData>('thread'))!
        const next = afterPause(fresh, { paused, ...this.clock() })
        await this.save(fresh)
        if (next) await this.start(next)
        // If every retry fails, the sandbox's own timeout pauses it anyway (see src/sandbox.ts),
        // so a thread never loses its history.
        if (!paused && !next) {
          await this.ctx.storage.setAlarm(Date.now() + 60_000)
          return
        }
        break
      }
    }
    await this.armAlarm((await this.ctx.storage.get<ThreadData>('thread'))!)
  }

  /** Queues a turn already saved as running. If the queue refuses, put it back for the alarm. */
  private async start(turn: Turn) {
    try {
      const data = (await this.ctx.storage.get<ThreadData>('thread'))!
      await enqueueTurn(this.env, data, turn)
    } catch (err) {
      console.error(`could not queue turn ${turn.turnId}; retrying from the alarm:`, err)
      const data = (await this.ctx.storage.get<ThreadData>('thread'))!
      requeue(data, turn)
      await this.save(data)
      await this.ctx.storage.setAlarm(Date.now() + REQUEUE_DELAY_MS)
    }
  }

  private async armAlarm(data: ThreadData) {
    if (data.pending.length && !data.running) return this.ctx.storage.setAlarm(Date.now() + REQUEUE_DELAY_MS)
    if (data.parked && !data.running) return
    const at = data.running
      ? data.running.startedAt + maxTurnMs(this.env) + LOST_TURN_MARGIN_MS
      : data.lastActivityAt + idlePauseMs(this.env)
    await this.ctx.storage.setAlarm(at)
  }

  private clock() {
    return { now: Date.now(), newTurnId: () => crypto.randomUUID() }
  }

  private async load(channel: string, threadTs: string, origin: string) {
    return (await this.ctx.storage.get<ThreadData>('thread')) ?? emptyThread(channel, threadTs, origin)
  }

  private async save(data: ThreadData) {
    await this.ctx.storage.put('thread', data)
  }
}

export { threadStub } from './thread-stub.ts'

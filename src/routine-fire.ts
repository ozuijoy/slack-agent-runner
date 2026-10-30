import { channelSettings } from './channel-store.ts'
import type { Env } from './env.ts'
import { isModelAlias } from './models.ts'
import { claimRun, dueRoutines, markRun } from './routine-store.ts'
import { runHeader, runPrompt, type RoutineRow } from './routines.ts'
import { postInThread, slackApi } from './slack.ts'
import { threadStub } from './thread-stub.ts'

/**
 * The Cron Trigger's sweep, every minute: fires each due routine once (src/routines.ts rule 5).
 * One at a time, on purpose: a run is a Slack post and a queue send, so even a long list fits well
 * inside a scheduled run, and an overlapping sweep only finds runs already claimed.
 */
export async function sweepRoutines(env: Env, now = Date.now()) {
  const due = await dueRoutines(env, now)
  for (const routine of due) {
    try {
      const runId = await claimRun(env, routine, now)
      if (runId) await fireRoutine(env, routine, runId)
    } catch (err) {
      // One broken routine must not stop the rest of the sweep.
      console.error(`routine ${routine.id}: sweep failed:`, err)
    }
  }
  if (due.length) console.log(`routine sweep: ${due.length} due`)
}

/**
 * One run (rule 2): a new root message in the routine's channel, and a turn in its thread. The
 * turn goes through the thread's Durable Object like any mention, so it follows every thread rule.
 */
export async function fireRoutine(env: Env, routine: RoutineRow, runId: string) {
  const { channel } = routine
  let threadTs: string
  try {
    const posted = await slackApi(env, 'chat.postMessage', { channel, text: runHeader(routine), unfurl_links: false })
    threadTs = posted.ts as string
  } catch (err) {
    // not_in_channel or channel_not_found: the routine stays, and the run says why.
    const error = (err as Error).message
    console.error(`routine ${routine.id}: could not post its run:`, error)
    await markRun(env, runId, { status: 'failed', error })
    return
  }

  // The channel's default model, unless the routine names its own. A failed read means opus.
  const settings = await channelSettings(env, channel).catch(() => null)
  const msg = { ts: threadTs, user: routine.created_by ?? 'unknown', text: runPrompt(routine) }
  const thread = threadStub(env, channel, threadTs)
  const model = isModelAlias(routine.model) ? routine.model : null
  const result = await thread.acceptRoutineRun(channel, threadTs, routine.origin, msg, model, settings ? settings.model : undefined)
  if (result.action !== 'start') {
    // A brand-new thread always starts; anything else is a bug worth seeing in the runs list.
    await markRun(env, runId, { status: 'failed', threadTs, error: `the thread did not start a turn (${result.action})` })
    return
  }
  try {
    await env.TURNS.send({ channel, threadTs, origin: routine.origin, turn: result.turn })
  } catch (err) {
    await thread.abortStart(result.turn)
    const error = (err as Error).message
    await postInThread(env, channel, threadTs, `:x: This run could not start: ${error}`).catch(() => {})
    await markRun(env, runId, { status: 'failed', threadTs, error })
    return
  }
  await markRun(env, runId, { status: 'started', threadTs })
  console.log(`routine ${routine.id}: run ${runId} started in ${channel}:${threadTs}`)
}

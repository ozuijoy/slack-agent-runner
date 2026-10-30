import { channelSettings } from './channel-store.ts'
import type { Env } from './env.ts'
import { pullsForCommit } from './github.ts'
import { closedNote, planWake, readGithubEvent, stopNote, verifyGithubSignature, wakeNote, wakePrompt } from './pr-follow.ts'
import { activeNumbers, addEvent, claimBatch, dueWakes, endFollow, pendingLines, releaseBatch, type FollowRow } from './pr-follow-store.ts'
import { postMessage } from './slack.ts'
import type { AcceptResult } from './thread.ts'
import { threadStub } from './thread-stub.ts'

/**
 * GitHub's webhook (POST /github/webhook): signature first (rule 2 in src/pr-follow.ts), then the
 * event is read and either ends a follow (posting the note now) or joins a followed PR's batch.
 * Nothing here starts a turn: the every-minute sweep does, once the batch has waited (rule 5). That
 * keeps the answer fast, and GitHub gets a 2xx for anything it does not need to send again.
 */
export async function githubWebhook(request: Request, env: Env): Promise<Response> {
  if (!env.GITHUB_WEBHOOK_SECRET) {
    console.warn('github webhook refused: GITHUB_WEBHOOK_SECRET is not set')
    return new Response('webhook secret not set', { status: 503 })
  }
  const raw = new Uint8Array(await request.arrayBuffer())
  const refused = await verifyGithubSignature(env.GITHUB_WEBHOOK_SECRET, raw, request.headers.get('x-hub-signature-256'))
  if (refused) return new Response(`bad signature (${refused})`, { status: 401 })

  let payload: unknown
  try {
    payload = JSON.parse(new TextDecoder().decode(raw))
  } catch {
    return new Response('bad payload', { status: 400 })
  }
  const event = readGithubEvent(request.headers.get('x-github-event'), payload)
  if (event.kind === 'ignored') return new Response(`ignored: ${event.reason}`)

  if (event.kind === 'closed') {
    const row = await endFollow(env, { repo: event.repo, number: event.pr })
    if (row) {
      await postMessage(env, { channel: row.channel, thread_ts: row.thread_ts, text: closedNote(row, event.line) }).catch((err) =>
        console.error(`pr ${row.repo}#${row.number}: could not post the closed note:`, err),
      )
      console.log(`pr ${row.repo}#${row.number}: ${event.line}, no longer followed`)
    }
    return new Response('ok')
  }

  let prs: number[]
  if (event.kind === 'event-on-commit') {
    // Only asks GitHub when the repo has a followed PR at all.
    const followed = await activeNumbers(env, event.repo)
    if (!followed.length) return new Response('ignored: no followed pr')
    const carrying = await pullsForCommit(env, event.repo, event.sha)
    prs = carrying.filter((n) => followed.includes(n))
  } else {
    prs = event.prs
  }
  let added = 0
  for (const number of prs) if (await addEvent(env, { repo: event.repo, number }, event.line)) added++
  return new Response(added ? 'ok' : 'ignored: not followed')
}

/**
 * The Cron Trigger's other half: wakes the thread of every followed PR whose batch has waited
 * long enough (rule 5), within the daily cap (rule 6). One failure never stops the rest.
 */
export async function sweepPrFollows(env: Env, now = Date.now()) {
  const due = await dueWakes(env, now)
  for (const row of due) {
    try {
      await fireBatch(env, row, now)
    } catch (err) {
      console.error(`pr ${row.repo}#${row.number}: wake failed:`, err)
    }
  }
}

export async function fireBatch(env: Env, row: FollowRow, now: number) {
  const lines = pendingLines(row)
  const plan = planWake(row, now)
  if (!(await claimBatch(env, row, plan.counter, now))) return
  const name = `pr ${row.repo}#${row.number}`
  if (!lines.length || plan.action === 'drop') {
    console.log(`${name}: ${lines.length} event(s) dropped, over today's cap`)
    return
  }

  // Until the thread has the wake, a failure gives the batch back (releaseBatch): a Slack error must
  // not lose a CI failure or a review, nor use up one of the day's wakes.
  let result: AcceptResult
  const thread = threadStub(env, row.channel, row.thread_ts)
  try {
    if (plan.action === 'stop-note') {
      await postMessage(env, { channel: row.channel, thread_ts: row.thread_ts, text: stopNote(row, lines) })
      console.log(`${name}: over today's cap, stop note posted`)
      return
    }
    // The note's ts is the wake's message ts: unique, so the thread's dedupe never drops a wake.
    const ts = await postMessage(env, { channel: row.channel, thread_ts: row.thread_ts, text: wakeNote(row, lines) })
    const settings = await channelSettings(env, row.channel).catch(() => null)
    const msg = { ts, user: row.followed_by ?? 'unknown', text: wakePrompt(row, lines, plan.wakeNumber) }
    // Like a mention: it starts a turn, waits behind the running one, or joins it (src/thread.ts).
    result = await thread.accept(row.channel, row.thread_ts, row.origin, msg, true, settings ? settings.model : undefined)
  } catch (err) {
    await releaseBatch(env, row, plan.counter, lines).catch((e) => console.error(`${name}: could not give the batch back:`, e))
    throw err
  }
  if (result.action === 'start') {
    try {
      await env.TURNS.send({ channel: row.channel, threadTs: row.thread_ts, origin: row.origin, turn: result.turn })
    } catch (err) {
      await thread.abortStart(result.turn)
      const text = ':x: I could not start on that. @mention me to try again.'
      await postMessage(env, { channel: row.channel, thread_ts: row.thread_ts, text }).catch(() => {})
      throw err
    }
  }
  console.log(`${name}: wake ${plan.wakeNumber} (${lines.length} event(s)) -> ${result.action}`)
}

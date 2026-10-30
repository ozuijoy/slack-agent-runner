// I-3: one turn at a time per thread; each Slack message runs once; a thread starts with a mention.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  abortStart,
  accept,
  afterPause,
  applyModelCommand,
  emptyThread,
  finish,
  LOST_TURN_MARGIN_MS,
  onAlarm,
  progressView,
  requestStop,
  requeue,
  setStatus,
  settleInbox,
  type ThreadData,
} from '../src/thread.ts'

function ids() {
  let n = 0
  return () => `turn-${++n}`
}
const msg = (ts: string, text = 'hi') => ({ ts, user: 'U1', text })
const fresh = () => emptyThread('C1', '100.0', 'https://agent.example')

test('a mention starts the first turn', () => {
  const data = fresh()
  const r = accept(data, msg('100.0'), { mention: true, now: 1, newTurnId: ids() })
  assert.equal(r.action, 'start')
  if (r.action === 'start') assert.equal(r.turn.firstTurn, true)
})

test('a reply without a mention in an unknown thread is skipped', () => {
  const data = fresh()
  assert.deepEqual(accept(data, msg('101.0'), { mention: false, now: 1, newTurnId: ids() }), {
    action: 'skip',
    reason: 'not-our-thread',
  })
})

test('the same message arriving twice (app_mention + message) runs once', () => {
  const data = fresh()
  const newTurnId = ids()
  assert.equal(accept(data, msg('100.0'), { mention: true, now: 1, newTurnId }).action, 'start')
  assert.deepEqual(accept(data, msg('100.0'), { mention: true, now: 2, newTurnId }), { action: 'skip', reason: 'duplicate' })
})

test('two messages at once give one running turn; the second waits and runs next', () => {
  const data = fresh()
  const newTurnId = ids()
  const first = accept(data, msg('100.0'), { mention: true, now: 1, newTurnId })
  // With files, so it cannot join the running turn (rule 7) and queues as before.
  const second = accept(data, { ...msg('100.5', 'and also'), hasFiles: true }, { mention: true, now: 1, newTurnId })
  assert.equal(first.action, 'start')
  assert.deepEqual(second, { action: 'queued' })

  const done = finish(data, 'turn-1', { now: 5, newTurnId })
  assert.equal(done.accepted, true)
  if (done.accepted) {
    assert.equal(done.next?.turnId, 'turn-2')
    assert.deepEqual(done.next?.messages.map((m) => m.ts), ['100.5'])
    assert.equal(done.next?.firstTurn, false)
  }
  assert.equal(data.running?.turnId, 'turn-2')
})

test('follow-ups in a known thread need no mention', () => {
  const data = fresh()
  const newTurnId = ids()
  accept(data, msg('100.0'), { mention: true, now: 1, newTurnId })
  finish(data, 'turn-1', { now: 2, newTurnId })
  const r = accept(data, msg('102.0'), { mention: false, now: 3, newTurnId })
  assert.equal(r.action, 'start')
})

test('finishing a turn that is not running is refused (a retried callback cannot free the next turn)', () => {
  const data = fresh()
  const newTurnId = ids()
  accept(data, msg('100.0'), { mention: true, now: 1, newTurnId })
  assert.deepEqual(finish(data, 'turn-999', { now: 2, newTurnId }), { accepted: false })
  assert.equal(finish(data, 'turn-1', { now: 2, newTurnId }).accepted, true)
  assert.deepEqual(finish(data, 'turn-1', { now: 3, newTurnId }), { accepted: false })
})

test('the alarm pauses a quiet thread once, and waits on a busy one', () => {
  const data: ThreadData = fresh()
  const newTurnId = ids()
  const opts = { maxTurnMs: 1000, idlePauseMs: 100, newTurnId }
  accept(data, msg('100.0'), { mention: true, now: 0, newTurnId })
  assert.deepEqual(onAlarm(data, { ...opts, now: 500 }), { action: 'wait', until: 1000 + LOST_TURN_MARGIN_MS })

  finish(data, 'turn-1', { now: 600, newTurnId })
  assert.deepEqual(onAlarm(data, { ...opts, now: 650 }), { action: 'wait', until: 700 })
  assert.deepEqual(onAlarm(data, { ...opts, now: 700 }), { action: 'pause' })
  assert.deepEqual(onAlarm(data, { ...opts, now: 900 }), { action: 'none' })
})

test('a turn that never reports back is freed after its limit, and waiting messages run', () => {
  const data = fresh()
  const newTurnId = ids()
  accept(data, msg('100.0'), { mention: true, now: 0, newTurnId })
  accept(data, { ...msg('100.5'), hasFiles: true }, { mention: true, now: 10, newTurnId })
  const r = onAlarm(data, { now: 1000 + LOST_TURN_MARGIN_MS, maxTurnMs: 1000, idlePauseMs: 100, newTurnId })
  assert.equal(r.action, 'stale')
  if (r.action === 'stale') {
    assert.equal(r.lostTurnId, 'turn-1')
    assert.equal(r.next?.turnId, 'turn-2')
  }
})

test('rule 4: a message during a pause waits, and runs once the pause returns', () => {
  const data = fresh()
  const newTurnId = ids()
  const opts = { maxTurnMs: 1000, idlePauseMs: 100, newTurnId }
  accept(data, msg('100.0'), { mention: true, now: 0, newTurnId })
  finish(data, 'turn-1', { now: 10, newTurnId })
  assert.deepEqual(onAlarm(data, { ...opts, now: 200 }), { action: 'pause' })
  assert.equal(data.pausing, true)

  assert.deepEqual(accept(data, msg('300.0'), { mention: false, now: 300, newTurnId }), { action: 'queued' })
  const next = afterPause(data, { paused: true, now: 400, newTurnId })
  assert.equal(next?.turnId, 'turn-2')
  assert.equal(data.pausing, false)
  assert.equal(data.parked, false, 'a thread with a turn starting is not parked')
})

test('a pause with nothing waiting parks the thread; a failed pause leaves it awake for a retry', () => {
  const ok = fresh()
  const newTurnId = ids()
  accept(ok, msg('100.0'), { mention: true, now: 0, newTurnId })
  finish(ok, 'turn-1', { now: 10, newTurnId })
  onAlarm(ok, { maxTurnMs: 1000, idlePauseMs: 100, now: 200, newTurnId })
  assert.equal(afterPause(ok, { paused: true, now: 210, newTurnId }), null)
  assert.equal(ok.parked, true)

  const failed = fresh()
  accept(failed, msg('100.0'), { mention: true, now: 0, newTurnId })
  finish(failed, 'turn-2', { now: 10, newTurnId })
  onAlarm(failed, { maxTurnMs: 1000, idlePauseMs: 100, now: 200, newTurnId })
  afterPause(failed, { paused: false, now: 210, newTurnId })
  assert.equal(failed.parked, false)
  assert.deepEqual(onAlarm(failed, { maxTurnMs: 1000, idlePauseMs: 100, now: 300, newTurnId }), { action: 'pause' })
})

test('a turn whose job could not be queued is undone, so Slack retrying the event runs it', () => {
  const data = fresh()
  const newTurnId = ids()
  const r = accept(data, msg('100.0'), { mention: true, now: 0, newTurnId })
  assert.equal(r.action, 'start')
  if (r.action !== 'start') return
  abortStart(data, r.turn)
  assert.equal(data.running, null)
  const retry = accept(data, msg('100.0'), { mention: true, now: 5, newTurnId })
  assert.equal(retry.action, 'start')
  if (retry.action === 'start') assert.equal(retry.turn.firstTurn, true)
})

test('a follow-up that joined a turn whose job could not be queued is not lost', () => {
  const data = fresh()
  const newTurnId = ids()
  const r = accept(data, msg('100.0'), { mention: true, now: 0, newTurnId })
  if (r.action !== 'start') throw new Error('expected a start')
  // While the events route awaits the queue send, a follow-up joins the running turn.
  assert.equal(accept(data, msg('101.0'), { mention: false, now: 1, newTurnId }).action, 'midturn')
  abortStart(data, r.turn)

  assert.equal(data.running, null)
  assert.deepEqual(data.pending.map((m) => m.ts), ['101.0'])
  assert.equal(data.known, true)
  // Slack's retry of the follow-up is still a duplicate (it already has its 📨)...
  assert.equal(accept(data, msg('101.0'), { mention: false, now: 2, newTurnId }).action, 'skip')
  // ...and the alarm runs it, as the first turn, so it still reads the history.
  const alarm = onAlarm(data, { maxTurnMs: 1000, idlePauseMs: 100, now: 10_000, newTurnId })
  if (alarm.action !== 'start') throw new Error('expected a start')
  assert.deepEqual(alarm.next.messages.map((m) => m.ts), ['101.0'])
  assert.equal(alarm.next.firstTurn, true)
})

test('a follow-up returned by an undone start waits behind the retried original', () => {
  const data = fresh()
  const newTurnId = ids()
  const r = accept(data, msg('100.0'), { mention: true, now: 0, newTurnId })
  if (r.action !== 'start') throw new Error('expected a start')
  accept(data, msg('101.0'), { mention: false, now: 1, newTurnId })
  abortStart(data, r.turn)

  const retry = accept(data, msg('100.0'), { mention: true, now: 2, newTurnId })
  if (retry.action !== 'start') throw new Error('expected a start')
  assert.deepEqual(retry.turn.messages.map((m) => m.ts), ['100.0'])
  assert.equal(retry.turn.firstTurn, true)
  const done = finish(data, retry.turn.turnId, { now: 3, newTurnId })
  if (!done.accepted || !done.next) throw new Error('expected the follow-up next')
  assert.deepEqual(done.next.messages.map((m) => m.ts), ['101.0'])
  assert.equal(done.next.firstTurn, false)
})

test('a next turn that could not be queued goes back to pending, and the alarm starts it', () => {
  const data = fresh()
  const newTurnId = ids()
  accept(data, msg('100.0'), { mention: true, now: 0, newTurnId })
  accept(data, { ...msg('100.5'), hasFiles: true }, { mention: true, now: 1, newTurnId })
  const done = finish(data, 'turn-1', { now: 5, newTurnId })
  if (!done.accepted || !done.next) throw new Error('expected a next turn')
  requeue(data, done.next)
  assert.equal(data.running, null)
  const r = onAlarm(data, { maxTurnMs: 1000, idlePauseMs: 100, now: 20, newTurnId })
  assert.equal(r.action, 'start')
  if (r.action === 'start') assert.deepEqual(r.next.messages.map((m) => m.ts), ['100.5'])
})

test('a turn records when it started, for the deadline', () => {
  const data = fresh()
  const r = accept(data, msg('100.0'), { mention: true, now: 1234, newTurnId: ids() })
  if (r.action === 'start') assert.equal(r.turn.startedAt, 1234)
})

test('a new turn runs on the default model, and `!model` changes it from the next turn on', () => {
  const data = fresh()
  const newTurnId = ids()
  const first = accept(data, msg('100.0'), { mention: true, now: 1, newTurnId })
  if (first.action !== 'start') throw new Error('expected a start')
  assert.equal(first.turn.model, 'opus')

  const set = applyModelCommand(data, msg('100.5', '!model haiku'), { kind: 'set', alias: 'haiku' }, { mention: false, now: 2 })
  assert.equal(set.action, 'reply')
  if (set.action === 'reply') assert.match(set.text, /next turn/)
  assert.equal(data.running?.turnId, 'turn-1')
  assert.deepEqual(data.pending, [])

  const done = finish(data, 'turn-1', { now: 3, newTurnId })
  assert.equal(done.accepted && done.next, null)
  const second = accept(data, msg('101.0'), { mention: false, now: 4, newTurnId })
  if (second.action !== 'start') throw new Error('expected a start')
  assert.equal(second.turn.model, 'haiku')
})

test('a `!model` message is deduped and needs a mention in a thread that is not ours', () => {
  const data = fresh()
  const cmd = { kind: 'set', alias: 'sonnet' } as const
  assert.deepEqual(applyModelCommand(data, msg('100.0', '!model sonnet'), cmd, { mention: false, now: 1 }), {
    action: 'skip',
    reason: 'not-our-thread',
  })
  assert.equal(data.model, undefined)
  assert.equal(applyModelCommand(data, msg('100.0', '!model sonnet'), cmd, { mention: true, now: 1 }).action, 'reply')
  assert.deepEqual(applyModelCommand(data, msg('100.0', '!model sonnet'), cmd, { mention: true, now: 1 }), {
    action: 'skip',
    reason: 'duplicate',
  })
  assert.equal(data.model, 'sonnet')
})

test('`!model` at the top of a thread makes it ours, and the first real turn still reads the history', () => {
  const data = fresh()
  const newTurnId = ids()
  applyModelCommand(data, msg('100.0', '!model sonnet'), { kind: 'set', alias: 'sonnet' }, { mention: true, now: 1 })
  assert.equal(data.running, null)

  const r = accept(data, msg('100.5'), { mention: false, now: 2, newTurnId })
  if (r.action !== 'start') throw new Error('expected a start')
  assert.equal(r.turn.firstTurn, true)
  assert.equal(r.turn.model, 'sonnet')

  // If that start is undone, the thread stays ours and the retry is still the first turn.
  abortStart(data, r.turn)
  assert.equal(data.known, true)
  const retry = accept(data, msg('100.5'), { mention: false, now: 3, newTurnId })
  if (retry.action !== 'start') throw new Error('expected a start')
  assert.equal(retry.turn.firstTurn, true)

  finish(data, retry.turn.turnId, { now: 4, newTurnId })
  const later = accept(data, msg('101.0'), { mention: false, now: 5, newTurnId })
  if (later.action !== 'start') throw new Error('expected a start')
  assert.equal(later.turn.firstTurn, false)
})

test('`!model` with no name or an unknown name changes nothing', () => {
  const data = fresh()
  const show = applyModelCommand(data, msg('100.0', '!model'), { kind: 'show' }, { mention: true, now: 1 })
  assert.equal(show.action === 'reply' && /opus/.test(show.text), true)
  const unknown = applyModelCommand(data, msg('100.1', '!model gpt'), { kind: 'unknown', given: 'gpt' }, { mention: true, now: 1 })
  assert.equal(unknown.action === 'reply' && /sonnet/.test(unknown.text), true)
  assert.equal(data.model, undefined)
})

// Rule 6: Stop marks the running turn; only the turn's own report frees the thread.
test('the status message is remembered on the running turn only', () => {
  const data = fresh()
  const newTurnId = ids()
  accept(data, msg('100.0'), { mention: true, now: 1, newTurnId })
  assert.equal(setStatus(data, 'turn-1', '150.0'), true)
  assert.equal(setStatus(data, 'turn-9', '151.0'), false)
  assert.deepEqual(progressView(data, 'turn-1'), { running: true, startedAt: 1, statusTs: '150.0', stop: false, inbox: [] })
  assert.deepEqual(progressView(data, 'turn-9'), { running: false })
  assert.deepEqual(progressView(undefined, 'turn-1'), { running: false })
  finish(data, 'turn-1', { now: 2, newTurnId })
  assert.equal(setStatus(data, 'turn-1', '152.0'), false, 'a status posted after the turn ended is not kept')
})

test('Stop marks the running turn once and does not free the thread', () => {
  const data = fresh()
  const newTurnId = ids()
  accept(data, msg('100.0'), { mention: true, now: 1, newTurnId })
  setStatus(data, 'turn-1', '150.0')
  assert.deepEqual(requestStop(data, 'turn-1', 'U2'), { action: 'stopping' })
  assert.deepEqual(requestStop(data, 'turn-1', 'U3'), { action: 'already-stopping' })
  assert.deepEqual(requestStop(data, 'turn-0', 'U2'), { action: 'not-running' })
  assert.equal(data.running?.turnId, 'turn-1')
  assert.deepEqual(progressView(data, 'turn-1'), { running: true, startedAt: 1, statusTs: '150.0', stop: true, inbox: [] })

  // A message sent meanwhile still waits for the stopped turn to report (rule 7: never mid-turn).
  assert.deepEqual(accept(data, msg('101.0'), { mention: false, now: 2, newTurnId }), { action: 'queued' })
  const done = finish(data, 'turn-1', { now: 3, newTurnId })
  assert.equal(done.accepted, true)
  if (done.accepted) {
    assert.equal(done.statusTs, '150.0')
    assert.equal(done.stoppedBy, 'U2')
    assert.equal(done.next?.turnId, 'turn-2')
  }
  assert.deepEqual(requestStop(data, 'turn-1', 'U2'), { action: 'not-running' })
})

test('a lost turn hands back its status message for deleting', () => {
  const data = fresh()
  const newTurnId = ids()
  accept(data, msg('100.0'), { mention: true, now: 0, newTurnId })
  setStatus(data, 'turn-1', '150.0')
  const r = onAlarm(data, { maxTurnMs: 1000, idlePauseMs: 1000, now: 1000 + LOST_TURN_MARGIN_MS, newTurnId })
  assert.equal(r.action, 'stale')
  if (r.action === 'stale') assert.equal(r.lostStatusTs, '150.0')
})

// Rule 7: a plain follow-up joins the running turn, and is never lost.
const midturnThread = () => {
  const data = fresh()
  const newTurnId = ids()
  accept(data, msg('100.0'), { mention: true, now: 1, newTurnId })
  return { data, newTurnId }
}

test('a plain follow-up during a turn goes into that turn, not the next one', () => {
  const { data, newTurnId } = midturnThread()
  assert.deepEqual(accept(data, msg('101.0', 'use the other branch'), { mention: false, now: 2, newTurnId }), { action: 'midturn' })
  assert.deepEqual(data.pending, [])
  const view = progressView(data, 'turn-1')
  assert.equal(view.running && view.inbox.map((m) => m.ts).join(), '101.0')
  // A Slack retry of the same follow-up is still a duplicate.
  assert.deepEqual(accept(data, msg('101.0'), { mention: false, now: 3, newTurnId }), { action: 'skip', reason: 'duplicate' })
})

test('a follow-up the answered turn read is folded: no turn of its own', () => {
  const { data, newTurnId } = midturnThread()
  accept(data, msg('101.0'), { mention: false, now: 2, newTurnId })
  const done = finish(data, 'turn-1', { now: 3, newTurnId, answered: true, taken: ['101.0'] })
  assert.equal(done.accepted, true)
  if (!done.accepted) return
  assert.deepEqual(done.folded.map((m) => m.ts), ['101.0'])
  assert.equal(done.next, null)
  assert.equal(data.running, null)
})

test('a follow-up Claude never read runs as the next turn', () => {
  const { data, newTurnId } = midturnThread()
  accept(data, msg('101.0'), { mention: false, now: 2, newTurnId })
  const done = finish(data, 'turn-1', { now: 3, newTurnId, answered: true, taken: [] })
  if (!done.accepted) throw new Error('expected accepted')
  assert.deepEqual(done.folded, [])
  assert.deepEqual(done.next?.messages.map((m) => m.ts), ['101.0'])
})

test('a failed or stopped turn answers none of its follow-ups, even ones it read', () => {
  const { data, newTurnId } = midturnThread()
  accept(data, msg('101.0'), { mention: false, now: 2, newTurnId })
  const done = finish(data, 'turn-1', { now: 3, newTurnId, answered: false, taken: ['101.0'] })
  if (!done.accepted) throw new Error('expected accepted')
  assert.deepEqual(done.folded, [])
  assert.deepEqual(done.next?.messages.map((m) => m.ts), ['101.0'])
})

test('a finish with no outcome (a start that failed) returns the follow-ups', () => {
  const { data, newTurnId } = midturnThread()
  accept(data, msg('101.0'), { mention: false, now: 2, newTurnId })
  const done = finish(data, 'turn-1', { now: 3, newTurnId })
  if (!done.accepted) throw new Error('expected accepted')
  assert.deepEqual(done.next?.messages.map((m) => m.ts), ['101.0'])
})

test('a lost turn hands its follow-ups to the next turn', () => {
  const { data, newTurnId } = midturnThread()
  accept(data, msg('101.0'), { mention: false, now: 2, newTurnId })
  const r = onAlarm(data, { maxTurnMs: 1000, idlePauseMs: 100, now: 1 + 1000 + LOST_TURN_MARGIN_MS, newTurnId })
  assert.equal(r.action, 'stale')
  if (r.action === 'stale') assert.deepEqual(r.next?.messages.map((m) => m.ts), ['101.0'])
})

test('a turn that could not be queued keeps its follow-ups', () => {
  const data = fresh()
  const newTurnId = ids()
  const r = accept(data, msg('100.0'), { mention: true, now: 1, newTurnId })
  if (r.action !== 'start') throw new Error('expected a start')
  accept(data, msg('101.0'), { mention: false, now: 2, newTurnId })
  requeue(data, r.turn)
  assert.deepEqual(data.pending.map((m) => m.ts), ['100.0', '101.0'])
})

test('the sandbox claiming a ts it was never handed folds nothing', () => {
  const { data, newTurnId } = midturnThread()
  accept(data, msg('101.0'), { mention: false, now: 2, newTurnId })
  const done = finish(data, 'turn-1', { now: 3, newTurnId, answered: true, taken: ['100.0', '999.0'] })
  if (!done.accepted) throw new Error('expected accepted')
  assert.deepEqual(done.folded, [])
  assert.deepEqual(done.next?.messages.map((m) => m.ts), ['101.0'])
})

test('files, a Stop, a queued message or a model change keep a follow-up out of the running turn', () => {
  const files = midturnThread()
  assert.deepEqual(accept(files.data, { ...msg('101.0'), hasFiles: true }, { mention: false, now: 2, newTurnId: files.newTurnId }), { action: 'queued' })
  // Behind a queued message, a plain one queues too, so it cannot overtake it.
  assert.deepEqual(accept(files.data, msg('102.0'), { mention: false, now: 3, newTurnId: files.newTurnId }), { action: 'queued' })
  assert.deepEqual(files.data.pending.map((m) => m.ts), ['101.0', '102.0'])

  const stopped = midturnThread()
  requestStop(stopped.data, 'turn-1', 'U2')
  assert.deepEqual(accept(stopped.data, msg('101.0'), { mention: false, now: 2, newTurnId: stopped.newTurnId }), { action: 'queued' })

  const model = midturnThread()
  applyModelCommand(model.data, msg('100.5', '!model haiku'), { kind: 'set', alias: 'haiku' }, { mention: false, now: 2 })
  assert.deepEqual(accept(model.data, msg('101.0'), { mention: false, now: 3, newTurnId: model.newTurnId }), { action: 'queued' })
})

test('a Stop hides the inbox from the sandbox, and follow-ups already handed over run next', () => {
  const { data, newTurnId } = midturnThread()
  accept(data, msg('101.0'), { mention: false, now: 2, newTurnId })
  requestStop(data, 'turn-1', 'U2')
  const view = progressView(data, 'turn-1')
  assert.equal(view.running && view.inbox.length, 0)
  const done = finish(data, 'turn-1', { now: 3, newTurnId, answered: false })
  if (!done.accepted) throw new Error('expected accepted')
  assert.deepEqual(done.next?.messages.map((m) => m.ts), ['101.0'])
})

test('settleInbox keeps order and splits on taken', () => {
  const inbox = [msg('1.0'), msg('2.0'), msg('3.0')]
  const r = settleInbox(inbox, { answered: true, taken: ['3.0', '1.0'] })
  assert.deepEqual(r.folded.map((m) => m.ts), ['1.0', '3.0'])
  assert.deepEqual(r.returned.map((m) => m.ts), ['2.0'])
  assert.deepEqual(settleInbox(inbox, { answered: false, taken: ['1.0'] }).returned.length, 3)
})

// Rule 9: the channel's default model (src/channels.ts), read as messages arrive.
test("a turn runs on the channel's default unless the thread picked its own model", () => {
  const data = fresh()
  const newTurnId = ids()
  const first = accept(data, msg('100.0'), { mention: true, channelModel: 'sonnet', now: 1, newTurnId })
  assert.ok(first.action === 'start')
  assert.equal(first.turn.model, 'sonnet')
  finish(data, first.turn.turnId, { answered: true, now: 2, newTurnId })

  applyModelCommand(data, msg('100.5', '!model haiku'), { kind: 'set', alias: 'haiku' }, { mention: false, channelModel: 'sonnet', now: 3 })
  const second = accept(data, msg('101.0'), { mention: false, channelModel: 'sonnet', now: 4, newTurnId })
  assert.ok(second.action === 'start')
  assert.equal(second.turn.model, 'haiku', 'the thread pick wins')
})

test('a cleared channel default goes back to opus; an unread one keeps what the thread had', () => {
  const data = fresh()
  const newTurnId = ids()
  const first = accept(data, msg('100.0'), { mention: true, channelModel: 'sonnet', now: 1, newTurnId })
  assert.ok(first.action === 'start')
  finish(data, first.turn.turnId, { answered: true, now: 2, newTurnId })

  // D1 could not be read: the remembered default stays.
  const second = accept(data, msg('101.0'), { mention: false, channelModel: undefined, now: 3, newTurnId })
  assert.ok(second.action === 'start')
  assert.equal(second.turn.model, 'sonnet')
  finish(data, second.turn.turnId, { answered: true, now: 4, newTurnId })

  const third = accept(data, msg('102.0'), { mention: false, channelModel: null, now: 5, newTurnId })
  assert.ok(third.action === 'start')
  assert.equal(third.turn.model, 'opus')
})

test("`!model` with no name says when the thread is on the channel's default", () => {
  const data = fresh()
  const show = applyModelCommand(data, msg('100.0', '!model'), { kind: 'show' }, { mention: true, channelModel: 'haiku', now: 1 })
  assert.ok(show.action === 'reply')
  assert.match(show.text, /haiku.*channel's default/)
})

test('a follow-up joins the running turn only while the channel default still matches its model', () => {
  const data = fresh()
  const newTurnId = ids()
  const first = accept(data, msg('100.0'), { mention: true, channelModel: 'sonnet', now: 1, newTurnId })
  assert.ok(first.action === 'start')
  assert.deepEqual(accept(data, msg('101.0'), { mention: false, channelModel: 'sonnet', now: 2, newTurnId }), { action: 'midturn' })
  // The default changed on the Channels page mid-turn: the next message waits for a turn of its own.
  assert.deepEqual(accept(data, msg('102.0'), { mention: false, channelModel: 'haiku', now: 3, newTurnId }), { action: 'queued' })
})

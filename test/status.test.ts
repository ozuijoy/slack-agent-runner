// The live status message and the Stop button: what the line says, what the sandbox may put in it,
// and how a click is read.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  cleanActivity,
  followUrl,
  formatElapsed,
  MAX_ACTIVITY_CHARS,
  parseStopClick,
  statusBlocks,
  statusLine,
  STOP_ACTION_ID,
} from '../src/status.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

test('the status line shows the activity, the step count and the clock', () => {
  assert.equal(statusLine({ activity: 'Running `npm test`', steps: 14, elapsedMs: 200_000 }), ':hourglass_flowing_sand: Running `npm test` · 14 steps · 3m')
  assert.equal(statusLine({ elapsedMs: 5_000 }), ':hourglass_flowing_sand: Working… · 5s')
  assert.equal(statusLine({ activity: 'x', steps: 1, elapsedMs: 0 }), ':hourglass_flowing_sand: x · 1 step · 0s')
})

test('sandbox text cannot ping, mention or link, and cannot push the counter off the line', () => {
  assert.equal(cleanActivity('hi <!channel> <@U123> <https://evil|click>'), 'hi &lt;!channel&gt; &lt;@U123&gt; &lt;https://evil|click&gt;')
  assert.equal(cleanActivity('a\n\nb'), 'a b')
  assert.equal(cleanActivity(42), '')
  const line = statusLine({ activity: 'x'.repeat(5000), steps: 7, elapsedMs: 61_000 })
  assert.ok(line.endsWith(' · 7 steps · 1m'))
  assert.ok(cleanActivity('y'.repeat(5000)).length <= MAX_ACTIVITY_CHARS)
  // A garbage step count shows nothing rather than nonsense.
  assert.equal(statusLine({ activity: 'a', steps: Number.NaN, elapsedMs: 0 }), ':hourglass_flowing_sand: a · 0s')
})

test('elapsed time reads in seconds, minutes, then hours', () => {
  assert.equal(formatElapsed(59_999), '59s')
  assert.equal(formatElapsed(60_000), '1m')
  assert.equal(formatElapsed(3_725_000), '1h 2m')
  assert.equal(formatElapsed(-5), '0s')
})

test('the Follow along link names the thread on the transcript page', () => {
  assert.equal(followUrl('https://agent.example', 'C1', '100.5'), 'https://agent.example/ui/follow?channel=C1&thread=100.5')
})

test('the Stop button carries only the turn id, and leaving it out drops it', () => {
  const blocks = statusBlocks({ line: 'l', followUrl: 'https://agent.example/ui/follow', turnId: 'turn-1' }) as any[]
  const button = blocks.at(-1).elements[0]
  assert.equal(button.action_id, STOP_ACTION_ID)
  assert.equal(button.value, 'turn-1')
  assert.match(blocks[1].elements[0].text, /\|Follow along>$/)
  const stopping = statusBlocks({ line: 'l', followUrl: 'https://agent.example/ui/follow', turnId: null }) as any[]
  assert.equal(stopping.some((b) => b.type === 'actions'), false)
})

test('no Follow along link while the web UI is not set up', () => {
  assert.equal(followUrl(null, 'C1', '100.5'), null)
  const blocks = statusBlocks({ line: 'l', followUrl: null, turnId: 'turn-1' }) as any[]
  assert.equal(JSON.stringify(blocks).includes('Follow along'), false)
  assert.equal(blocks.at(-1).type, 'actions')
})

const click = {
  type: 'block_actions',
  user: { id: 'U1' },
  channel: { id: 'C1' },
  container: { type: 'message', channel_id: 'C1', message_ts: '200.0', thread_ts: '100.0' },
  message: { ts: '200.0', thread_ts: '100.0' },
  actions: [{ action_id: STOP_ACTION_ID, value: 'turn-1' }],
  response_url: 'https://hooks.slack.com/actions/T/1/x',
}

test('a Stop click is read from Slack fields for where the button sits', () => {
  assert.deepEqual(parseStopClick(click), {
    channel: 'C1',
    threadTs: '100.0',
    messageTs: '200.0',
    turnId: 'turn-1',
    user: 'U1',
    responseUrl: 'https://hooks.slack.com/actions/T/1/x',
  })
})

test('anything that is not a Stop click is ignored, and only Slack response urls are kept', () => {
  assert.equal(parseStopClick(null), null)
  assert.equal(parseStopClick({ ...click, type: 'view_submission' }), null)
  assert.equal(parseStopClick({ ...click, actions: [{ action_id: 'other', value: 'x' }] }), null)
  assert.equal(parseStopClick({ ...click, message: { ts: '200.0' }, container: { channel_id: 'C1', message_ts: '200.0' } }), null)
  assert.equal(parseStopClick({ ...click, response_url: 'https://evil.example/' })?.responseUrl, undefined)
})

test('the progress door reads the thread from the token and the interactive route checks the signature', () => {
  const index = readFileSync(join(root, 'src', 'index.ts'), 'utf8')
  const progress = index.slice(index.indexOf('async function sandboxProgress'), index.indexOf('async function slackInteractive'))
  assert.match(progress, /verifyCallbackToken\(env\.CALLBACK_SECRET, token, body\.turnId\)/)
  assert.match(progress, /const { channel, threadTs, turnId } = verified\.claims/)
  assert.doesNotMatch(progress, /body\.(channel|threadTs|statusTs)/)
  const interactive = index.slice(index.indexOf('async function slackInteractive'), index.indexOf('async function sandboxTranscript'))
  assert.ok(interactive.indexOf('verifySlackSignature') < interactive.indexOf('JSON.parse'))
  assert.match(interactive, /if \(!ok\) return new Response\('bad signature', { status: 401 }\)/)
})

test('the answer is posted before the status message is deleted', () => {
  const index = readFileSync(join(root, 'src', 'index.ts'), 'utf8')
  const callback = index.slice(index.indexOf('async function sandboxCallback'), index.indexOf('async function sandboxProgress'))
  assert.ok(callback.indexOf('await postInThread(env, channel, threadTs, text)') < callback.indexOf('deleteMessage(env, channel, claim.statusTs)'))
})

// box/progress.mjs is plain JS written into the sandbox; load it as a module by path.
const progress = await import(pathToFileURL(join(root, 'box', 'progress.mjs')).href)

test('the runner counts tool calls and says what the last one does', () => {
  const p = progress.createProgress()
  assert.equal(progress.onStreamEvent(p, { type: 'system' }), false)
  assert.equal(
    progress.onStreamEvent(p, {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/home/user/work/src/a.ts' } }, { type: 'tool_use', name: 'Bash', input: { command: 'npm test\necho done' } }] },
    }),
    true,
  )
  assert.equal(p.steps, 2)
  assert.equal(p.activity, 'Running `npm test`')
  progress.onStreamEvent(p, { type: 'assistant', message: { content: [{ type: 'text', text: 'All green.' }] } })
  assert.equal(p.activity, 'Writing…')
  assert.equal(p.steps, 2)
})

test('each tool reads as one short line', () => {
  assert.equal(progress.describeTool('Edit', { file_path: 'src/x.ts' }), 'Editing `x.ts`')
  assert.equal(progress.describeTool('Grep', { pattern: 'TODO' }), 'Searching for `TODO`')
  assert.equal(progress.describeTool('WebFetch', { url: 'https://example.com/a' }), 'Reading `example.com`')
  assert.equal(progress.describeTool('Bash', { command: 'echo `id`' }), "Running `echo 'id'`")
  assert.equal(progress.describeTool('mcp__thing__do', {}), 'Using `mcp__thing__do`')
  assert.ok(progress.describeTool('Bash', { command: 'x'.repeat(500) }).length < 100)
})

test('an unchanged status is re-sent once a minute, a changed one at once', () => {
  assert.equal(progress.shouldSendStatus({ changed: true, lastSentAt: 1000, now: 1001 }), true)
  assert.equal(progress.shouldSendStatus({ changed: false, lastSentAt: 1000, now: 1001 }), false)
  assert.equal(progress.shouldSendStatus({ changed: false, lastSentAt: 0, now: progress.RESEND_MS }), true)
})

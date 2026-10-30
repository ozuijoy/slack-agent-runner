// The live turn on the transcript page: what the sandbox may send (src/live.ts), and how the
// sandbox reads Claude's stream into it (box/progress.mjs).
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { appendLive, checkLiveEntries, MAX_ENTRIES_PER_REPORT, MAX_LIVE_CHARS, MAX_LIVE_ENTRIES, MAX_LIVE_TEXT } from '../src/live.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
// box/progress.mjs is plain JS written into the sandbox; load it as a module by path.
const progress = await import(pathToFileURL(join(root, 'box', 'progress.mjs')).href)

test('rule 3: only known kinds, capped text and a capped count get through', () => {
  const now = 1000
  const entries = checkLiveEntries(
    [
      { kind: 'tool', name: 'Bash', text: 'ls' },
      { kind: 'html', text: '<script>' },
      { kind: 'text', text: 'x'.repeat(MAX_LIVE_TEXT + 50) },
      null,
      { kind: 'result', text: 42 },
    ],
    now,
  )
  assert.deepEqual(entries[0], { kind: 'tool', name: 'Bash', text: 'ls', at: now })
  assert.equal(entries.length, 3)
  assert.equal(entries[1].text.length, MAX_LIVE_TEXT)
  assert.deepEqual(entries[2], { kind: 'result', text: '', at: now })
  assert.deepEqual(checkLiveEntries('nope', now), [])
  assert.equal(checkLiveEntries(Array(500).fill({ kind: 'text', text: 'a' }), now).length, MAX_ENTRIES_PER_REPORT)
})

test('rule 2: a new turn starts a new log; the same turn appends', () => {
  const e = (text: string) => ({ kind: 'text' as const, text, at: 1 })
  let log = appendLive(undefined, 't1', 100, [e('a')])
  log = appendLive(log, 't1', 100, [e('b')])
  assert.deepEqual(log.entries.map((x) => x.text), ['a', 'b'])
  const next = appendLive(log, 't2', 200, [e('c')])
  assert.deepEqual(next, { turnId: 't2', startedAt: 200, entries: [e('c')], dropped: 0 })
  // The earlier log object is not changed under a reader.
  assert.equal(log.entries.length, 2)
})

test('rule 3: the log keeps the newest entries and counts what it dropped', () => {
  const many = Array.from({ length: MAX_LIVE_ENTRIES + 25 }, (_, i) => ({ kind: 'text' as const, text: String(i), at: 1 }))
  const log = appendLive(undefined, 't1', 1, many)
  assert.equal(log.entries.length, MAX_LIVE_ENTRIES)
  assert.equal(log.dropped, 25)
  assert.equal(log.entries[0].text, '25')
})

test('the sandbox turns stream events into live entries: text, thinking, tool calls and results', () => {
  assert.deepEqual(
    progress.liveEntries({
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: 'hmm' },
          { type: 'text', text: 'Looking.' },
          { type: 'tool_use', name: 'Read', input: { file_path: '/a' } },
        ],
      },
    }),
    [
      { kind: 'thinking', text: 'hmm' },
      { kind: 'text', text: 'Looking.' },
      { kind: 'tool', name: 'Read', text: '{\n  "file_path": "/a"\n}' },
    ],
  )
  assert.deepEqual(
    progress.liveEntries({
      type: 'user',
      message: { content: [{ type: 'tool_result', content: [{ type: 'text', text: 'ok' }, { type: 'image' }] }, { type: 'tool_result', content: 'boom', is_error: true }] },
    }),
    [
      { kind: 'result', text: 'ok\n[image]' },
      { kind: 'error', text: 'boom' },
    ],
  )
  assert.deepEqual(progress.liveEntries({ type: 'result', result: 'done' }), [])
  assert.equal(progress.liveEntries({ type: 'assistant', message: { content: [{ type: 'text', text: 'y'.repeat(9000) }] } })[0].text.length, progress.LIVE_TEXT_MAX)
})

test('the sandbox queue drops the oldest past its cap, and a failed batch goes back in front', () => {
  const q: unknown[] = []
  progress.queueLive(q, Array.from({ length: progress.LIVE_QUEUE_MAX + 5 }, (_, i) => i))
  assert.equal(q.length, progress.LIVE_QUEUE_MAX)
  assert.equal(q[0], 5)
  const batch = q.splice(0, 3)
  progress.requeueLive(q, batch)
  assert.deepEqual(q.slice(0, 3), [5, 6, 7])
  assert.equal(q.length, progress.LIVE_QUEUE_MAX)
})

test('rule 3: the log stays under its size budget however long the entries are', () => {
  const big = Array.from({ length: 300 }, (_, i) => ({ kind: 'result' as const, text: String(i).padEnd(MAX_LIVE_TEXT, 'x'), at: 1 }))
  const log = appendLive(undefined, 't1', 1, big)
  const chars = log.entries.reduce((n, e) => n + e.text.length, 0)
  assert.ok(chars <= MAX_LIVE_CHARS)
  assert.equal(log.dropped + log.entries.length, 300)
  assert.ok(log.entries.at(-1)!.text.startsWith('299'), 'the newest are kept')
  assert.ok(JSON.stringify(log).length < 1_000_000)
})

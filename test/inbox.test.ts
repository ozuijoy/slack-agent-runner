// Mid-turn messages, sandbox side: the runner writes follow-ups into the inbox, the Claude Code
// hook claims them and hands them to Claude (box/inbox.mjs, box/inbox-hook.mjs).
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const box = join(dirname(fileURLToPath(import.meta.url)), '..', 'box')
const HOOK = join(box, 'inbox-hook.mjs')
// box/inbox.mjs is plain JS written into the sandbox; load it as a module by path.
const { deliver, frameMessages, hookOutput, hookSettings, takeAll, takenTs } = await import(pathToFileURL(join(box, 'inbox.mjs')).href)
const tmp = () => mkdtempSync(join(tmpdir(), 'inbox-'))

test('each follow-up is written once, however often the Worker sends it', () => {
  const dir = tmp()
  try {
    const written = new Set<string>()
    const msgs = [{ ts: '101.0', user: 'U1', text: 'one' }]
    assert.equal(deliver(dir, msgs, written), 1)
    assert.equal(deliver(dir, [...msgs, { ts: '102.0', user: 'U2', text: 'two' }], written), 1)
    // Taken files are not written again either.
    takeAll(dir)
    assert.equal(deliver(dir, msgs, written), 0)
    assert.deepEqual(readdirSync(dir).sort(), ['101.0.taken', '102.0.taken'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a ts that is not a Slack ts never becomes a file name', () => {
  const dir = tmp()
  try {
    assert.equal(deliver(dir, [{ ts: '../../etc/x', user: 'U1', text: 'x' }, { ts: 5 }, null], new Set()), 0)
    assert.deepEqual(readdirSync(dir), [])
    assert.equal(deliver(dir, 'not a list', new Set()), 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('takeAll claims waiting messages oldest first, once', () => {
  const dir = tmp()
  try {
    deliver(dir, [{ ts: '110.0', user: 'U2', text: 'later' }, { ts: '20.5', user: 'U1', text: 'first' }], new Set())
    writeFileSync(join(dir, 'notes.json'), '{}')
    const taken = takeAll(dir)
    assert.deepEqual(taken.map((m: { text: string }) => m.text), ['first', 'later'])
    assert.deepEqual(takeAll(dir), [])
    assert.deepEqual(takenTs(dir), ['20.5', '110.0'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a missing inbox is just empty', () => {
  assert.deepEqual(takeAll('/nonexistent/inbox'), [])
  assert.deepEqual(takenTs('/nonexistent/inbox'), [])
})

test('the hook output carries the framed messages as additional context', () => {
  assert.equal(hookOutput([]), '')
  const out = JSON.parse(hookOutput([{ ts: '1.0', user: 'U1', text: 'use main' }]))
  assert.equal(out.hookSpecificOutput.hookEventName, 'PostToolUse')
  assert.match(out.hookSpecificOutput.additionalContext, /<@U1>: use main/)
  assert.match(frameMessages([{ user: 'U1', text: 'a' }, { user: 'U2', text: 'b' }]), /New messages/)
  assert.deepEqual(hookSettings('node hook.mjs').hooks.PostToolUse[0].hooks[0], { type: 'command', command: 'node hook.mjs' })
})

test('the hook script claims the inbox and prints the context; with nothing new it prints nothing', () => {
  const dir = tmp()
  try {
    const run = () => execFileSync(process.execPath, [HOOK], { env: { AGENT_INBOX: dir }, encoding: 'utf8' })
    assert.equal(run(), '')
    deliver(dir, [{ ts: '101.0', user: 'U1', text: 'also check the tests' }], new Set())
    const out = JSON.parse(run())
    assert.match(out.hookSpecificOutput.additionalContext, /also check the tests/)
    assert.equal(existsSync(join(dir, '101.0.taken')), true)
    assert.equal(run(), '')
    // No inbox set at all: still exits cleanly, so a tool call never fails on it.
    assert.equal(execFileSync(process.execPath, [HOOK], { env: {}, encoding: 'utf8' }), '')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

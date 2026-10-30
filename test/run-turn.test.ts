// Runs box/run-turn.mjs for real against a fake `claude` and a local stand-in for the Worker.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { blobSha } from '../src/memory.ts'

const RUNNER = join(dirname(fileURLToPath(import.meta.url)), '..', 'box', 'run-turn.mjs')

test('the answer is delivered and the lock freed while the transcript upload still hangs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'run-turn-'))
  const home = join(dir, 'home')
  const bin = join(dir, 'bin')
  const lock = join(dir, 'agent-turn.lock')
  const prompt = join(dir, 'prompt.txt')
  mkdirSync(join(home, '.claude', 'projects', 'p'), { recursive: true })
  writeFileSync(join(home, '.claude', 'projects', 'p', 'sess-1.jsonl'), '{"type":"user"}\n')
  mkdirSync(bin)
  writeFileSync(
    join(bin, 'claude'),
    `#!/bin/sh\necho '{"type":"result","is_error":false,"result":"hello","total_cost_usd":0.01}'\n`,
  )
  chmodSync(join(bin, 'claude'), 0o755)
  writeFileSync(prompt, 'hi')

  let callback: ((body: string) => void) | null = null
  const delivered = new Promise<string>((resolve) => (callback = resolve))
  const hanging: ServerResponse[] = []
  let uploadSeen: () => void = () => {}
  const uploadStarted = new Promise<void>((resolve) => (uploadSeen = resolve))
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url === '/sandbox/transcript') {
      // A slow or mid-deploy Worker: the backup door never answers.
      req.resume()
      hanging.push(res)
      uploadSeen()
      return
    }
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      res.end('{"ok":true}')
      callback?.(body)
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port

  const child = spawn(process.execPath, [RUNNER], {
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: home,
      TURN_ID: 'turn-1',
      SESSION_ID: 'sess-1',
      PROMPT_FILE: prompt,
      CALLBACK_URL: `http://127.0.0.1:${port}/sandbox/callback`,
      TRANSCRIPT_URL: `http://127.0.0.1:${port}/sandbox/transcript`,
      CALLBACK_TOKEN: 'tok',
      TURN_DEADLINE: String(Date.now() + 120_000),
      TURN_LOCK_FILE: lock,
    },
    stdio: 'ignore',
  })

  try {
    const body = await Promise.race([
      delivered,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('the answer waited on the transcript upload')), 10_000),
      ),
    ])
    assert.deepEqual(JSON.parse(body), { turnId: 'turn-1', ok: true, text: 'hello', costUsd: 0.01 })
    // The upload runs beside the answer (it may land a moment later) and still hangs.
    await uploadStarted
    assert.equal(hanging.length, 1)
    assert.equal(hanging[0].writableEnded, false)
    assert.equal(existsSync(lock), false, 'the next turn is not refused while the upload runs')
  } finally {
    child.kill('SIGKILL')
    for (const res of hanging) res.destroy()
    server.closeAllConnections()
    server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a Stop from the progress door ends Claude and reports the turn as stopped', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'run-turn-'))
  const home = join(dir, 'home')
  const bin = join(dir, 'bin')
  const prompt = join(dir, 'prompt.txt')
  mkdirSync(home, { recursive: true })
  mkdirSync(bin)
  // A Claude that makes one tool call and then works for a long time.
  const toolUse = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'make build' } }] } })
  writeFileSync(join(bin, 'claude'), `#!/bin/sh\necho '${toolUse}'\nexec sleep 30\n`)
  chmodSync(join(bin, 'claude'), 0o755)
  writeFileSync(prompt, 'hi')

  const ticks: Array<Record<string, unknown>> = []
  let callback: ((body: string) => void) | null = null
  const delivered = new Promise<string>((resolve) => (callback = resolve))
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      if (req.url === '/sandbox/progress') {
        const tick = JSON.parse(body)
        ticks.push({ ...tick, auth: req.headers.authorization })
        // Once the tool call has been shown, the next report learns someone pressed Stop.
        const shown = ticks.findIndex((t) => t.steps === 1)
        res.end(JSON.stringify({ ok: true, stop: shown !== -1 && ticks.length - 1 > shown }))
        return
      }
      res.end('{"ok":true}')
      callback?.(body)
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port

  const started = Date.now()
  const child = spawn(process.execPath, [RUNNER], {
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: home,
      TURN_ID: 'turn-1',
      SESSION_ID: 'sess-1',
      PROMPT_FILE: prompt,
      CALLBACK_URL: `http://127.0.0.1:${port}/sandbox/callback`,
      PROGRESS_URL: `http://127.0.0.1:${port}/sandbox/progress`,
      PROGRESS_TICK_MS: '200',
      CALLBACK_TOKEN: 'tok',
      TURN_DEADLINE: String(Date.now() + 120_000),
      TURN_LOCK_FILE: join(dir, 'agent-turn.lock'),
    },
    stdio: 'ignore',
  })

  try {
    const body = await Promise.race([
      delivered,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('the stop never ended the turn')), 10_000)),
    ])
    assert.deepEqual(JSON.parse(body), { turnId: 'turn-1', ok: false, stopped: true, error: 'stopped' })
    assert.ok(Date.now() - started < 10_000, 'stopped long before claude would have finished')
    const shown = ticks.findIndex((t) => t.steps === 1)
    const { events: _e, ...status } = ticks[shown]
    assert.deepEqual(status, { turnId: 'turn-1', activity: 'Running `make build`', steps: 1, auth: 'Bearer tok' })
    // Nothing changed since, so the next tick only asks whether to stop.
    assert.deepEqual(ticks[shown + 1], { turnId: 'turn-1', auth: 'Bearer tok' })
    // The live transcript page got the prompt and the tool call, each once, in order (src/live.ts).
    assert.deepEqual(
      ticks.flatMap((t) => (t.events as unknown[]) ?? []),
      [
        { kind: 'prompt', text: 'hi' },
        { kind: 'tool', name: 'Bash', text: '{\n  "command": "make build"\n}' },
      ],
    )
  } finally {
    child.kill('SIGKILL')
    server.closeAllConnections()
    server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a follow-up from the progress door reaches Claude at its next tool step, and the answer says it was read', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'run-turn-'))
  const home = join(dir, 'home')
  const bin = join(dir, 'bin')
  const prompt = join(dir, 'prompt.txt')
  const inbox = join(dir, 'inbox')
  mkdirSync(home, { recursive: true })
  mkdirSync(bin)
  // A Claude that makes a tool call, waits for a follow-up to land in the inbox, then (as Claude
  // Code does after the next tool call) runs the PostToolUse hook it was given and answers with it.
  writeFileSync(
    join(bin, 'claude'),
    `#!${process.execPath}
const { execSync } = require('node:child_process')
const { readdirSync } = require('node:fs')
const settings = JSON.parse(process.argv[process.argv.indexOf('--settings') + 1])
const hook = settings.hooks.PostToolUse[0].hooks[0].command
console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'make build' } }] } }))
const started = Date.now()
const wait = setInterval(() => {
  const waiting = readdirSync(process.env.AGENT_INBOX).some((n) => n.endsWith('.json'))
  if (!waiting && Date.now() - started < 8000) return
  clearInterval(wait)
  const out = execSync(hook, { encoding: 'utf8' })
  const context = out ? JSON.parse(out).hookSpecificOutput.additionalContext : ''
  // Stay alive past the next tick, so the status line shows the follow-up was read.
  setTimeout(() => {
    console.log(JSON.stringify({ type: 'result', is_error: false, result: 'done. ' + context, total_cost_usd: 0 }))
  }, 600)
}, 50)
`,
  )
  chmodSync(join(bin, 'claude'), 0o755)
  writeFileSync(prompt, 'hi')

  const ticks: Array<Record<string, unknown>> = []
  let callback: ((body: string) => void) | null = null
  const delivered = new Promise<string>((resolve) => (callback = resolve))
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      if (req.url === '/sandbox/progress') {
        ticks.push(JSON.parse(body))
        // The Worker sends the whole inbox every time; the runner writes it once.
        res.end(JSON.stringify({ ok: true, stop: false, messages: [{ ts: '200.1', user: 'U2', text: 'use the other branch' }] }))
        return
      }
      res.end('{"ok":true}')
      callback?.(body)
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port

  const child = spawn(process.execPath, [RUNNER], {
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: home,
      TURN_ID: 'turn-1',
      SESSION_ID: 'sess-1',
      PROMPT_FILE: prompt,
      CALLBACK_URL: `http://127.0.0.1:${port}/sandbox/callback`,
      PROGRESS_URL: `http://127.0.0.1:${port}/sandbox/progress`,
      PROGRESS_TICK_MS: '200',
      CALLBACK_TOKEN: 'tok',
      TURN_DEADLINE: String(Date.now() + 120_000),
      TURN_LOCK_FILE: join(dir, 'agent-turn.lock'),
      AGENT_INBOX: inbox,
    },
    stdio: 'ignore',
  })

  try {
    const body = JSON.parse(
      await Promise.race([
        delivered,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('the turn never answered')), 15_000)),
      ]),
    )
    assert.equal(body.ok, true)
    assert.match(body.text, /<@U2>: use the other branch/)
    assert.deepEqual(body.taken, ['200.1'])
    assert.ok(ticks.some((t) => t.activity === ':incoming_envelope: Read your new message'), 'the status line shows the follow-up was read')
    assert.equal(existsSync(inbox), false, 'the inbox is cleared after the turn')
  } finally {
    child.kill('SIGKILL')
    server.closeAllConnections()
    server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a Stop while files are still downloading ends the turn before Claude starts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'run-turn-'))
  const home = join(dir, 'home')
  const bin = join(dir, 'bin')
  const prompt = join(dir, 'prompt.txt')
  const manifest = join(dir, 'manifest.json')
  const ran = join(dir, 'claude-ran')
  mkdirSync(home, { recursive: true })
  mkdirSync(bin)
  writeFileSync(join(bin, 'claude'), `#!/bin/sh\ntouch '${ran}'\necho '{"type":"result","is_error":false,"result":"hi"}'\n`)
  chmodSync(join(bin, 'claude'), 0o755)
  writeFileSync(prompt, 'hi')
  writeFileSync(manifest, JSON.stringify([{ name: 'big.mov', path: 'slack-files/big.mov', grant: 'g1' }]))

  const ticks: Array<Record<string, unknown>> = []
  const hung: ServerResponse[] = []
  let callback: ((body: string) => void) | null = null
  const delivered = new Promise<string>((resolve) => (callback = resolve))
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url === '/sandbox/file') {
      // A file that takes far longer than the test.
      res.writeHead(200)
      res.write('a')
      hung.push(res)
      return
    }
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      if (req.url === '/sandbox/progress') {
        ticks.push(JSON.parse(body))
        res.end(JSON.stringify({ ok: true, stop: ticks.length >= 2 }))
        return
      }
      res.end('{"ok":true}')
      callback?.(body)
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port

  const child = spawn(process.execPath, [RUNNER], {
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: home,
      TURN_ID: 'turn-1',
      SESSION_ID: 'sess-1',
      PROMPT_FILE: prompt,
      CALLBACK_URL: `http://127.0.0.1:${port}/sandbox/callback`,
      PROGRESS_URL: `http://127.0.0.1:${port}/sandbox/progress`,
      PROGRESS_TICK_MS: '200',
      CALLBACK_TOKEN: 'tok',
      TURN_DEADLINE: String(Date.now() + 120_000),
      TURN_LOCK_FILE: join(dir, 'agent-turn.lock'),
      FILES_MANIFEST: manifest,
      FILE_URL: `http://127.0.0.1:${port}/sandbox/file`,
    },
    stdio: 'ignore',
  })

  try {
    const body = await Promise.race([
      delivered,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('the stop never ended the download')), 10_000)),
    ])
    assert.deepEqual(JSON.parse(body), { turnId: 'turn-1', ok: false, stopped: true, error: 'stopped' })
    assert.equal(ticks[0].activity, 'Downloading files…', 'the status says what the turn is waiting on')
    assert.equal(existsSync(ran), false, 'Claude never started')
  } finally {
    child.kill('SIGKILL')
    for (const res of hung) res.destroy()
    server.closeAllConnections()
    server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('memory: pulled before Claude, auto memory pointed at it, and the new note pushed with the answer', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'run-turn-'))
  const home = join(dir, 'home')
  const bin = join(dir, 'bin')
  const prompt = join(dir, 'prompt.txt')
  const memoryDir = join(dir, 'memory')
  const settingsFile = join(home, '.claude', 'settings.json')
  mkdirSync(home, { recursive: true })
  mkdirSync(bin)
  // A Claude that checks auto memory points at the pulled notes, then saves a new one.
  writeFileSync(
    join(bin, 'claude'),
    `#!${process.execPath}
const { readFileSync, writeFileSync } = require('node:fs')
const settings = JSON.parse(readFileSync(${JSON.stringify(settingsFile)}, 'utf8'))
const index = readFileSync(settings.autoMemoryDirectory + '/MEMORY.md', 'utf8')
writeFileSync(settings.autoMemoryDirectory + '/gotcha.md', 'tests need TZ=UTC\\n')
console.log(JSON.stringify({ type: 'result', is_error: false, result: 'enabled=' + settings.autoMemoryEnabled + ' ' + index.trim(), total_cost_usd: 0 }))
`,
  )
  chmodSync(join(bin, 'claude'), 0o755)
  writeFileSync(prompt, 'hi')

  let answer = ''
  let pushed: Record<string, unknown> | null = null
  let done: () => void = () => {}
  const finished = new Promise<void>((resolve) => (done = resolve))
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      if (req.url === '/sandbox/memory' && req.method === 'GET') {
        assert.equal(req.headers.authorization, 'Bearer tok')
        return res.end(JSON.stringify({ ok: true, files: [{ path: 'MEMORY.md', content: '- [Deploy](deploy.md)\n' }] }))
      }
      if (req.url === '/sandbox/memory') pushed = JSON.parse(body)
      else answer = body
      res.end('{"ok":true}')
      if (answer && pushed) done()
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port

  const child = spawn(process.execPath, [RUNNER], {
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: home,
      TURN_ID: 'turn-1',
      SESSION_ID: 'sess-1',
      PROMPT_FILE: prompt,
      CALLBACK_URL: `http://127.0.0.1:${port}/sandbox/callback`,
      MEMORY_URL: `http://127.0.0.1:${port}/sandbox/memory`,
      MEMORY_DIR: memoryDir,
      MEMORY_BASE_FILE: join(dir, 'memory-base.json'),
      CALLBACK_TOKEN: 'tok',
      TURN_DEADLINE: String(Date.now() + 120_000),
      TURN_LOCK_FILE: join(dir, 'agent-turn.lock'),
    },
    stdio: 'ignore',
  })

  try {
    await Promise.race([finished, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('no answer and push')), 10_000))])
    assert.equal(JSON.parse(answer).text, 'enabled=true - [Deploy](deploy.md)')
    assert.deepEqual(pushed, {
      turnId: 'turn-1',
      base: { 'MEMORY.md': await blobSha('- [Deploy](deploy.md)\n') },
      changes: [{ path: 'gotcha.md', content: 'tests need TZ=UTC\n' }],
    })
  } finally {
    child.kill('SIGKILL')
    server.closeAllConnections()
    server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

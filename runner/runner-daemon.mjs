#!/usr/bin/env node
/**
 * ②: the machine that runs the turns.
 *
 * The Worker keeps everything that has to be consistent — Slack, the queue, the sessions, the
 * status message — and this script keeps the one thing that needs a real machine: Claude, with a
 * disk to work on and nobody's CPU limit but yours.
 *
 * It asks the Worker for a turn, restores that thread's session, runs `box/run-turn.mjs`, and puts
 * the session back. The turn posts its own answer to Slack through the Worker's /sandbox/callback
 * door, so this process never holds an answer.
 *
 *   WORKER_ORIGIN   https://your-worker.workers.dev   (required)
 *   RUNNER_SECRET   the same string as the Worker's   (required)
 *   RUNNER_ID       default: the hostname. One per machine.
 *   RUNNER_WORKDIR  default: ~/.slack-agent-runner. Threads, their homes and their checkouts live here.
 *   RUNNER_NODE_OPTIONS  default: --max-old-space-size=2048. Node's ceiling for the turn.
 *
 * Everything is per-thread and under RUNNER_WORKDIR: thread's HOME is its own directory, so `~/work`
 * (the folder the agent is told to work in) is that thread's checkout and `~/.claude` is its session,
 * and no two threads can see each other's.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const ORIGIN = need('WORKER_ORIGIN')
const SECRET = need('RUNNER_SECRET')
const RUNNER_ID = process.env.RUNNER_ID ?? os.hostname()
const WORKDIR = path.resolve(process.env.RUNNER_WORKDIR ?? path.join(os.homedir(), '.slack-agent-runner'))
const NODE_OPTIONS = process.env.RUNNER_NODE_OPTIONS ?? '--max-old-space-size=2048'

/** As long as the Worker will wait. A shorter wait just means more requests for the same silence. */
const WAIT_MS = 25_000
/** Well inside the Worker's 3-minute lease: one missed report is survivable, two is a lost turn. */
const HEARTBEAT_MS = 30_000

const log = (...parts) => console.log(new Date().toISOString(), ...parts)

function need(name) {
  const value = process.env[name]
  if (!value) {
    console.error(`${name} is not set. See runner/README.md.`)
    process.exit(2)
  }
  return value
}

async function api(pathname, init = {}) {
  const res = await fetch(new URL(pathname, ORIGIN), {
    ...init,
    headers: {
      authorization: `Bearer ${SECRET}`,
      'x-runner-id': RUNNER_ID,
      ...(init.body && typeof init.body === 'string' ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
  })
  if (res.status === 401) throw new Error('the Worker rejected RUNNER_SECRET')
  return res
}

/** One turn, or null when the Worker had none to give. */
async function nextJob() {
  const res = await api('/runner/next', { method: 'POST', body: JSON.stringify({ waitMs: WAIT_MS }) })
  if (res.status === 204) return null
  if (!res.ok) throw new Error(`/runner/next answered ${res.status}: ${await res.text()}`)
  return res.json()
}

/** The runner and tools, fetched once per process: the Worker sends them with every deploy. */
let box = null
async function boxFiles() {
  if (!box) {
    const res = await api('/runner/box')
    if (!res.ok) throw new Error(`/runner/box answered ${res.status}`)
    box = await res.json()
    log(`runner bundle ${box.version}`)
  }
  return box.files
}

const safe = (s) => s.replace(/[^a-zA-Z0-9._-]/g, '_')
/** Claude Code's own naming for a project folder: the cwd with everything unhelpful turned to '-'. */
const slug = (dir) => dir.replace(/[^a-zA-Z0-9]/g, '-')

const sessionPath = (home, work, sessionId) => path.join(home, '.claude', 'projects', slug(work), `${sessionId}.jsonl`)

/** Writes the runner into the thread's own agent dir, so two threads can never share a prompt file. */
async function writeRunner(agentDir) {
  const files = await boxFiles()
  await mkdir(agentDir, { recursive: true })
  await Promise.all(Object.entries(files).map(([name, data]) => writeFile(path.join(agentDir, name), data)))
}

/** Brings the thread's session down before the turn, so `--resume` finds its conversation. */
async function restoreSession(job, sessionFile) {
  const res = await api(`/runner/session?job=${encodeURIComponent(job.jobId)}`, { method: 'GET' })
  if (res.status === 404) return log(`turn ${job.turnId}: new thread, no session yet`)
  if (!res.ok) throw new Error(`session download answered ${res.status}`)
  await mkdir(path.dirname(sessionFile), { recursive: true })
  await writeFile(sessionFile, new Uint8Array(await res.arrayBuffer()))
  log(`turn ${job.turnId}: session restored`)
}

/** Puts the session back. A turn that produced none keeps the old one: better stale than gone. */
async function saveSession(job, sessionFile, hasSession) {
  const exists = existsSync(sessionFile)
  if (!exists && !hasSession) return log(`turn ${job.turnId}: no session to store`)
  if (!exists) return log(`turn ${job.turnId}: session file vanished, keeping the stored one`)
  const bytes = await readFile(sessionFile)
  const res = await api(`/runner/session?job=${encodeURIComponent(job.jobId)}`, {
    method: 'PUT',
    body: bytes,
    headers: { 'content-type': 'application/octet-stream' },
  })
  if (!res.ok) throw new Error(`session upload answered ${res.status}`)
  log(`turn ${job.turnId}: session stored (${bytes.byteLength} bytes)`)
}

/** Runs one turn and reports how it ended. Never throws: a bad turn must not stop the loop. */
async function runTurn(job) {
  const home = path.join(WORKDIR, 'threads', safe(job.sessionKey))
  const work = path.join(home, 'work')
  const agentDir = path.join(home, '.agent')
  const promptPath = path.join(agentDir, `prompt-${job.turnId}.txt`)
  const manifestPath = path.join(agentDir, `files-${job.turnId}.json`)
  await mkdir(work, { recursive: true })
  await writeRunner(agentDir)
  await writeFile(promptPath, job.prompt)

  const sessionFile = sessionPath(home, work, job.env.SESSION_ID)
  await restoreSession(job, sessionFile)
  const hadSession = existsSync(sessionFile)

  const env = {
    ...process.env,
    ...job.env,
    HOME: home,
    NODE_OPTIONS,
    PROMPT_FILE: promptPath,
    ...(job.files?.length ? { FILES_MANIFEST: manifestPath } : {}),
  }
  if (job.files?.length) await writeFile(manifestPath, JSON.stringify(job.files))

  log(`turn ${job.turnId} starting in ${work}`)
  const child = spawn(process.execPath, [path.join(agentDir, 'run-turn.mjs')], {
    cwd: work,
    env,
    stdio: ['ignore', 'inherit', 'inherit'],
  })

  // Report while it runs: a turn can take an hour, and the Worker hands a silent job to someone else.
  let held = true
  const beat = setInterval(() => {
    api('/runner/lease', { method: 'POST', body: JSON.stringify({ jobId: job.jobId }) })
      .then((res) => res.json())
      .then((body) => {
        if (!body.held && held) {
          held = false
          log(`turn ${job.turnId}: lease lost, stopping`)
          child.kill('SIGTERM')
        }
      })
      .catch(() => {})
  }, HEARTBEAT_MS)

  const { code, signal } = await new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })))
  clearInterval(beat)

  // The session is written even when the turn failed: it is the half of the work that is not the answer.
  await saveSession(job, sessionFile, hadSession).catch((err) => log(`turn ${job.turnId}: ${err.message}`))
  const ok = code === 0
  const note = ok ? '' : `exited ${code ?? signal}${signal === 'SIGKILL' ? ' (out of memory?)' : ''}`
  await api('/runner/finish', { method: 'POST', body: JSON.stringify({ jobId: job.jobId, ok, note }) })
  log(`turn ${job.turnId} ${ok ? 'done' : `failed: ${note}`}`)
}

/** One turn at a time: this machine has one core's worth of memory, and Claude needs most of it. */
async function main() {
  log(`runner ${RUNNER_ID} polling ${ORIGIN}, work in ${WORKDIR}`)
  for (;;) {
    try {
      const job = await nextJob()
      if (job) await runTurn(job)
    } catch (err) {
      // A dead Worker or a dropped wifi is not a reason to exit: wait and ask again.
      log(`error: ${err.message}`)
      await new Promise((resolve) => setTimeout(resolve, 5_000))
    }
  }
}

process.on('SIGTERM', () => {
  log('stopping; a turn in flight will be handed to another machine when its lease runs out')
  process.exit(0)
})

main()
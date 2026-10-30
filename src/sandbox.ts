import { Sandbox as E2BSandbox } from 'e2b'
import { Sandbox as ImpelloSandbox } from '@impello/sdk'
import AGENT_INSTRUCTIONS from '../box/CLAUDE.md'
import RUNNER from '../box/run-turn.mjs'
import PROGRESS from '../box/progress.mjs'
import INBOX from '../box/inbox.mjs'
import INBOX_HOOK from '../box/inbox-hook.mjs'
import FILES from '../box/files.mjs'
import TOOLS from '../box/tools.mjs'
import MEMORY from '../box/memory.mjs'
import type { ManifestEntry } from './files.ts'
import { idlePauseMs, maxTurnMs, type Env } from './env.ts'

/**
 * The sandbox provider seam. E2B and Impello speak the same API (Impello's SDK is a clone of
 * E2B's), so the only differences are the class, the key and where the API lives.
 *
 * Every call passes the key and address explicitly. The SDKs can read them from process.env, but a
 * Worker's environment is the `env` object, so relying on that would work locally and fail deployed.
 */
export const IMPELLO_DOMAIN = 'sandbox.impello.ai'

type SandboxClass = typeof E2BSandbox

export function provider(env: Pick<Env, 'SANDBOX_PROVIDER' | 'SANDBOX_API_KEY'>): {
  Sandbox: SandboxClass
  conn: { apiKey: string; domain?: string }
} {
  const name = (env.SANDBOX_PROVIDER ?? '').toLowerCase()
  if (!env.SANDBOX_API_KEY) throw new Error('SANDBOX_API_KEY is not set. Run `npm run setup`.')
  if (name === 'e2b') return { Sandbox: E2BSandbox, conn: { apiKey: env.SANDBOX_API_KEY } }
  if (name === 'impello') {
    return {
      Sandbox: ImpelloSandbox as unknown as SandboxClass,
      conn: { apiKey: env.SANDBOX_API_KEY, domain: IMPELLO_DOMAIN },
    }
  }
  throw new Error(`SANDBOX_PROVIDER must be "e2b" or "impello", not "${env.SANDBOX_PROVIDER}".`)
}

const HOME = '/home/user'
const AGENT_DIR = `${HOME}/.agent`
export const RUNNER_PATH = `${AGENT_DIR}/run-turn.mjs`
/** The runner imports this from beside itself. */
const PROGRESS_PATH = `${AGENT_DIR}/progress.mjs`
/** Mid-turn messages: the runner and the Claude Code hook it sets both import inbox.mjs. */
const INBOX_PATH = `${AGENT_DIR}/inbox.mjs`
const INBOX_HOOK_PATH = `${AGENT_DIR}/inbox-hook.mjs`
/** Files from Slack: the runner imports files.mjs. Claude runs tools.mjs to post files and canvases. */
const FILES_PATH = `${AGENT_DIR}/files.mjs`
export const TOOLS_PATH = `${AGENT_DIR}/tools.mjs`
/** Memory: the runner imports memory.mjs to pull and push the channel's notes (src/memory.ts). */
const MEMORY_PATH = `${AGENT_DIR}/memory.mjs`
const INSTRUCTIONS_PATH = `${HOME}/.claude/CLAUDE.md`

/**
 * How long a sandbox may run before the provider pauses it on its own. This is a BACKSTOP: the
 * thread's alarm pauses it first (src/thread-state.ts). Refreshed every turn.
 *
 * Capped at 59 minutes because E2B's Hobby plan stops a sandbox after 1 hour of continuous running.
 */
function sandboxTimeoutMs(env: Env) {
  return Math.min(maxTurnMs(env) + idlePauseMs(env) + 5 * 60_000, 59 * 60_000)
}

function metadataFor(channel: string, threadTs: string) {
  return { slack_channel: channel, slack_thread: threadTs }
}

/**
 * The thread's sandbox, found by its metadata (paused ones included) or null. Never resumes it.
 *
 * No database maps threads to sandboxes: the sandbox carries its own thread in its metadata.
 * Two near-simultaneous creates can leave a thread with two boxes, so every caller converges on the
 * OLDEST, the one holding the session transcript.
 */
async function findSandboxId(env: Env, channel: string, threadTs: string): Promise<string | null> {
  const { Sandbox, conn } = provider(env)
  const matches = await Sandbox.list({ ...conn, query: { metadata: metadataFor(channel, threadTs) } }).nextItems()
  if (!matches.length) return null
  const [oldest] = [...matches].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime())
  return oldest.sandboxId
}

async function getOrCreateSandbox(env: Env, channel: string, threadTs: string) {
  const { Sandbox, conn } = provider(env)
  const timeoutMs = sandboxTimeoutMs(env)
  const existing = await findSandboxId(env, channel, threadTs)
  if (existing) {
    // connect() resumes a paused sandbox. Pass timeoutMs: connect's own default is 5 minutes,
    // which would pause the box in the middle of a turn.
    return Sandbox.connect(existing, { ...conn, timeoutMs })
  }
  return Sandbox.create(env.SANDBOX_TEMPLATE, {
    ...conn,
    metadata: metadataFor(channel, threadTs),
    timeoutMs,
    // NOT optional. The default is "kill", which deletes the disk and with it the Claude session
    // transcript: the thread's whole memory. A paused sandbox keeps its disk and costs no compute.
    lifecycle: { onTimeout: 'pause' },
  })
}

/** Pauses the thread's sandbox if it has one. Finds it by id and never connects (connect resumes). */
export async function pauseThreadSandbox(env: Env, channel: string, threadTs: string) {
  const id = await findSandboxId(env, channel, threadTs)
  if (!id) return
  const { Sandbox, conn } = provider(env)
  await Sandbox.pause(id, conn)
  console.log(`paused sandbox ${id} for ${channel}:${threadTs}`)
}

export interface Launch {
  channel: string
  threadTs: string
  turnId: string
  sessionId: string
  prompt: string
  callbackUrl: string
  callbackToken: string
  /** Where run-turn.mjs uploads the transcript after the turn, with the same token. */
  transcriptUrl: string
  /** Where run-turn.mjs reports what Claude is doing, and learns whether to stop. Same token. */
  progressUrl: string
  /** Where run-turn.mjs pulls the channel's memory before the turn and pushes it after. Same token. */
  memoryUrl: string
  /** The Worker's address. Claude's tools (box/tools.mjs) call its /sandbox/* doors. */
  origin: string
  /** Claude's own token for those doors: post a file or a canvas into this thread. */
  toolsToken: string
  /** The files the turn's messages carried, each with its download grant (src/files.ts). */
  files: ManifestEntry[]
  /** The Claude model id for `claude --model`. */
  model: string
  claudeEnvs: Record<string, string>
  /** The channel's secrets (src/channels.ts), for Claude. Only this channel's. */
  channelEnvs: Record<string, string>
  githubToken: string | null
  /** When the turn must end, in ms since the epoch. */
  deadline: number
}

/**
 * Starts one Claude turn in the thread's sandbox and returns at once. Claude keeps running in the
 * sandbox, and run-turn.mjs posts the answer to `callbackUrl` when it is done. Nothing in the
 * Worker waits for Claude, which is why a turn can run far longer than any Worker request.
 */
export async function launchTurn(env: Env, launch: Launch) {
  const sandbox = await getOrCreateSandbox(env, launch.channel, launch.threadTs)
  const promptPath = `${AGENT_DIR}/prompt-${launch.turnId}.txt`
  // The runner deletes it once the files are down: the grants in it are not Claude's business.
  const manifestPath = `${AGENT_DIR}/files-${launch.turnId}.json`

  // Written on every turn, so a redeploy reaches threads that are already running.
  // The prompt is untrusted Slack text: it goes in a file, never on a command line.
  await sandbox.files.write([
    { path: RUNNER_PATH, data: RUNNER },
    { path: PROGRESS_PATH, data: PROGRESS },
    { path: INBOX_PATH, data: INBOX },
    { path: INBOX_HOOK_PATH, data: INBOX_HOOK },
    { path: FILES_PATH, data: FILES },
    { path: TOOLS_PATH, data: TOOLS },
    { path: MEMORY_PATH, data: MEMORY },
    { path: INSTRUCTIONS_PATH, data: AGENT_INSTRUCTIONS },
    { path: promptPath, data: launch.prompt },
    ...(launch.files.length ? [{ path: manifestPath, data: JSON.stringify(launch.files) }] : []),
  ])

  if (launch.githubToken) {
    // git ignores GH_TOKEN (only `gh` reads it), so git gets a credential helper that reads it at
    // push time. The token is in no file and on no command line, and each turn brings a new one.
    await sandbox.commands.run(
      [
        'git config --global user.name "Slack Agent"',
        'git config --global user.email "slack-agent@users.noreply.github.com"',
        `git config --global credential.https://github.com.helper '!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f'`,
      ].join(' && '),
    )
  }

  // Envs go on the command, not on Sandbox.create: create-time envs do not reach the processes
  // that commands.run starts. `timeoutMs: 0` turns off the SDK's 60-second default, which would
  // otherwise kill every turn that takes longer than a minute, with no error anywhere.
  const handle = await sandbox.commands.run(`node ${RUNNER_PATH}`, {
    background: true,
    timeoutMs: 0,
    envs: {
      // FIRST, so every env below wins over a channel secret of the same name. The names are
      // checked too (src/channels.ts checkSecretName); this is the second guard.
      ...launch.channelEnvs,
      ...launch.claudeEnvs,
      ...(launch.githubToken ? { GH_TOKEN: launch.githubToken } : {}),
      HISTFILE: '/dev/null',
      TURN_ID: launch.turnId,
      SESSION_ID: launch.sessionId,
      PROMPT_FILE: promptPath,
      CALLBACK_URL: launch.callbackUrl,
      CALLBACK_TOKEN: launch.callbackToken,
      TRANSCRIPT_URL: launch.transcriptUrl,
      PROGRESS_URL: launch.progressUrl,
      MEMORY_URL: launch.memoryUrl,
      ...(launch.files.length ? { FILES_MANIFEST: manifestPath, FILE_URL: new URL('/sandbox/file', launch.origin).toString() } : {}),
      // Claude keeps these two (the runner strips only the reply token); box/tools.mjs uses them.
      AGENT_API_URL: launch.origin,
      AGENT_TOOLS_TOKEN: launch.toolsToken,
      CLAUDE_MODEL: launch.model,
      TURN_DEADLINE: String(launch.deadline),
      SLACK_CHANNEL: launch.channel,
      SLACK_THREAD_TS: launch.threadTs,
    },
  })
  // Stop listening. The process keeps running in the sandbox.
  await handle.disconnect()
  console.log(`launched turn ${launch.turnId} in sandbox ${sandbox.sandboxId} for ${launch.channel}:${launch.threadTs}`)
}

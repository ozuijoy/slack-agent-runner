// I-4: a sandbox is paused, never killed, on timeout, so the thread's Claude transcript survives.
// Read from disk because src/sandbox.ts imports text modules that only Wrangler can load.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'sandbox.ts'), 'utf8')

test("sandboxes are created with onTimeout: 'pause'", () => {
  assert.match(source, /lifecycle:\s*{\s*onTimeout:\s*'pause'\s*}/)
})

test('turns are launched detached with the 60-second default timeout turned off', () => {
  assert.match(source, /background:\s*true,\s*\n\s*timeoutMs:\s*0/)
})

test('the Slack bot token is never handed to a sandbox', () => {
  assert.doesNotMatch(source, /SLACK_BOT_TOKEN|SLACK_SIGNING_SECRET|CALLBACK_SECRET/)
})

test('Claude in the sandbox never gets the reply token', () => {
  const runner = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'box', 'run-turn.mjs'), 'utf8')
  assert.match(runner, /const { CALLBACK_TOKEN: _t, CALLBACK_URL: _u, TRANSCRIPT_URL: _x, PROGRESS_URL: _p, FILES_MANIFEST: _m, FILE_URL: _f, MEMORY_URL: _y, \.\.\.childEnv } = env/)
  assert.match(runner, /env: { \.\.\.childEnv, AGENT_INBOX: INBOX },/)
})

test('the runner passes the thread model to claude and backs up the transcript without delaying the answer', () => {
  const runner = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'box', 'run-turn.mjs'), 'utf8')
  assert.match(runner, /\['--model', env\.CLAUDE_MODEL\]/)
  // The upload sends no key or path: the Worker builds the key from the token.
  assert.match(runner, /'x-turn-id': env\.TURN_ID/)
  // The transcript is read under the lock; the upload runs beside the answer, never before it
  // (test/run-turn.test.ts runs the runner against a hanging upload).
  assert.ok(runner.indexOf('snapshot = snapshotTranscript()') < runner.lastIndexOf('rmSync(LOCK, { force: true })'))
  assert.match(runner, /await Promise\.all\(\[report\(result\), uploadTranscript\(snapshot\), pushMemory\(memorySnapshot\)\]\)/)
})

test('the sandbox gets the model and the transcript door', () => {
  assert.match(source, /TRANSCRIPT_URL: launch\.transcriptUrl/)
  assert.match(source, /CLAUDE_MODEL: launch\.model/)
})

test('the sandbox gets the progress door and the helper the runner imports', () => {
  assert.match(source, /PROGRESS_URL: launch\.progressUrl/)
  assert.match(source, /{ path: PROGRESS_PATH, data: PROGRESS }/)
  const runner = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'box', 'run-turn.mjs'), 'utf8')
  assert.match(runner, /from '\.\/progress\.mjs'/)
})

test('the sandbox gets the inbox helper and hook for mid-turn messages', () => {
  assert.match(source, /{ path: INBOX_PATH, data: INBOX }/)
  assert.match(source, /{ path: INBOX_HOOK_PATH, data: INBOX_HOOK }/)
  const runner = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'box', 'run-turn.mjs'), 'utf8')
  assert.match(runner, /from '\.\/inbox\.mjs'/)
  assert.match(runner, /'--settings', JSON\.stringify\(hookSettings\(/)
})

test('the sandbox gets the file helper and Claude gets its tools, with their own token', () => {
  assert.match(source, /{ path: FILES_PATH, data: FILES }/)
  assert.match(source, /{ path: TOOLS_PATH, data: TOOLS }/)
  assert.match(source, /AGENT_TOOLS_TOKEN: launch\.toolsToken/)
  const runner = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'box', 'run-turn.mjs'), 'utf8')
  assert.match(runner, /from '\.\/files\.mjs'/)
  // The download grants are read and deleted before Claude starts.
  assert.ok(runner.indexOf('await fetchFiles(workDir)') < runner.indexOf("spawn('claude'"))
})

test('memory: the runner pulls before Claude, reads changes under the lock, and pushes beside the answer', () => {
  assert.match(source, /{ path: MEMORY_PATH, data: MEMORY }/)
  assert.match(source, /MEMORY_URL: launch\.memoryUrl/)
  const runner = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'box', 'run-turn.mjs'), 'utf8')
  assert.match(runner, /from '\.\/memory\.mjs'/)
  assert.ok(runner.indexOf('await loadMemory()') < runner.indexOf("spawn('claude'"))
  assert.ok(runner.indexOf('memorySnapshot = snapshotMemory()') < runner.lastIndexOf('rmSync(LOCK, { force: true })'))
})

test('memory: the sandbox never gets a token for the memory repo', () => {
  const turn = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'turn.ts'), 'utf8')
  // The turn's GitHub token is minted for every repo but the memory repo (src/github.ts).
  assert.match(turn, /githubToken = await mintTurnToken\(env\)/)
  assert.doesNotMatch(turn, /mintInstallationToken/)
  assert.doesNotMatch(source, /MEMORY_REPO|mintInstallationToken/)
})

test("channel secrets: only the turn's own channel's, spread first so no built-in env can be overridden", () => {
  // The first entry of the runner's envs; everything after it wins over a secret of the same name.
  assert.match(source, /envs: {\s*\n(\s*\/\/.*\n)*\s*\.\.\.launch\.channelEnvs,\s*\n\s*\.\.\.launch\.claudeEnvs,/)
  assert.doesNotMatch(source, /CHANNEL_SECRETS_KEY/)
  const turn = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'turn.ts'), 'utf8')
  // The channel comes from the queued job, never from anything the sandbox sent.
  assert.match(turn, /const { channel, threadTs, turn } = job/)
  assert.match(turn, /channelSecretsForTurn\(env, channel\)/)
  assert.match(turn, /channelEnvs: secrets\.envs/)
})

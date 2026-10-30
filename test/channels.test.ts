// Channel settings: watched channels, the channel's default model, and per-channel secrets that are
// encrypted, bound to their channel, and reach only that channel's sandbox.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  checkSecretName,
  checkSecretValue,
  isChannelId,
  MAX_SECRET_BYTES,
  openSecret,
  sealSecret,
  secretsForTurn,
  secretsKey,
  settingsFromRow,
  startsWatchedThread,
} from '../src/channels.ts'

const KEY = 'a'.repeat(64)
const OTHER_KEY = 'b'.repeat(64)

test('a channel with no row is not watched and has no default model', () => {
  assert.deepEqual(settingsFromRow('CHANNELA', null), { channel: 'CHANNELA', watched: false, model: null })
  assert.deepEqual(settingsFromRow('CHANNELA', { channel: 'CHANNELA', watched: 1, default_model: 'sonnet' }), {
    channel: 'CHANNELA',
    watched: true,
    model: 'sonnet',
  })
})

test('a default model that no longer exists reads as unset', () => {
  assert.equal(settingsFromRow('CHANNELA', { channel: 'CHANNELA', watched: 0, default_model: 'gpt' }).model, null)
  assert.equal(settingsFromRow('CHANNELA', { channel: 'CHANNELA', watched: 0, default_model: '__proto__' }).model, null)
})

test('only a root message in a watched channel starts a thread without a mention', () => {
  const watched = { watched: true }
  assert.equal(startsWatchedThread({ isDm: false }, watched), true)
  assert.equal(startsWatchedThread({ isDm: false, threadTs: '1.0' }, watched), false, 'a reply in a thread it does not answer')
  assert.equal(startsWatchedThread({ isDm: true }, watched), false, 'DMs need no watching')
  assert.equal(startsWatchedThread({ isDm: false }, { watched: false }), false)
})

test('channel ids are Slack conversation ids', () => {
  assert.equal(isChannelId('CHANNELA'), true)
  assert.equal(isChannelId('GPRIVATE1'), true)
  assert.equal(isChannelId('DDIRECT1'), true)
  assert.equal(isChannelId('channel'), false)
  assert.equal(isChannelId('UUSER1'), false)
  assert.equal(isChannelId('C1; DROP TABLE'), false)
  assert.equal(isChannelId(undefined), false)
})

test('a secret name is an env var name the sandbox does not use itself', () => {
  assert.deepEqual(checkSecretName('STRIPE_KEY'), { ok: true, value: 'STRIPE_KEY' })
  for (const bad of ['', 'lower', '1ABC', 'A-B', 'A B', 'X'.repeat(65), 42, null]) {
    assert.equal(checkSecretName(bad).ok, false, String(bad))
  }
  for (const reserved of ['PATH', 'HOME', 'GH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CALLBACK_TOKEN', 'AGENT_TOOLS_TOKEN', 'TURN_ID', 'SLACK_CHANNEL', 'NODE_OPTIONS', 'LD_PRELOAD', 'GIT_SSH_COMMAND', 'BASH_ENV']) {
    assert.equal(checkSecretName(reserved).ok, false, reserved)
  }
})

test('a secret value is non-empty text with no NUL, under the size cap', () => {
  assert.equal(checkSecretValue('sk_live_123').ok, true)
  assert.equal(checkSecretValue('').ok, false)
  assert.equal(checkSecretValue(5).ok, false)
  assert.equal(checkSecretValue('a\0b').ok, false)
  assert.equal(checkSecretValue('x'.repeat(MAX_SECRET_BYTES)).ok, true)
  assert.equal(checkSecretValue('x'.repeat(MAX_SECRET_BYTES + 1)).ok, false)
})

test('the key must be 64 hex characters, and a missing key says how to make one', async () => {
  await assert.rejects(secretsKey(undefined), /not set.*npm run setup/)
  await assert.rejects(secretsKey('short'), /64 hex/)
  await secretsKey(KEY)
})

test('a sealed secret opens with the same key, channel and name', async () => {
  const key = await secretsKey(KEY)
  const sealed = await sealSecret(key, 'CHANNELA', 'STRIPE_KEY', 'sk_live_123')
  assert.ok(!sealed.ciphertext.includes('sk_live'), 'the value is not stored in the clear')
  assert.equal(await openSecret(key, 'CHANNELA', 'STRIPE_KEY', sealed), 'sk_live_123')
})

test('every write uses a fresh IV', async () => {
  const key = await secretsKey(KEY)
  const a = await sealSecret(key, 'CHANNELA', 'STRIPE_KEY', 'same')
  const b = await sealSecret(key, 'CHANNELA', 'STRIPE_KEY', 'same')
  assert.notEqual(a.iv, b.iv)
  assert.notEqual(a.ciphertext, b.ciphertext)
})

test('a secret moved to another channel or renamed does not open', async () => {
  const key = await secretsKey(KEY)
  const sealed = await sealSecret(key, 'CHANNELA', 'STRIPE_KEY', 'sk_live_123')
  await assert.rejects(openSecret(key, 'CHANNELB', 'STRIPE_KEY', sealed))
  await assert.rejects(openSecret(key, 'CHANNELA', 'OTHER_KEY', sealed))
  await assert.rejects(openSecret(await secretsKey(OTHER_KEY), 'CHANNELA', 'STRIPE_KEY', sealed))
})

test('a turn gets the opened secrets as envs, and the prompt names them but never shows a value', () => {
  const { envs, note } = secretsForTurn([
    { name: 'STRIPE_KEY', value: 'sk_live_123' },
    { name: 'API_TOKEN', value: 'tok_abc' },
    { name: 'BROKEN', value: null },
    // Written before PATH became reserved, say: it must not reach the sandbox.
    { name: 'PATH', value: '/evil' },
  ])
  assert.deepEqual(envs, { STRIPE_KEY: 'sk_live_123', API_TOKEN: 'tok_abc' })
  assert.match(note, /API_TOKEN, STRIPE_KEY/)
  assert.match(note, /could not be opened.*BROKEN/)
  assert.ok(!note.includes('sk_live_123') && !note.includes('tok_abc') && !note.includes('PATH'))
})

test('a channel with no secrets adds nothing to the prompt', () => {
  assert.deepEqual(secretsForTurn([]), { envs: {}, note: '' })
})

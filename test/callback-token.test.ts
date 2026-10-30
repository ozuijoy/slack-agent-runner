// I-2: the sandbox holds only a one-turn token, and the callback refuses anything else.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { signCallbackToken, verifyCallbackToken } from '../src/callback-token.ts'

const SECRET = 'test-secret-0123456789'
const claims = { channel: 'C1', threadTs: '111.222', turnId: 'turn-a', lastTs: '111.300', exp: Date.now() + 60_000 }

test('accepts a valid token for its own turn', async () => {
  const token = await signCallbackToken(SECRET, claims)
  const result = await verifyCallbackToken(SECRET, token, 'turn-a')
  assert.equal(result.ok, true)
  if (result.ok) assert.deepEqual(result.claims, claims)
})

test('refuses no token', async () => {
  assert.deepEqual(await verifyCallbackToken(SECRET, null, 'turn-a'), { ok: false, reason: 'missing token' })
})

test('refuses a token for another turn (and so another thread)', async () => {
  const token = await signCallbackToken(SECRET, claims)
  assert.deepEqual(await verifyCallbackToken(SECRET, token, 'turn-b'), { ok: false, reason: 'token is for another turn' })
})

test('refuses an expired token, including one that expires exactly now', async () => {
  const token = await signCallbackToken(SECRET, { ...claims, exp: 1_000 })
  assert.deepEqual(await verifyCallbackToken(SECRET, token, 'turn-a', 1_000), { ok: false, reason: 'expired' })
})

test('refuses a token signed with another secret', async () => {
  const token = await signCallbackToken('another-secret', claims)
  assert.deepEqual(await verifyCallbackToken(SECRET, token, 'turn-a'), { ok: false, reason: 'bad signature' })
})

test('refuses a token whose claims were edited', async () => {
  const token = await signCallbackToken(SECRET, claims)
  const [, sig] = token.split('.')
  const forged = Buffer.from(JSON.stringify({ ...claims, channel: 'C-other' })).toString('base64url')
  assert.deepEqual(await verifyCallbackToken(SECRET, `${forged}.${sig}`, 'turn-a'), { ok: false, reason: 'bad signature' })
})

test('refuses garbage', async () => {
  assert.equal((await verifyCallbackToken(SECRET, 'not-a-token', 'turn-a')).ok, false)
  assert.equal((await verifyCallbackToken(SECRET, 'a.b', 'turn-a')).ok, false)
})

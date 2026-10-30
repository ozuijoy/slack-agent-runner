// Channel settings in D1 (src/channel-store.ts), against a real SQLite database built from the
// migrations/ files, behind a small stand-in for the D1 binding.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import {
  channelSecretsForTurn,
  channelSettings,
  deleteChannelSecret,
  listChannels,
  putChannelSecret,
  setChannelModel,
  setWatched,
} from '../src/channel-store.ts'
import { MAX_SECRETS_PER_CHANNEL } from '../src/channels.ts'

const KEY = '0123456789abcdef'.repeat(4)

/** Enough of D1 for src/db.ts: prepare().bind().run() / all() / first(). */
function fakeD1() {
  const sqlite = new DatabaseSync(':memory:')
  for (const file of readdirSync('migrations').filter((f) => f.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(`migrations/${file}`, 'utf8'))
  }
  const DB = {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          const stmt = sqlite.prepare(sql)
          const args = params as never[]
          return {
            run: async () => stmt.run(...args),
            all: async () => ({ results: stmt.all(...args).map((r) => ({ ...r })) }),
            first: async () => {
              const row = stmt.get(...args)
              return row ? { ...row } : null
            },
          }
        },
      }
    },
  }
  return { sqlite, env: { DB, CHANNEL_SECRETS_KEY: KEY } as never as { DB: D1Database; CHANNEL_SECRETS_KEY?: string } }
}

test('a channel with no row has the defaults', async () => {
  const { env } = fakeD1()
  assert.deepEqual(await channelSettings(env, 'CHANNELA'), { channel: 'CHANNELA', watched: false, model: null })
})

test('watching and the default model are set separately, and each keeps the other', async () => {
  const { env } = fakeD1()
  await setWatched(env, 'CHANNELA', true, 'me@example.com')
  await setChannelModel(env, 'CHANNELA', 'haiku')
  assert.deepEqual(await channelSettings(env, 'CHANNELA'), { channel: 'CHANNELA', watched: true, model: 'haiku' })
  await setWatched(env, 'CHANNELA', false)
  assert.deepEqual(await channelSettings(env, 'CHANNELA'), { channel: 'CHANNELA', watched: false, model: 'haiku' })
  await setChannelModel(env, 'CHANNELA', null)
  assert.deepEqual(await channelSettings(env, 'CHANNELA'), { channel: 'CHANNELA', watched: false, model: null })
})

test('an unknown model or a bad channel id is refused before anything is written', async () => {
  const { env, sqlite } = fakeD1()
  assert.equal((await setChannelModel(env, 'CHANNELA', 'gpt')).ok, false)
  assert.equal((await setWatched(env, 'not-a-channel', true)).ok, false)
  assert.equal((await putChannelSecret(env, 'nope', 'API_KEY', 'v')).ok, false)
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM channel_settings').get()?.n, 0)
})

test('a secret is stored encrypted, and only its own channel gets it', async () => {
  const { env, sqlite } = fakeD1()
  assert.deepEqual(await putChannelSecret(env, 'CHANNELA', 'STRIPE_KEY', 'sk_live_123', 'me@example.com'), { ok: true, value: 'STRIPE_KEY' })
  const raw = JSON.stringify(sqlite.prepare('SELECT * FROM channel_secrets').all())
  assert.ok(!raw.includes('sk_live_123'), 'no plain value in the database')

  assert.deepEqual((await channelSecretsForTurn(env, 'CHANNELA')).envs, { STRIPE_KEY: 'sk_live_123' })
  assert.deepEqual(await channelSecretsForTurn(env, 'CHANNELB'), { envs: {}, note: '' })
})

test('putting a secret again replaces it, and deleting removes it', async () => {
  const { env } = fakeD1()
  await putChannelSecret(env, 'CHANNELA', 'API_KEY', 'one')
  await putChannelSecret(env, 'CHANNELA', 'API_KEY', 'two')
  assert.deepEqual((await channelSecretsForTurn(env, 'CHANNELA')).envs, { API_KEY: 'two' })
  await deleteChannelSecret(env, 'CHANNELA', 'API_KEY')
  assert.deepEqual((await channelSecretsForTurn(env, 'CHANNELA')).envs, {})
})

test('a bad name or value is refused', async () => {
  const { env } = fakeD1()
  assert.equal((await putChannelSecret(env, 'CHANNELA', 'GH_TOKEN', 'x')).ok, false)
  assert.equal((await putChannelSecret(env, 'CHANNELA', 'API_KEY', '')).ok, false)
})

test('a channel holds a bounded number of secrets, but one can still be replaced at the cap', async () => {
  const { env } = fakeD1()
  for (let i = 0; i < MAX_SECRETS_PER_CHANNEL; i++) assert.equal((await putChannelSecret(env, 'CHANNELA', `KEY_${i}`, 'v')).ok, true)
  assert.equal((await putChannelSecret(env, 'CHANNELA', 'ONE_MORE', 'v')).ok, false)
  assert.equal((await putChannelSecret(env, 'CHANNELA', 'KEY_0', 'new')).ok, true)
  assert.equal((await putChannelSecret(env, 'CHANNELB', 'ONE_MORE', 'v')).ok, true)
})

test('a row copied into another channel does not open there', async () => {
  const { env, sqlite } = fakeD1()
  await putChannelSecret(env, 'CHANNELA', 'API_KEY', 'secret-a')
  sqlite.exec(`INSERT INTO channel_secrets (channel, name, iv, ciphertext, updated_at)
    SELECT 'CHANNELB', name, iv, ciphertext, updated_at FROM channel_secrets WHERE channel = 'CHANNELA'`)
  const turn = await channelSecretsForTurn(env, 'CHANNELB')
  assert.deepEqual(turn.envs, {})
  assert.match(turn.note, /could not be opened.*API_KEY/)
})

test('without the key, a turn goes on without its secrets and the prompt says so', async () => {
  const { env } = fakeD1()
  await putChannelSecret(env, 'CHANNELA', 'API_KEY', 'v')
  const turn = await channelSecretsForTurn({ ...env, CHANNEL_SECRETS_KEY: undefined }, 'CHANNELA')
  assert.deepEqual(turn.envs, {})
  assert.match(turn.note, /could not be opened.*API_KEY/)
})

test('setting a secret without the key fails loudly instead of storing it in the clear', async () => {
  const { env, sqlite } = fakeD1()
  await assert.rejects(putChannelSecret({ ...env, CHANNEL_SECRETS_KEY: undefined }, 'CHANNELA', 'API_KEY', 'v'), /CHANNEL_SECRETS_KEY/)
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM channel_secrets').get()?.n, 0)
})

test('the Channels page lists settings and secret NAMES, never values', async () => {
  const { env } = fakeD1()
  await setWatched(env, 'CHANNELB', true)
  await putChannelSecret(env, 'CHANNELA', 'ZED', 'value-z')
  await putChannelSecret(env, 'CHANNELA', 'ALPHA', 'value-a')
  const list = await listChannels(env)
  assert.deepEqual(list, [
    { channel: 'CHANNELA', watched: false, model: null, secrets: ['ALPHA', 'ZED'] },
    { channel: 'CHANNELB', watched: true, model: null, secrets: [] },
  ])
  assert.ok(!JSON.stringify(list).includes('value-'))
})

// R2 transcript backup: the key comes from the signed token claims only, one object per turn.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { recentThreads, recordTranscript, threadTranscripts } from '../src/db.ts'
import { checkTranscriptSize, MAX_TRANSCRIPT_BYTES, transcriptKey, transcriptPrefix } from '../src/transcripts.ts'

const claims = { channel: 'C1', threadTs: '111.222', turnId: 'turn-a', lastTs: '111.300' }

test('the key is the thread prefix plus the turn, so every turn writes a new object', () => {
  assert.equal(transcriptKey(claims), 'transcripts/C1/111.222/111.300-turn-a.jsonl.gz')
  assert.ok(transcriptKey(claims).startsWith(transcriptPrefix('C1', '111.222')))
  assert.notEqual(transcriptKey(claims), transcriptKey({ ...claims, turnId: 'turn-b', lastTs: '111.400' }))
})

test('refuses a missing, empty or oversized body before reading it', () => {
  assert.equal(checkTranscriptSize(null)?.status, 411)
  assert.equal(checkTranscriptSize('abc')?.status, 411)
  assert.equal(checkTranscriptSize('0')?.status, 400)
  assert.equal(checkTranscriptSize(String(MAX_TRANSCRIPT_BYTES + 1))?.status, 413)
  assert.equal(checkTranscriptSize('1234'), null)
})

test('the transcript door builds its key from the verified claims, never from the request', () => {
  const index = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.ts'), 'utf8')
  const door = index.slice(index.indexOf('async function sandboxTranscript'), index.indexOf('function stripMention'))
  assert.match(door, /verifyCallbackToken\(env\.CALLBACK_SECRET, token, turnId\)/)
  assert.match(door, /const key = transcriptKey\(claims\)/)
  assert.doesNotMatch(door, /\.delete\(/)
  assert.doesNotMatch(door, /searchParams|request\.json/)
})

test('the index lists threads newest first, and one thread\'s backups newest first', async () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const sqlite = new DatabaseSync(':memory:')
  for (const file of readdirSync(join(root, 'migrations')).filter((f) => f.endsWith('.sql')).sort()) sqlite.exec(readFileSync(join(root, 'migrations', file), 'utf8'))
  const DB = {
    prepare: (sql: string) => ({
      bind: (...params: unknown[]) => {
        const stmt = sqlite.prepare(sql)
        const args = params as never[]
        return { run: async () => stmt.run(...args), all: async () => ({ results: stmt.all(...args).map((r) => ({ ...r })) }), first: async () => null }
      },
    }),
  }
  const env = { DB } as never as { DB: D1Database }
  const row = (channel: string, thread: string, turn: string, at: number) => ({ key: `k-${turn}`, channel, thread_ts: thread, turn_id: turn, bytes: 10, created_at: at })
  await recordTranscript(env, row('CHANNELA', '1.1', 't1', 100))
  await recordTranscript(env, row('CHANNELA', '1.1', 't2', 300))
  await recordTranscript(env, row('CHANNELB', '2.2', 't3', 200))
  assert.deepEqual(await recentThreads(env), [
    { channel: 'CHANNELA', thread_ts: '1.1', last_at: 300, turns: 2 },
    { channel: 'CHANNELB', thread_ts: '2.2', last_at: 200, turns: 1 },
  ])
  assert.deepEqual((await threadTranscripts(env, 'CHANNELA', '1.1')).map((r) => r.turn_id), ['t2', 't1'])
})

test('the progress door keeps live entries only for the turn running in the token\'s thread', () => {
  const index = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.ts'), 'utf8')
  const door = index.slice(index.indexOf('async function sandboxProgress'), index.indexOf('async function slackInteractive'))
  assert.ok(door.indexOf('if (!view.running)') < door.indexOf('appendLive('))
  assert.match(door, /thread\.appendLive\(turnId, entries\)/)
  const state = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'thread-state.ts'), 'utf8')
  assert.match(state, /data\.running\.turnId !== turnId/)
})

// Workspace search: public channels only, Slack's action token kept by the thread, never the sandbox.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  checkSearch,
  isPublicChannel,
  MAX_RESULT_CHARS,
  MAX_RESULTS,
  normalise,
  publicOnly,
  resultsOf,
  searchArgs,
  searchErrorHint,
} from '../src/search.ts'
import { accept, emptyThread, finish, progressView, searchView } from '../src/thread.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const { parseArgs, run, formatResults } = await import(pathToFileURL(join(root, 'box', 'tools.mjs')).href)

test('the search request is checked, and only the query and a count are read', () => {
  assert.deepEqual(checkSearch({ query: '  launch date ', limit: 5 }), { ok: true, query: 'launch date', limit: 5 })
  assert.deepEqual(checkSearch({ query: 'x' }), { ok: true, query: 'x', limit: 10 })
  assert.deepEqual(checkSearch({ query: 'x', limit: 500 }), { ok: true, query: 'x', limit: MAX_RESULTS })
  assert.equal(checkSearch({ query: '   ' }).ok, false)
  assert.equal(checkSearch({ query: 'x'.repeat(501) }).ok, false)
  assert.equal(checkSearch({ query: 'x', limit: 0 }).ok, false)
  assert.equal(checkSearch({ query: 'x', limit: '3' }).ok, false)
  assert.equal(checkSearch(null).ok, false)
})

test('Slack is always asked for public-channel messages, whatever the caller wants', () => {
  const args = searchArgs('q', 5, 'act.1')
  assert.equal(args.channel_types, 'public_channel')
  assert.equal(args.content_types, 'messages')
  assert.equal(args.action_token, 'act.1')
  assert.equal('action_token' in searchArgs('q', 5), false, 'no empty token is sent')
  assert.equal('action_token' in searchArgs('q', 5, ''), false)
})

test('both of Slack’s result shapes read the same, and long text is capped', () => {
  const a = normalise({ channel_id: 'C1', channel_name: 'general', message_ts: '1.2', author_user_id: 'U1', content: ' hi ', permalink: 'https://p' })
  const b = normalise({ channel: { id: 'C1', name: 'general' }, ts: '1.2', user: 'U1', text: 'hi', permalink: 'https://p' })
  assert.deepEqual(a, b)
  assert.deepEqual(a, { channelId: 'C1', channelName: 'general', ts: '1.2', user: 'U1', text: 'hi', permalink: 'https://p' })
  assert.equal(normalise({ content: 'x'.repeat(MAX_RESULT_CHARS + 50) }).text.length, MAX_RESULT_CHARS + 1)
  assert.deepEqual(resultsOf({ results: { messages: [{ a: 1 }, null, 'x'] } }), [{ a: 1 }])
  assert.deepEqual(resultsOf({ messages: [{ b: 1 }] }), [{ b: 1 }])
  assert.deepEqual(resultsOf({}), [])
})

test('only a channel Slack calls public counts as public', () => {
  assert.equal(isPublicChannel({ is_channel: true, is_private: false }), true)
  assert.equal(isPublicChannel({ is_channel: true, is_private: true }), false)
  assert.equal(isPublicChannel({ is_channel: true }), false, 'a missing is_private is not public')
  assert.equal(isPublicChannel({ is_im: true, is_private: false }), false)
  assert.equal(isPublicChannel({ is_mpim: true, is_channel: true, is_private: false }), false)
  assert.equal(isPublicChannel({ is_group: true, is_channel: true, is_private: false }), false)
  assert.equal(isPublicChannel(null), false)
})

test('results from private channels, DMs, unknown channels and failed lookups are dropped', async () => {
  const channels: Record<string, Record<string, unknown> | null> = {
    C1: { is_channel: true, is_private: false, name: 'general' },
    C2: { is_channel: true, is_private: true, name: 'secret' },
    D1: { is_im: true },
    G1: { is_mpim: true, is_private: true },
    C404: null,
  }
  const looked: string[] = []
  const lookup = async (id: string) => {
    looked.push(id)
    if (id === 'CERR') throw new Error('ratelimited')
    return channels[id] ?? null
  }
  const hit = (channelId: string, text: string) => ({ channelId, channelName: '', ts: '1.0', user: 'U1', text, permalink: '' })
  const { hits, dropped } = await publicOnly(
    [hit('C1', 'a'), hit('C2', 'b'), hit('D1', 'c'), hit('G1', 'd'), hit('C404', 'e'), hit('CERR', 'f'), hit('', 'g'), hit('C1', 'h')],
    lookup,
  )
  assert.deepEqual(hits.map((h) => h.text), ['a', 'h'])
  assert.equal(hits[0].channelName, 'general', 'the name comes from the lookup when the result has none')
  assert.equal(dropped, 6)
  assert.deepEqual(looked.sort(), ['C1', 'C2', 'C404', 'CERR', 'D1', 'G1'], 'each channel is looked up once')
})

test('a refused search tells Claude what to do next', () => {
  assert.match(searchErrorHint('slack assistant.search.context: missing_scope', true), /search:read\.public.*reinstall/)
  assert.match(searchErrorHint('slack assistant.search.context: invalid_action_token', true), /expired.*@mention/)
  assert.match(searchErrorHint('slack assistant.search.context: not_allowed_token_type', false), /@mention or a DM/)
  assert.equal(searchErrorHint('slack assistant.search.context: ratelimited', true), 'slack assistant.search.context: ratelimited')
})

// Rule 8 in src/thread.ts.
test('the running turn keeps the newest action token, and only that turn can read it', () => {
  let n = 0
  const clock = { now: 1, newTurnId: () => `turn-${++n}` }
  const data = emptyThread('C1', '100.0', 'https://agent.example')
  const r = accept(data, { ts: '100.0', user: 'U1', text: 'hi', actionToken: 'act.1' }, { mention: true, ...clock })
  assert.equal(r.action, 'start')
  assert.deepEqual(searchView(data, 'turn-1'), { running: true, actionToken: 'act.1' })

  // A follow-up without one keeps the turn's; a mention mid-turn brings a fresher one.
  accept(data, { ts: '101.0', user: 'U2', text: 'also' }, { mention: false, ...clock })
  assert.deepEqual(searchView(data, 'turn-1'), { running: true, actionToken: 'act.1' })
  accept(data, { ts: '102.0', user: 'U2', text: 'and', actionToken: 'act.2' }, { mention: true, ...clock })
  assert.deepEqual(searchView(data, 'turn-1'), { running: true, actionToken: 'act.2' })

  // The progress report hands follow-ups to the sandbox; the token never rides along.
  const view = progressView(data, 'turn-1')
  assert.ok(view.running)
  if (view.running) assert.equal(JSON.stringify(view.inbox.map(({ ts, user, text }) => ({ ts, user, text }))).includes('act.'), false)

  assert.deepEqual(searchView(data, 'turn-9'), { running: false })
  finish(data, 'turn-1', { answered: true, taken: ['101.0', '102.0'], ...clock })
  assert.deepEqual(searchView(data, 'turn-1'), { running: false }, 'a finished turn cannot search')
})

test('a turn started from queued messages takes the newest token among them', () => {
  let n = 0
  const clock = { now: 1, newTurnId: () => `turn-${++n}` }
  const data = emptyThread('C1', '100.0', 'https://agent.example')
  accept(data, { ts: '100.0', user: 'U1', text: 'hi' }, { mention: true, ...clock })
  // Files make a follow-up queue for the next turn instead of joining (rule 7).
  accept(data, { ts: '101.0', user: 'U1', text: 'a', hasFiles: true, actionToken: 'act.old' }, { mention: true, ...clock })
  accept(data, { ts: '102.0', user: 'U1', text: 'b', actionToken: 'act.new' }, { mention: true, ...clock })
  assert.deepEqual(searchView(data, 'turn-1'), { running: true })
  const done = finish(data, 'turn-1', { answered: true, ...clock })
  assert.ok(done.accepted && done.next)
  assert.deepEqual(searchView(data, 'turn-2'), { running: true, actionToken: 'act.new' })
})

test('the search door takes the thread from the tools token and the action token from the thread', () => {
  const index = readFileSync(join(root, 'src', 'index.ts'), 'utf8')
  const start = index.indexOf('async function sandboxSearch')
  const door = index.slice(start, index.indexOf('\n}\n', start))
  assert.match(door, /'tools'\)/)
  assert.match(door, /const { channel, threadTs, turnId } = verified\.claims/)
  assert.match(door, /searchView\(turnId\)/)
  assert.match(door, /publicOnly\(/)
  assert.doesNotMatch(door, /body\??\.(channel|threadTs|thread_ts|action_token|actionToken|channel_types)/)
  // The sandbox launch never carries the action token.
  const turn = readFileSync(join(root, 'src', 'turn.ts'), 'utf8')
  const sandbox = readFileSync(join(root, 'src', 'sandbox.ts'), 'utf8')
  assert.doesNotMatch(turn + sandbox, /actionToken|action_token/)
})

test('search on the command line: one quoted query and an optional limit', () => {
  assert.deepEqual(parseArgs(['search', 'launch date']), { command: 'search', query: 'launch date' })
  assert.deepEqual(parseArgs(['search', 'launch', '--limit', '5']), { command: 'search', query: 'launch', limit: 5 })
  assert.ok(parseArgs(['search']).error)
  assert.ok(parseArgs(['search', 'a', 'b']).error, 'an unquoted query is refused, not half-searched')
  assert.ok(parseArgs(['search', 'a', '--limit', '50']).error)
  assert.ok(parseArgs(['search', 'a', '--title', 'x']).error)
  assert.ok(parseArgs(['search', 'a', '--channel', 'C9']).error)
  assert.ok(parseArgs(['upload', 'f', '--limit', '3']).error)
})

test('search calls the Worker with the tools token and prints the results with their links', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetchImpl = async (url: URL, init: RequestInit) => {
    calls.push({ url: String(url), init })
    return Response.json({
      ok: true,
      results: [{ channelId: 'C1', channelName: 'general', ts: '1700000000.000100', user: 'U1', text: 'ship on Friday', permalink: 'https://s/p1' }],
    })
  }
  const env = { AGENT_API_URL: 'https://w.example', AGENT_TOOLS_TOKEN: 'tok', TURN_ID: 't1' }
  const out = await run({ command: 'search', query: 'launch', limit: 3 }, { env, fetchImpl })
  assert.equal(calls[0].url, 'https://w.example/sandbox/search')
  assert.equal((calls[0].init.headers as Record<string, string>).authorization, 'Bearer tok')
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { turnId: 't1', query: 'launch', limit: 3 })
  assert.match(out, /public channels only/)
  assert.match(out, /\[2023-11-14 22:13\] #general <@U1>\nship on Friday\nhttps:\/\/s\/p1/)

  assert.match(formatResults('x', []), /No public-channel messages.*never searched/)
  assert.match(formatResults('x', [{}, {}]), /WARNING: every result came back empty/)
  const refuse = async () => Response.json({ ok: false, error: 'not_allowed_token_type: ask the person to @mention the bot' }, { status: 502 })
  await assert.rejects(run({ command: 'search', query: 'x' }, { env, fetchImpl: refuse }), /refused: not_allowed_token_type/)
})

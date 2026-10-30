// Slack code channels (beta): the rules (src/code-channels.ts), the door's Slack side
// (src/code-channel-door.ts), the thread's once-only note (src/thread.ts rule 10), and Claude's
// `code-channel` command (box/tools.mjs).
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { codeChannelAction, type CodeChannelDeps } from '../src/code-channel-door.ts'
import {
  ACTIONS,
  checkCodeChannelAction,
  codeChannelOrigin,
  isContextRoot,
  isFeatureOff,
  MAX_TEXT_CHARS,
  MAX_VIEW_BYTES,
  slackErrorCode,
} from '../src/code-channels.ts'
import { formValue } from '../src/slack.ts'
import { accept, emptyThread, noteOnce } from '../src/thread.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const { parseArgs, run, viewFrom } = await import(pathToFileURL(join(root, 'box', 'tools.mjs')).href)

const CODE_INFO = {
  id: 'C0CODE',
  properties: {
    record_channel: { record_type: 'agent_channel', record_id: 'AC:T1:C0ORIGIN-1792066248.979529' },
    agent_session: { origin_link: { channel_id: 'C0ORIGIN', ts: '1792066248.979529' } },
  },
}
const PLAIN_INFO = { id: 'C0PLAIN', is_channel: true }

/** A Slack stand-in: each method answers from `answers`, or throws as slackApi does. */
function fakeDeps(answers: Record<string, (args: Record<string, unknown>) => unknown>) {
  const calls: Array<{ method: string; args: Record<string, unknown> }> = []
  const posts: Array<{ channel: string; threadTs?: string; text: string }> = []
  const noted = new Set<string>()
  const deps: CodeChannelDeps = {
    async slack(method, args) {
      calls.push({ method, args })
      const answer = answers[method]
      if (!answer) throw new Error(`slack ${method}: unknown_method`)
      const out = answer(args)
      if (typeof out === 'string') throw new Error(`slack ${method}: ${out}`)
      return { ok: true, ...(out as object) }
    },
    async postInThread(channel, threadTs, text) {
      posts.push({ channel, threadTs, text })
    },
    async postInChannel(channel, text) {
      posts.push({ channel, text })
    },
    async noteOnce(key) {
      if (noted.has(key)) return false
      noted.add(key)
      return true
    },
  }
  return { deps, calls, posts }
}

const caller = { channel: 'C0PLAIN', threadTs: '1700000000.000100', author: 'U0ASKER' }

/** C0CODE as Slack reports it when `caller`'s thread opened it. */
const MINE_INFO = {
  id: 'C0CODE',
  properties: {
    record_channel: { record_type: 'agent_channel', record_id: `AC:T1:${caller.channel}-${caller.threadTs}` },
    agent_session: { origin_link: { channel_id: caller.channel, ts: caller.threadTs } },
  },
}

// ---------------------------------------------------------------------------------------------
// The action set (rule 1).

test('only the six actions exist: delete, kick and the rest are refused by name', () => {
  assert.deepEqual([...ACTIONS], ['create', 'post', 'view', 'status', 'archive', 'summary'])
  for (const action of ['delete', 'kick', 'rename', 'remove-view', 'invite', undefined]) {
    const r = checkCodeChannelAction({ action, channel: 'C0CODE' })
    assert.equal(r.ok, false, String(action))
    if (!r.ok) assert.match(r.error, /unknown code-channel action/)
  }
})

test('each action reads only its own fields; a thread or origin in the body is ignored', () => {
  assert.deepEqual(checkCodeChannelAction({ action: 'create', name: ' fix-login ', channel: 'C0OTHER', threadTs: '1.2', origin_channel_id: 'C0X' }), {
    ok: true,
    value: { action: 'create', name: 'fix-login' },
  })
  assert.deepEqual(checkCodeChannelAction({ action: 'summary', text: 'done', channel: 'C0OTHER' }), { ok: true, value: { action: 'summary', text: 'done' } })
  assert.deepEqual(checkCodeChannelAction({ action: 'archive', channel: 'C0CODE', summary_ts: '1.2' }), { ok: true, value: { action: 'archive', channel: 'C0CODE' } })
  assert.equal(checkCodeChannelAction({ action: 'create', name: '  ' }).ok, false)
  assert.equal(checkCodeChannelAction({ action: 'create', name: 'x'.repeat(81) }).ok, false)
  assert.equal(checkCodeChannelAction({ action: 'post', channel: 'D0DM', text: 'hi' }).ok, false, 'a DM is not a code channel')
  assert.equal(checkCodeChannelAction({ action: 'post', channel: 'C0CODE', text: 'x'.repeat(MAX_TEXT_CHARS + 1) }).ok, false)
  assert.equal(checkCodeChannelAction({ action: 'status', channel: 'C0CODE', status: 'closed' }).ok, false, 'closed comes only with archive')
  assert.equal(checkCodeChannelAction({ action: 'status', channel: 'C0CODE', status: 'active' }).ok, true)
})

test('a tab keeps only the fields Slack documents, and is capped', () => {
  const html = checkCodeChannelAction({ action: 'view', channel: 'C0CODE', view: { type: 'html', content: '<p>hi</p>', name: 'Plan', view_key: 'plan', csp: 'x', evil: 1 } })
  assert.deepEqual(html, { ok: true, value: { action: 'view', channel: 'C0CODE', view: { type: 'html', name: 'Plan', view_key: 'plan', content: '<p>hi</p>' } } })
  const diff = checkCodeChannelAction({ action: 'view', channel: 'C0CODE', view: { type: 'diff', content: 'diff --git', base_branch: 'main', head_branch: 'fix/x' } })
  assert.ok(diff.ok && diff.value.action === 'view' && diff.value.view.head_branch === 'fix/x')
  assert.equal(checkCodeChannelAction({ action: 'view', channel: 'C0CODE', view: { type: 'canvas', canvas_id: 'F1' } }).ok, false)
  assert.equal(checkCodeChannelAction({ action: 'view', channel: 'C0CODE', view: { type: 'html', content: 'x'.repeat(MAX_VIEW_BYTES + 1) } }).ok, false)
  assert.equal(checkCodeChannelAction({ action: 'view', channel: 'C0CODE', view: { type: 'block_kit', blocks: [] } }).ok, false)
  assert.equal(checkCodeChannelAction({ action: 'view', channel: 'C0CODE', view: { type: 'html', content: 'x', view_key: 'a b' } }).ok, false)
  assert.equal(checkCodeChannelAction({ action: 'view', channel: 'C0CODE', view: { type: 'diff', content: 'x', base_branch: 'a;rm' } }).ok, false)
})

// ---------------------------------------------------------------------------------------------
// What Slack says.

test('a code channel and its origin come from Slack’s record; the Context root is recognised by its blocks', () => {
  assert.deepEqual(codeChannelOrigin(CODE_INFO), { channel: 'C0ORIGIN', threadTs: '1792066248.979529' })
  const noLink = { properties: { record_channel: CODE_INFO.properties.record_channel } }
  assert.deepEqual(codeChannelOrigin(noLink), { channel: 'C0ORIGIN', threadTs: '1792066248.979529' }, 'falls back to the record id')
  assert.equal(codeChannelOrigin(PLAIN_INFO), null)

  assert.equal(isContextRoot({ blocks: [{ type: 'section', block_id: 'agent_channel_origin_context' }] }), true)
  assert.equal(isContextRoot({ blocks: [{ type: 'context', block_id: 'agent_channel_origin_status_C0ORIGIN' }] }), true)
  assert.equal(isContextRoot({ blocks: [{ type: 'rich_text', block_id: 'abc' }] }), false)
  assert.equal(isContextRoot({}), false)
})

test('Slack’s error code is read out of the thrown message; feature-off codes are known', () => {
  assert.equal(slackErrorCode('slack agents.conversations.create: feature_disabled'), 'feature_disabled')
  assert.equal(slackErrorCode('network down'), 'network down')
  assert.equal(isFeatureOff('feature_disabled'), true)
  assert.equal(isFeatureOff('unknown_method'), true)
  assert.equal(isFeatureOff('missing_scope'), true)
  assert.equal(isFeatureOff('not_agent_channel'), false)
  assert.equal(isFeatureOff('channel_not_found'), false)
})

test('form fields carry tabs and blocks as JSON', () => {
  assert.equal(formValue([{ type: 'divider' }]), '[{"type":"divider"}]')
  assert.equal(formValue('C1'), 'C1')
  assert.equal(formValue(3), '3')
})

// ---------------------------------------------------------------------------------------------
// The door.

test('create links the token’s thread, invites the asker, and points the thread at the channel', async () => {
  const { deps, calls, posts } = fakeDeps({
    'conversations.info': () => ({ channel: PLAIN_INFO }),
    'agents.conversations.create': () => ({ channel_id: 'C0NEW' }),
    'conversations.invite': () => ({}),
  })
  const out = await codeChannelAction(deps, caller, { action: 'create', name: 'fix-login' })
  assert.equal(out.status, 200)
  assert.deepEqual(out.body, { ok: true, channel: 'C0NEW', originLinked: true, invited: true })
  const made = calls.find((c) => c.method === 'agents.conversations.create')!
  assert.deepEqual(made.args, { name: 'fix-login', session_id: 'C0PLAIN-1700000000.000100', origin_channel_id: 'C0PLAIN', origin_message_ts: '1700000000.000100' })
  assert.deepEqual(calls.find((c) => c.method === 'conversations.invite')!.args, { channel: 'C0NEW', users: 'U0ASKER' })
  assert.deepEqual(posts, [{ channel: 'C0PLAIN', threadTs: '1700000000.000100', text: ':thread: Opened code channel <#C0NEW> for this thread.' }])
})

test('create retries once without the origin when Slack refuses the link, and an already-member is fine', async () => {
  let n = 0
  const { deps, calls } = fakeDeps({
    'conversations.info': () => ({ channel: PLAIN_INFO }),
    'agents.conversations.create': () => (n++ === 0 ? 'origin_channel_externally_shared' : { channel_id: 'C0NEW' }),
    'conversations.invite': () => 'already_in_channel',
  })
  const out = await codeChannelAction(deps, caller, { action: 'create', name: 'x' })
  assert.deepEqual(out.body, { ok: true, channel: 'C0NEW', originLinked: false, originError: 'origin_channel_externally_shared', invited: true })
  const creates = calls.filter((c) => c.method === 'agents.conversations.create')
  assert.equal(creates.length, 2)
  assert.equal('origin_channel_id' in creates[1].args, false)
})

test('no code channel from inside a code channel, and an unreadable channel refuses (fails closed)', async () => {
  const inside = fakeDeps({ 'conversations.info': () => ({ channel: CODE_INFO }), 'agents.conversations.create': () => ({ channel_id: 'C0NEW' }) })
  const nested = await codeChannelAction(inside.deps, { ...caller, channel: 'C0CODE' }, { action: 'create', name: 'again' })
  assert.equal(nested.status, 403)
  assert.equal(nested.body.error, 'code_channel_nested')
  assert.equal(inside.calls.some((c) => c.method === 'agents.conversations.create'), false)

  const blind = fakeDeps({ 'conversations.info': () => 'ratelimited', 'agents.conversations.create': () => ({ channel_id: 'C0NEW' }) })
  const refused = await codeChannelAction(blind.deps, caller, { action: 'create', name: 'x' })
  assert.equal(refused.status, 503)
  assert.equal(refused.body.error, 'code_channel_lookup_failed')
  assert.equal(blind.calls.some((c) => c.method === 'agents.conversations.create'), false)

  // A DM is never a code channel, so it is not asked about.
  const dm = fakeDeps({ 'agents.conversations.create': () => ({ channel_id: 'C0NEW' }), 'conversations.invite': () => ({}) })
  const fromDm = await codeChannelAction(dm.deps, { ...caller, channel: 'D0DM' }, { action: 'create', name: 'x' })
  assert.equal(fromDm.status, 200)
  assert.equal(dm.calls.some((c) => c.method === 'conversations.info'), false)
})

test('feature off: ONE note in the thread however often it is tried, and Claude is told to carry on', async () => {
  const { deps, posts } = fakeDeps({
    'conversations.info': (args) => ({ channel: args.channel === 'C0CODE' ? MINE_INFO : PLAIN_INFO }),
    'agents.conversations.create': () => 'feature_disabled',
    'agents.conversations.listViews': () => 'feature_disabled',
  })
  const first = await codeChannelAction(deps, caller, { action: 'create', name: 'x' })
  const second = await codeChannelAction(deps, caller, { action: 'create', name: 'y' })
  const third = await codeChannelAction(deps, caller, { action: 'post', channel: 'C0CODE', text: 'hi' })
  for (const out of [first, second, third]) {
    assert.equal(out.status, 409)
    assert.equal(out.body.fallback, true)
    assert.equal(out.body.error, 'feature_disabled')
    assert.match(String(out.body.hint), /keep working in this thread/)
  }
  assert.equal(posts.length, 1)
  assert.equal(posts[0].channel, 'C0PLAIN')
  assert.equal(posts[0].threadTs, '1700000000.000100')
  assert.match(posts[0].text, /code channels are not turned on.*keep working here in the thread/)
})

test('another Slack error is handed back as Slack’s code, with no note', async () => {
  const { deps, posts } = fakeDeps({ 'conversations.info': () => ({ channel: MINE_INFO }), 'agents.sessions.setStatus': () => 'not_agent_channel' })
  const out = await codeChannelAction(deps, caller, { action: 'status', channel: 'C0CODE', status: 'active' })
  assert.deepEqual(out, { status: 502, body: { ok: false, error: 'not_agent_channel' } })
  assert.equal(posts.length, 0)
})

test('post writes only where listViews answers: our own code channel', async () => {
  const mine = fakeDeps({ 'conversations.info': () => ({ channel: MINE_INFO }), 'agents.conversations.listViews': () => ({ views: [] }) })
  const ok = await codeChannelAction(mine.deps, caller, { action: 'post', channel: 'C0CODE', text: 'build is green' })
  assert.equal(ok.status, 200)
  assert.deepEqual(mine.posts, [{ channel: 'C0CODE', text: 'build is green' }])

  const theirs = fakeDeps({ 'agents.conversations.listViews': () => 'not_agent_channel' })
  const refused = await codeChannelAction(theirs.deps, { ...caller, channel: 'C0GENERAL' }, { action: 'post', channel: 'C0GENERAL', text: 'hi' })
  assert.equal(refused.status, 403)
  assert.equal(refused.body.error, 'not_your_code_channel')
  assert.equal(theirs.posts.length, 0)
})

test('view sends the checked tab; status sets the session', async () => {
  const { deps, calls } = fakeDeps({
    'conversations.info': () => ({ channel: MINE_INFO }),
    'agents.conversations.setView': () => ({ view_id: 'V1' }),
    'agents.sessions.setStatus': () => ({}),
  })
  const view = await codeChannelAction(deps, caller, { action: 'view', channel: 'C0CODE', view: { type: 'html', content: '<p/>', view_key: 'plan' } })
  assert.deepEqual(view.body, { ok: true, channel: 'C0CODE', view_id: 'V1', view_key: 'plan' })
  const slackCalls = () => calls.filter((c) => c.method !== 'conversations.info')
  assert.deepEqual(slackCalls()[0].args, { channel_id: 'C0CODE', type: 'html', content: '<p/>', view_key: 'plan' })
  // A turn inside the code channel needs no lookup.
  await codeChannelAction(deps, { channel: 'C0CODE', threadTs: '1.1' }, { action: 'status', channel: 'C0CODE', status: 'suspended' })
  assert.deepEqual(slackCalls()[1], { method: 'agents.sessions.setStatus', args: { channel_id: 'C0CODE', status: 'suspended' } })
})

test('archive closes the session first from the opening thread, and is refused from inside the channel itself', async () => {
  const { deps, calls } = fakeDeps({ 'conversations.info': () => ({ channel: MINE_INFO }), 'agents.sessions.setStatus': () => ({}), 'agents.conversations.archive': () => ({}) })
  const out = await codeChannelAction(deps, caller, { action: 'archive', channel: 'C0CODE' })
  assert.equal(out.status, 200)
  assert.deepEqual(calls.map((c) => c.method), ['conversations.info', 'agents.sessions.setStatus', 'agents.conversations.archive'])
  assert.equal(calls[1].args.status, 'closed')

  const inside = await codeChannelAction(deps, { ...caller, channel: 'C0CODE' }, { action: 'archive', channel: 'C0CODE' })
  assert.equal(inside.status, 403)
  assert.equal(inside.body.error, 'archive_from_inside')
  assert.equal(calls.length, 3, 'nothing reached Slack')
})

test('a thread that did not open a code channel cannot archive, post into, tab or set the status of it (rule 8)', async () => {
  // C0CODE was opened from C0ORIGIN/1792066248.979529, maybe a private channel; the caller is elsewhere.
  const stranger = { channel: 'C0GENERAL', threadTs: '1700000000.000200' }
  const sameChannelOtherThread = { channel: 'C0ORIGIN', threadTs: '1700000000.000300' }
  for (const who of [stranger, sameChannelOtherThread]) {
    const { deps, calls, posts } = fakeDeps({
      'conversations.info': () => ({ channel: CODE_INFO }),
      'agents.conversations.listViews': () => ({}),
      'agents.conversations.setView': () => ({ view_id: 'V1' }),
      'agents.sessions.setStatus': () => ({}),
      'agents.conversations.archive': () => ({}),
    })
    for (const action of [
      { action: 'archive', channel: 'C0CODE' },
      { action: 'post', channel: 'C0CODE', text: 'hi' },
      { action: 'view', channel: 'C0CODE', view: { type: 'html', content: '<p/>' } },
      { action: 'status', channel: 'C0CODE', status: 'active' },
    ] as const) {
      const out = await codeChannelAction(deps, who, action as any)
      assert.equal(out.status, 403, action.action)
      assert.equal(out.body.error, 'not_your_code_channel', action.action)
    }
    assert.deepEqual(calls.map((c) => c.method).filter((m) => m !== 'conversations.info'), [], 'nothing but the lookup reached Slack')
    assert.equal(posts.length, 0)
  }

  // The opening thread may.
  const opener = fakeDeps({ 'conversations.info': () => ({ channel: CODE_INFO }), 'agents.sessions.setStatus': () => ({}), 'agents.conversations.archive': () => ({}) })
  const done = await codeChannelAction(opener.deps, { channel: 'C0ORIGIN', threadTs: '1792066248.979529' }, { action: 'archive', channel: 'C0CODE' })
  assert.equal(done.status, 200)

  // A plain channel is not a code channel, and a channel Slack cannot describe refuses (fails closed).
  const plain = fakeDeps({ 'conversations.info': () => ({ channel: PLAIN_INFO }), 'agents.conversations.archive': () => ({}) })
  const notCode = await codeChannelAction(plain.deps, caller, { action: 'archive', channel: 'C0OTHER' })
  assert.equal(notCode.body.error, 'not_a_code_channel')
  const blind = fakeDeps({ 'conversations.info': () => 'ratelimited', 'agents.conversations.archive': () => ({}) })
  const unread = await codeChannelAction(blind.deps, caller, { action: 'archive', channel: 'C0CODE' })
  assert.equal(unread.status, 503)
  assert.equal(unread.body.error, 'code_channel_lookup_failed')
  assert.equal(blind.calls.some((c) => c.method === 'agents.conversations.archive'), false)
})

test('summary goes to the thread Slack says opened the channel, only from inside one', async () => {
  const inside = fakeDeps({ 'conversations.info': () => ({ channel: CODE_INFO }), 'agents.conversations.listViews': () => ({}) })
  const out = await codeChannelAction(inside.deps, { channel: 'C0CODE', threadTs: '1.1' }, { action: 'summary', text: 'Shipped PR 12.' })
  assert.equal(out.status, 200)
  assert.deepEqual(inside.posts, [{ channel: 'C0ORIGIN', threadTs: '1792066248.979529', text: ':checkered_flag: *Summary from <#C0CODE>*\nShipped PR 12.' }])

  const plain = fakeDeps({ 'conversations.info': () => ({ channel: PLAIN_INFO }) })
  const refused = await codeChannelAction(plain.deps, caller, { action: 'summary', text: 'x' })
  assert.equal(refused.status, 403)
  assert.equal(refused.body.error, 'not_in_a_code_channel')
  assert.equal(plain.posts.length, 0)
})

// ---------------------------------------------------------------------------------------------
// The thread's once-only note (src/thread.ts rule 10).

test('a thread is told a note once, and only a running turn can ask', () => {
  const data = emptyThread('C1', '1.1', 'https://w')
  const r = accept(data, { ts: '1.1', user: 'U1', text: 'hi' }, { mention: true, now: 1, newTurnId: () => 't1' })
  assert.equal(r.action, 'start')
  assert.equal(noteOnce(data, 'other-turn', 'k'), false)
  assert.equal(noteOnce(data, 't1', 'k'), true)
  assert.equal(noteOnce(data, 't1', 'k'), false)
  assert.equal(noteOnce(data, 't1', 'other'), true)
  assert.equal(noteOnce(undefined, 't1', 'k'), false)
})

// ---------------------------------------------------------------------------------------------
// Claude's command.

test('code-channel parses the six actions and refuses the rest', () => {
  assert.deepEqual(parseArgs(['code-channel', 'create', 'fix login']), { command: 'code-channel', action: 'create', name: 'fix login' })
  assert.deepEqual(parseArgs(['code-channel', 'post', 'C0CODE', 'hi there']), { command: 'code-channel', action: 'post', channel: 'C0CODE', text: 'hi there' })
  assert.deepEqual(parseArgs(['code-channel', 'view', 'C0CODE', 'd.diff', '--type', 'diff', '--name', 'Diff', '--key', 'diff', '--base', 'main']), {
    command: 'code-channel',
    action: 'view',
    channel: 'C0CODE',
    path: 'd.diff',
    type: 'diff',
    tab: 'Diff',
    key: 'diff',
    base: 'main',
  })
  assert.deepEqual(parseArgs(['code-channel', 'summary', 'done']), { command: 'code-channel', action: 'summary', text: 'done' })
  assert.match(parseArgs(['code-channel', 'delete', 'C0CODE']).error, /unknown code-channel action delete/)
  assert.match(parseArgs(['code-channel']).error, /needs an action/)
  assert.match(parseArgs(['code-channel', 'post', 'C0CODE']).error, /takes channel and text/)
  assert.match(parseArgs(['code-channel', 'post', 'C0CODE', 'x', '--type', 'html']).error, /unknown option/)
  assert.match(parseArgs(['code-channel', 'view', 'C0CODE', 'f', '--type', 'canvas']).error, /html, diff or block_kit/)
})

test('a block_kit file is a JSON array of blocks', () => {
  assert.deepEqual(viewFrom({ type: 'block_kit', path: 'b.json' }, '[{"type":"divider"}]'), { type: 'block_kit', blocks: [{ type: 'divider' }] })
  assert.deepEqual(viewFrom({ type: 'block_kit', path: 'b.json' }, '{"blocks":[{"type":"divider"}]}'), { type: 'block_kit', blocks: [{ type: 'divider' }] })
  assert.throws(() => viewFrom({ type: 'block_kit', path: 'b.json' }, 'nope'), /not JSON/)
  assert.deepEqual(viewFrom({ path: 'p.html', tab: 'Plan' }, '<p/>'), { type: 'html', name: 'Plan', content: '<p/>' })
})

test('the command sends only the action’s fields with the tools token, and prints the fallback as a plain line', async () => {
  const env = { AGENT_API_URL: 'https://w.example', AGENT_TOOLS_TOKEN: 'tok', TURN_ID: 't1' }
  const calls: Array<{ url: string; init: RequestInit }> = []
  const made = await run(parseArgs(['code-channel', 'create', 'fix login']), {
    env,
    fetchImpl: async (url: URL, init: RequestInit) => {
      calls.push({ url: String(url), init })
      return Response.json({ ok: true, channel: 'C0NEW', originLinked: true, invited: true })
    },
  })
  assert.equal(calls[0].url, 'https://w.example/sandbox/code-channel')
  assert.equal((calls[0].init.headers as Record<string, string>).authorization, 'Bearer tok')
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { turnId: 't1', action: 'create', name: 'fix login' })
  assert.match(made, /Opened code channel C0NEW/)

  const off = await run(parseArgs(['code-channel', 'create', 'x']), {
    env,
    fetchImpl: async () => Response.json({ ok: false, fallback: true, error: 'feature_disabled', hint: 'keep working in this thread' }, { status: 409 }),
  })
  assert.match(off, /^NOT AVAILABLE: keep working in this thread/)

  await assert.rejects(
    run(parseArgs(['code-channel', 'create', 'x']), {
      env,
      fetchImpl: async () => Response.json({ ok: false, error: 'code_channel_nested', hint: 'work here instead' }, { status: 403 }),
    }),
    /refused: code_channel_nested\. work here instead/,
  )
})

// The web UI's rules (src/ui.ts) and its App Home tab (src/home.ts), and how the transcript page
// reads a backup (ui/transcript.js).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { homeView, visibleChannels, HOME_THREADS } from '../src/home.ts'
import { followUrl } from '../src/status.ts'
import { transcriptKey } from '../src/transcripts.ts'
import { checkUiChannel, checkUiRoutine, checkWrite, isThreadTs, isTranscriptKeyFor, pageFor, renderPage, uiHeaders, normaliseUiHost, uiOrigin, workerOrigin } from '../src/ui.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const { transcriptEntries } = await import(pathToFileURL(join(root, 'ui', 'transcript.js')).href)
const TS = '1761800000.123456'

test('rule 2: a change is a same-origin JSON POST, nothing else', () => {
  const ok = { method: 'POST', contentType: 'application/json', origin: 'https://w.example', selfOrigin: 'https://w.example' }
  assert.equal(checkWrite(ok), null)
  assert.match(checkWrite({ ...ok, method: 'GET' }) ?? '', /POST/)
  assert.match(checkWrite({ ...ok, contentType: 'application/x-www-form-urlencoded' }) ?? '', /JSON/)
  assert.match(checkWrite({ ...ok, contentType: 'text/plain' }) ?? '', /JSON/)
  assert.match(checkWrite({ ...ok, origin: 'https://evil.example' }) ?? '', /this site/)
  assert.match(checkWrite({ ...ok, origin: null }) ?? '', /this site/)
})

test('the transcript door serves only a backup of the thread it was asked about', () => {
  const key = transcriptKey({ channel: 'CHANNELA', threadTs: TS, lastTs: '1761800100.000200', turnId: crypto.randomUUID() })
  assert.equal(isTranscriptKeyFor(key, 'CHANNELA', TS), true)
  assert.equal(isTranscriptKeyFor(key, 'CHANNELB', TS), false)
  assert.equal(isTranscriptKeyFor(key, 'CHANNELA', '1761800000.999999'), false)
  assert.equal(isTranscriptKeyFor(`transcripts/CHANNELA/${TS}/../../other.jsonl.gz`, 'CHANNELA', TS), false)
  assert.equal(isTranscriptKeyFor(`${key}x`, 'CHANNELA', TS), false)
  assert.equal(isTranscriptKeyFor(null, 'CHANNELA', TS), false)
  assert.equal(isThreadTs(TS), true)
  assert.equal(isThreadTs('../x'), false)
})

test('the Routines page: create needs a channel, update an id, and both follow the routine rules', () => {
  const now = Date.UTC(2026, 9, 30)
  assert.deepEqual(checkUiRoutine({ action: 'create', channel: 'CHANNELA', prompt: ' check CI ', cron: '0 9 * * 1' }, now), {
    ok: true,
    value: { action: 'create', channel: 'CHANNELA', prompt: 'check CI', cron: '0 9 * * 1', timezone: 'UTC', model: null },
  })
  assert.deepEqual(checkUiRoutine({ action: 'update', id: 'abcdefghij', prompt: 'x', cron: '*/5 * * * *', timezone: 'Europe/London', model: 'haiku' }, now), {
    ok: true,
    value: { action: 'update', id: 'abcdefghij', prompt: 'x', cron: '*/5 * * * *', timezone: 'Europe/London', model: 'haiku' },
  })
  assert.equal(checkUiRoutine({ action: 'create', prompt: 'x', cron: '0 9 * * 1' }, now).ok, false)
  assert.equal(checkUiRoutine({ action: 'create', channel: 'DCHANNEL1', prompt: 'x', cron: '0 9 * * 1' }, now).ok, false)
  assert.equal(checkUiRoutine({ action: 'update', id: 'nope', prompt: 'x', cron: '0 9 * * 1' }, now).ok, false)
  assert.equal(checkUiRoutine({ action: 'create', channel: 'CHANNELA', prompt: 'x', cron: 'every day' }, now).ok, false)
  assert.equal(checkUiRoutine({ action: 'create', channel: 'CHANNELA', prompt: 'x', cron: '0 9 * * 1', model: 'gpt' }, now).ok, false)
  assert.deepEqual(checkUiRoutine({ action: 'pause', id: 'abcdefghij' }), { ok: true, value: { action: 'pause', id: 'abcdefghij' } })
  assert.equal(checkUiRoutine({ action: 'list' }).ok, false)
})

test('the Channels page: watch, model and secrets, each checked', () => {
  assert.deepEqual(checkUiChannel({ action: 'watch', channel: 'CHANNELA', watched: true }), { ok: true, value: { action: 'watch', channel: 'CHANNELA', watched: true } })
  assert.equal(checkUiChannel({ action: 'watch', channel: 'CHANNELA', watched: 'yes' }).ok, false)
  assert.equal(checkUiChannel({ action: 'watch', channel: 'DCHANNEL1', watched: true }).ok, false)
  assert.deepEqual(checkUiChannel({ action: 'model', channel: 'CHANNELA', model: '' }), { ok: true, value: { action: 'model', channel: 'CHANNELA', model: null } })
  assert.equal(checkUiChannel({ action: 'model', channel: 'CHANNELA', model: 'gpt' }).ok, false)
  assert.equal(checkUiChannel({ action: 'set-secret', channel: 'not a channel', name: 'A', value: 'b' }).ok, false)
  assert.equal(checkUiChannel({ action: 'delete-secret', channel: 'CHANNELA' }).ok, false)
  assert.equal(checkUiChannel({ action: 'read-secret', channel: 'CHANNELA', name: 'A' }).ok, false)
})

test('pages: the Follow along link opens the follow page, and the page name never comes from the request', () => {
  assert.equal(pageFor(new URL(followUrl('https://w.example', 'CHANNELA', TS)).pathname), 'follow')
  assert.equal(pageFor('/ui/'), 'threads')
  assert.equal(pageFor('/ui'), 'threads')
  assert.equal(pageFor('/ui/routines'), 'routines')
  assert.equal(pageFor('/ui/channels/'), 'channels')
  assert.equal(pageFor('/ui/threads'), null)
  assert.equal(pageFor('/ui/<script>'), null)
  assert.equal(renderPage('<body data-page="{{PAGE}}">', 'routines'), '<body data-page="routines">')
  const shell = readFileSync(join(root, 'ui', 'page.html'), 'utf8')
  assert.match(shell, /data-page="\{\{PAGE\}\}"/)
  assert.match(uiHeaders('text/html')['content-security-policy'], /script-src 'self'/)
  assert.match(uiHeaders('text/html')['content-security-policy'], /frame-ancestors 'none'/)
})

test('the page script never writes HTML from data', () => {
  const app = readFileSync(join(root, 'ui', 'app.js'), 'utf8')
  assert.doesNotMatch(app, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/)
})

test('every /ui path goes through the Access check before anything else', () => {
  const routes = readFileSync(join(root, 'src', 'ui-routes.ts'), 'utf8')
  const body = routes.slice(routes.indexOf('export async function uiRoute'))
  assert.ok(body.indexOf('accessIdentity(') < body.indexOf('api(request'))
  assert.ok(body.indexOf('accessIdentity(') < body.indexOf('APP_JS'))
  const index = readFileSync(join(root, 'src', 'index.ts'), 'utf8')
  assert.match(index, /url\.pathname === '\/ui' \|\| url\.pathname\.startsWith\('\/ui\/'\)\) return uiRoute/)
})

test('a backup reads into prompts, text, thinking, tool calls and results; the rest is skipped', () => {
  const lines = [
    { type: 'user', message: { content: 'fix the build' }, timestamp: 't1' },
    { type: 'user', isMeta: true, message: { content: 'caveat' } },
    { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'On it.' }, { type: 'tool_use', name: 'Bash', input: { command: 'make' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', content: [{ type: 'text', text: 'ok' }] }, { type: 'tool_result', content: 'bad', is_error: true }] } },
    { type: 'summary', summary: 'x' },
  ]
  const text = `${lines.map((l) => JSON.stringify(l)).join('\n')}\nnot json\n`
  assert.deepEqual(transcriptEntries(text), [
    { kind: 'prompt', text: 'fix the build', at: 't1' },
    { kind: 'thinking', text: 'hmm' },
    { kind: 'text', text: 'On it.' },
    { kind: 'tool', name: 'Bash', text: '{\n  "command": "make"\n}' },
    { kind: 'result', text: 'ok' },
    { kind: 'error', text: 'bad' },
  ])
})

test('App Home rule 1: only public channels and the viewer\'s own DM are listed', async () => {
  const lookups: string[] = []
  const visible = await visibleChannels(['CPUBLIC1', 'GPRIVATE1', 'DMINE0001', 'DOTHER001', 'CPUBLIC1', 'CBROKEN1'], 'DMINE0001', async (id) => {
    lookups.push(id)
    if (id === 'CBROKEN1') throw new Error('slack down')
    return id === 'CPUBLIC1'
  })
  assert.deepEqual([...visible].sort(), ['CPUBLIC1', 'DMINE0001'])
  assert.deepEqual(lookups.sort(), ['CBROKEN1', 'CPUBLIC1', 'DOTHER001', 'GPRIVATE1'], 'each channel looked up once, the own DM never')
})

test('App Home: recent threads, routines with escaped prompts, and the UI link only when it is set up', () => {
  const threads = Array.from({ length: 20 }, (_, i) => ({ channel: 'CPUBLIC1', thread_ts: TS, last_at: 1761800000000 + i, turns: i + 1 }))
  const routine = { id: 'abcdefghij', channel: 'CPUBLIC1', prompt: 'ping <!channel> & <@UXXXXXXXX>', cron: '0 9 * * 1', timezone: 'UTC', status: 'active', nextRun: 'Mon 3 Nov, 09:00 (UTC)' }
  const view = homeView({ uiOrigin: 'https://w.example', threads, routines: [routine] })
  assert.equal(view.type, 'home')
  const text = JSON.stringify(view.blocks)
  assert.ok(text.includes('https://w.example/ui/'))
  assert.ok(text.includes('/ui/follow?channel=CPUBLIC1'))
  assert.ok(text.includes('&lt;!channel&gt; &amp; &lt;@UXXXXXXXX&gt;'))
  assert.ok(!text.includes('<!channel>'))
  assert.equal(view.blocks.filter((b) => (b as { text?: { text?: string } }).text?.text?.includes('turn')).length, HOME_THREADS)
  assert.ok(view.blocks.length <= 100)
  const closed = JSON.stringify(homeView({ uiOrigin: null, threads, routines: [] }).blocks)
  assert.ok(!closed.includes('/ui/'))
  assert.ok(closed.includes('not set up'))
})

test('the manifest turns on the Home tab and subscribes to app_home_opened', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'slack-manifest.json'), 'utf8'))
  assert.equal(manifest.features.app_home.home_tab_enabled, true)
  assert.ok(manifest.settings.event_subscriptions.bot_events.includes('app_home_opened'))
})

test('rule 5: the UI lives on its own custom host, never workers.dev, and needs Access too', () => {
  assert.equal(normaliseUiHost('agent.example.com'), 'agent.example.com')
  assert.equal(normaliseUiHost(' https://Agent.Example.com/ '), 'agent.example.com')
  assert.equal(normaliseUiHost('slack-agent.me.workers.dev'), null, 'Access cannot cover only /ui on workers.dev')
  assert.equal(normaliseUiHost('workers.dev'), null)
  assert.equal(normaliseUiHost('agent.example.com/ui'), null)
  assert.equal(normaliseUiHost('agent.example.com:8443'), null)
  assert.equal(normaliseUiHost('localhost'), null)
  assert.equal(normaliseUiHost(''), null)
  assert.equal(normaliseUiHost(undefined), null)

  const access = { ACCESS_TEAM_DOMAIN: 'myteam', ACCESS_AUD: 'a'.repeat(64) }
  assert.equal(uiOrigin({ ...access, UI_HOST: 'agent.example.com' }), 'https://agent.example.com')
  assert.equal(uiOrigin({ ...access, UI_HOST: '' }), null, 'Access alone is not enough: there is no host to put it on')
  assert.equal(uiOrigin({ UI_HOST: 'agent.example.com' }), null, 'a host without Access is not set up')
  assert.equal(uiOrigin({ ...access, UI_HOST: 'slack-agent.me.workers.dev' }), null)
})

test('rule 5: wrangler.jsonc keeps workers.dev for Slack and has the slots setup fills for the UI host', () => {
  const text = readFileSync(join(root, 'wrangler.jsonc'), 'utf8')
  assert.match(text, /"workers_dev":\s*true/)
  assert.match(text, /"routes":\s*\[\]/, 'setup replaces this with the UI_HOST custom domain')
  assert.match(text, /"UI_HOST":\s*""/)
})

test('rule 6: a routine made on the UI reports to WORKER_URL, never to the Access-guarded UI host', () => {
  const ui = { UI_HOST: 'agent.example.com', ACCESS_TEAM_DOMAIN: 'myteam', ACCESS_AUD: 'a'.repeat(64) }
  const worker = 'https://slack-agent.me.workers.dev'
  assert.equal(workerOrigin({ ...ui, WORKER_URL: worker }), worker)
  assert.notEqual(workerOrigin({ ...ui, WORKER_URL: worker }), uiOrigin(ui))
  assert.equal(workerOrigin({ ...ui, WORKER_URL: `${worker}/` }), worker, 'trimmed to the origin')
  assert.equal(workerOrigin({ ...ui, WORKER_URL: 'https://agent.example.com' }), null, 'the UI host is never a job origin')
  assert.equal(workerOrigin({ ...ui, WORKER_URL: 'http://slack-agent.me.workers.dev' }), null)
  assert.equal(workerOrigin({ ...ui, WORKER_URL: '' }), null)
  assert.equal(workerOrigin(ui), null)

  // The create route takes its origin from workerOrigin, not from the request it was sent on.
  const routes = readFileSync(join(root, 'src', 'ui-routes.ts'), 'utf8')
  const create = routes.slice(routes.indexOf("a.action === 'create'"), routes.indexOf("a.action === 'update'"))
  assert.match(create, /workerOrigin\(env\)/)
  assert.doesNotMatch(create, /url\.origin/)
  assert.match(readFileSync(join(root, 'wrangler.jsonc'), 'utf8'), /"WORKER_URL":\s*""/)
})

test('rule 5: a HEAD on workers.dev /ui is redirected like a GET (SETUP step 7 checks it with curl -I)', () => {
  const routes = readFileSync(join(root, 'src', 'ui-routes.ts'), 'utf8')
  assert.match(routes, /request\.method === 'GET' \|\| request\.method === 'HEAD'\) && !isApi\) return Response\.redirect/)
})

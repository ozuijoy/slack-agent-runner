import APP_JS from '../ui/app.js'
import SHELL from '../ui/page.html'
import STYLE from '../ui/style.css'
import TRANSCRIPT_JS from '../ui/transcript.js'
import { accessIdentity } from './access.ts'
import { deleteChannelSecret, listChannels, putChannelSecret, setChannelModel, setWatched } from './channel-store.ts'
import { isChannelId } from './channels.ts'
import { recentThreads, threadTranscripts } from './db.ts'
import type { Env } from './env.ts'
import { homeView, visibleChannels } from './home.ts'
import { DEFAULT_MODEL, MODELS } from './models.ts'
import { createRoutine, deleteRoutine, listRoutines, listRuns, setRoutineStatus, updateRoutine } from './routine-store.ts'
import { isRoutineId } from './routines.ts'
import { isPublicChannel } from './search.ts'
import { channelInfo, slackApi } from './slack.ts'
import { threadStub } from './thread-stub.ts'
import { checkUiChannel, checkUiRoutine, checkWrite, isThreadTs, isTranscriptKeyFor, pageFor, renderPage, uiHeaders, uiOrigin, workerOrigin } from './ui.ts'

/**
 * The web UI: GET pages and their API under /ui, all behind Cloudflare Access (src/access.ts). The
 * rules are in src/ui.ts. The pages are plain HTML and JS in ui/, imported as text.
 *
 *   /ui/                 recent threads           GET  /ui/api/threads
 *   /ui/follow?channel=&thread=   a thread's transcript: its R2 backups and the live turn
 *                                                 GET  /ui/api/follow, /ui/api/transcript
 *   /ui/routines         every routine            GET/POST /ui/api/routines, GET /ui/api/routines/runs
 *   /ui/channels         watched, default model, secrets (write-only)
 *                                                 GET/POST /ui/api/channels
 */
export async function uiRoute(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  const isApi = url.pathname.startsWith('/ui/api/')
  // Rule 5 in src/ui.ts: the UI answers only on its own host, behind Access. On any other host (the
  // workers.dev one Slack uses) a page visit is sent there, and anything else is refused.
  const home = uiOrigin(env)
  if (!home) {
    const error = 'The web UI is not set up: set UI_HOST, ACCESS_TEAM_DOMAIN and ACCESS_AUD (README, "Web UI").'
    console.warn(`ui refused ${url.pathname}: not set up`)
    return isApi ? json({ ok: false, error }, 503) : new Response(`${error}\n`, { status: 503, headers: uiHeaders('text/plain; charset=utf-8') })
  }
  if (url.origin !== home) {
    if ((request.method === 'GET' || request.method === 'HEAD') && !isApi) return Response.redirect(new URL(url.pathname + url.search, home).toString(), 302)
    return json({ ok: false, error: `The web UI is at ${home}.` }, 404)
  }
  const who = await accessIdentity(request, env)
  if (!who.ok) {
    console.warn(`ui refused ${url.pathname}: ${who.error}`)
    return isApi ? json({ ok: false, error: who.error }, who.status) : new Response(`${who.error}\n`, { status: who.status, headers: uiHeaders('text/plain; charset=utf-8') })
  }
  const email = who.identity.email

  if (isApi) {
    try {
      return await api(request, env, url, email)
    } catch (err) {
      console.error(`ui ${url.pathname} failed:`, err)
      return json({ ok: false, error: (err as Error).message }, 500)
    }
  }
  if (request.method !== 'GET') return new Response('not found', { status: 404 })
  if (url.pathname === '/ui') return Response.redirect(new URL('/ui/', url).toString(), 302)
  if (url.pathname === '/ui/app.js') return new Response(APP_JS, { headers: uiHeaders('text/javascript; charset=utf-8') })
  if (url.pathname === '/ui/transcript.js') return new Response(TRANSCRIPT_JS, { headers: uiHeaders('text/javascript; charset=utf-8') })
  if (url.pathname === '/ui/style.css') return new Response(STYLE, { headers: uiHeaders('text/css; charset=utf-8') })
  const page = pageFor(url.pathname)
  if (!page) return new Response('not found', { status: 404, headers: uiHeaders('text/plain; charset=utf-8') })
  return new Response(renderPage(SHELL, page), { headers: uiHeaders('text/html; charset=utf-8') })
}

async function api(request: Request, env: Env, url: URL, email: string): Promise<Response> {
  const path = url.pathname.slice('/ui/api'.length)
  const q = url.searchParams

  if (request.method === 'GET') {
    switch (path) {
      case '/me':
        return json({ ok: true, email, models: MODELS, defaultModel: DEFAULT_MODEL })
      case '/threads':
        return json({ ok: true, threads: await recentThreads(env, 100) })
      case '/follow': {
        const channel = q.get('channel') ?? ''
        const thread = q.get('thread') ?? ''
        if (!isChannelId(channel) || !isThreadTs(thread)) return json({ ok: false, error: 'give ?channel=<id>&thread=<ts>' }, 400)
        const [transcripts, live] = await Promise.all([threadTranscripts(env, channel, thread), threadStub(env, channel, thread).liveView()])
        return json({ ok: true, transcripts, live })
      }
      case '/transcript': {
        // The page decompresses it (it is the gzipped JSONL the sandbox sent), so it goes out as is.
        const channel = q.get('channel') ?? ''
        const thread = q.get('thread') ?? ''
        const key = q.get('key')
        if (!isTranscriptKeyFor(key, channel, thread)) return json({ ok: false, error: 'not a transcript of this thread' }, 400)
        const object = await env.TRANSCRIPTS.get(key)
        if (!object) return json({ ok: false, error: 'no such transcript' }, 404)
        return new Response(object.body, { headers: uiHeaders('application/octet-stream') })
      }
      case '/routines':
        return json({ ok: true, routines: await listRoutines(env, null) })
      case '/routines/runs': {
        const id = q.get('id')
        if (!isRoutineId(id)) return json({ ok: false, error: 'not a routine id' }, 400)
        return json({ ok: true, runs: await listRuns(env, id) })
      }
      case '/channels':
        return json({ ok: true, channels: await listChannels(env) })
    }
    return json({ ok: false, error: 'not found' }, 404)
  }

  const refused = checkWrite({
    method: request.method,
    contentType: request.headers.get('content-type'),
    origin: request.headers.get('origin'),
    selfOrigin: url.origin,
  })
  if (refused) return json({ ok: false, error: refused }, 403)
  const body = await request.json().catch(() => null)

  if (path === '/routines') {
    const checked = checkUiRoutine(body)
    if (!checked.ok) return json({ ok: false, error: checked.error }, 400)
    const a = checked.value
    if (a.action === 'create') {
      // Rule 6: the sandbox reports to the workers.dev address, never to this Access-guarded host.
      const origin = workerOrigin(env)
      if (!origin) return json({ ok: false, error: 'WORKER_URL is not set, so a routine made here could not report back. Run `npm run setup` again (README, "Web UI").' }, 503)
      const routine = await createRoutine(env, {
        channel: a.channel,
        prompt: a.prompt,
        cron: a.cron,
        timezone: a.timezone,
        model: a.model,
        origin,
        createdBy: null,
        createdThreadTs: null,
      })
      console.log(`ui: ${email} made routine ${routine.id} in ${a.channel}`)
      return json({ ok: true })
    }
    if (a.action === 'update') {
      const routine = await updateRoutine(env, a.id, a)
      if (!routine) return json({ ok: false, error: 'no such routine' }, 404)
      console.log(`ui: ${email} changed routine ${a.id}`)
      return json({ ok: true, routine })
    }
    if (a.action === 'delete') {
      if (!(await deleteRoutine(env, null, a.id))) return json({ ok: false, error: 'no such routine' }, 404)
      console.log(`ui: ${email} deleted routine ${a.id}`)
      return json({ ok: true })
    }
    const routine = await setRoutineStatus(env, null, a.id, a.action === 'pause' ? 'paused' : 'active')
    if (!routine) return json({ ok: false, error: 'no such routine' }, 404)
    return json({ ok: true, routine })
  }

  if (path === '/channels') {
    const checked = checkUiChannel(body)
    if (!checked.ok) return json({ ok: false, error: checked.error }, 400)
    const a = checked.value
    if (a.action === 'delete-secret') {
      await deleteChannelSecret(env, a.channel, a.name)
      return json({ ok: true })
    }
    const result =
      a.action === 'watch'
        ? await setWatched(env, a.channel, a.watched, email)
        : a.action === 'model'
          ? await setChannelModel(env, a.channel, a.model, email)
          : await putChannelSecret(env, a.channel, a.name, a.value, email)
    if (!result.ok) return json({ ok: false, error: result.error }, 400)
    // Never the value: a secret write answers with its name only.
    if (a.action === 'set-secret') console.log(`ui: ${email} set a secret in ${a.channel}`)
    return json({ ok: true })
  }
  return json({ ok: false, error: 'not found' }, 404)
}

/**
 * The App Home tab for one person (src/home.ts). `viewerDm` is the DM between them and the bot,
 * from the event, so their own DM threads show and nobody else's.
 */
export async function publishHome(env: Env, user: string, viewerDm: string | null) {
  const [threads, routines] = await Promise.all([recentThreads(env, 40), listRoutines(env, null)])
  const channels = [...threads.map((t) => t.channel), ...routines.map((r) => r.channel)]
  const visible = await visibleChannels(channels, viewerDm, async (id) => isPublicChannel(await channelInfo(env, id)))
  const view = homeView({
    uiOrigin: uiOrigin(env),
    threads: threads.filter((t) => visible.has(t.channel)),
    routines: routines.filter((r) => visible.has(r.channel)),
  })
  await slackApi(env, 'views.publish', { user_id: user, view })
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: uiHeaders('application/json; charset=utf-8') })
}

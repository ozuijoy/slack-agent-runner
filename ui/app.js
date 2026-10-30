// The web UI's one script. The page name comes from <body data-page>, which the Worker fills in.
// Everything from the API is put on the page as TEXT (textContent), never as HTML: transcripts and
// prompts hold text anyone in Slack could write.

import { LABELS, transcriptEntries } from './transcript.js'

const main = document.getElementById('main')
const page = document.body.dataset.page

/** Builds an element. Strings become text nodes; attributes starting with `on` become listeners. */
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue
    if (k.startsWith('on')) node.addEventListener(k.slice(2), v)
    else if (k === 'value') node.value = v
    else if (k === 'checked') node.checked = Boolean(v)
    else node.setAttribute(k, v === true ? '' : String(v))
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue
    node.append(child instanceof Node ? child : document.createTextNode(String(child)))
  }
  return node
}

async function api(path, body) {
  const res = await fetch(`/ui/api${path}`, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {})
  const json = await res.json().catch(() => ({ ok: false, error: `${res.status} ${res.statusText}` }))
  if (!json.ok) throw new Error(json.error || `${res.status}`)
  return json
}

function show(...nodes) {
  main.replaceChildren(...nodes)
}

function fail(err) {
  show(el('p', { class: 'error' }, String(err?.message ?? err)))
}

function when(ms) {
  return ms ? new Date(ms).toLocaleString() : ''
}

/** Runs `fn`, and shows its error next to `where` instead of throwing. */
async function act(where, fn) {
  try {
    await fn()
  } catch (err) {
    where.append(el('div', { class: 'error' }, String(err?.message ?? err)))
  }
}

let me = null

async function start() {
  for (const a of document.querySelectorAll('[data-nav]')) if (a.dataset.nav === page || (page === 'follow' && a.dataset.nav === 'threads')) a.classList.add('on')
  try {
    me = await api('/me')
    document.getElementById('me').textContent = me.email
  } catch (err) {
    return fail(err)
  }
  const pages = { threads, follow, routines, channels }
  await (pages[page] ?? threads)().catch(fail)
}

// ---------------------------------------------------------------------------------------------
// Threads.

async function threads() {
  const { threads } = await api('/threads')
  show(
    el('h1', {}, 'Recent threads'),
    threads.length
      ? el(
          'table',
          {},
          el('tr', {}, el('th', {}, 'Channel'), el('th', {}, 'Thread'), el('th', {}, 'Turns'), el('th', {}, 'Last backup')),
          threads.map((t) =>
            el(
              'tr',
              {},
              el('td', {}, el('code', {}, t.channel)),
              el('td', {}, el('a', { href: followHref(t.channel, t.thread_ts) }, t.thread_ts)),
              el('td', {}, String(t.turns)),
              el('td', {}, when(t.last_at)),
            ),
          ),
        )
      : el('p', { class: 'muted' }, 'No transcripts yet. They appear here after a thread’s first turn ends.'),
  )
}

function followHref(channel, thread) {
  return `/ui/follow?${new URLSearchParams({ channel, thread })}`
}

// ---------------------------------------------------------------------------------------------
// Follow: one thread's transcript. The newest R2 backup holds every finished turn; the live log
// holds the turn running now. Polled every 5 seconds.

async function follow() {
  const params = new URLSearchParams(location.search)
  const channel = params.get('channel') ?? ''
  const thread = params.get('thread') ?? ''
  const picker = el('select', {})
  const backup = el('div', {})
  const live = el('div', {})
  const status = el('p', { class: 'muted' })
  show(el('h1', {}, 'Thread ', el('code', {}, channel), ' · ', el('code', {}, thread)), el('div', { class: 'row' }, 'Backup: ', picker), status, backup, live)

  let shownKey = null
  let picked = null
  picker.addEventListener('change', () => {
    picked = picker.value || null
    shownKey = null
    tick()
  })

  async function tick() {
    let data
    try {
      data = await api(`/follow?${new URLSearchParams({ channel, thread })}`)
    } catch (err) {
      status.textContent = `Could not refresh: ${err.message}`
      return
    }
    const { transcripts, live: liveView } = data
    if (picker.options.length !== transcripts.length + 1 || picker.options[1]?.value !== transcripts[0]?.key) {
      picker.replaceChildren(
        el('option', { value: '' }, 'Newest'),
        transcripts.map((t) => el('option', { value: t.key }, `${when(t.created_at)} · turn ${t.turn_id.slice(0, 8)}`)),
      )
      picker.value = picked ?? ''
    }
    const key = picked ?? transcripts[0]?.key ?? null
    if (key && key !== shownKey) {
      shownKey = key
      await showBackup(channel, thread, key, backup)
    } else if (!key) {
      backup.replaceChildren(el('p', { class: 'muted' }, 'No backup yet: the first one lands when the first turn ends.'))
    }
    renderLive(liveView, transcripts, live)
    status.textContent = liveView.running ? `Running since ${when(liveView.running.startedAt)}${liveView.running.stopping ? ' (stopping)' : ''}. Refreshes every 5 seconds.` : 'Not running now.'
  }

  await tick()
  setInterval(() => document.visibilityState === 'visible' && tick(), 5000)
}

async function showBackup(channel, thread, key, into) {
  into.replaceChildren(el('p', { class: 'muted' }, 'Loading the backup…'))
  try {
    const res = await fetch(`/ui/api/transcript?${new URLSearchParams({ channel, thread, key })}`)
    if (!res.ok) throw new Error(`${res.status}`)
    // Stored gzipped; the browser unpacks it.
    const text = await new Response(res.body.pipeThrough(new DecompressionStream('gzip'))).text()
    const entries = transcriptEntries(text)
    into.replaceChildren(el('h2', {}, 'Finished turns'), entries.length ? entries.map(entryNode) : el('p', { class: 'muted' }, 'This backup holds no messages.'))
  } catch (err) {
    into.replaceChildren(el('p', { class: 'error' }, `Could not read the backup: ${err.message}`))
  }
}

function renderLive(view, transcripts, into) {
  const log = view.log
  // A finished turn's log is shown only until its backup is listed.
  const backedUp = log && transcripts.some((t) => t.turn_id === log.turnId)
  if (!log || (!view.running && backedUp)) {
    into.replaceChildren(view.running ? el('div', { class: 'live' }, el('h2', {}, 'Running now'), el('p', { class: 'muted' }, 'Starting…')) : '')
    return
  }
  const running = view.running?.turnId === log.turnId
  const atBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 40
  into.replaceChildren(
    el(
      'div',
      { class: 'live' },
      el('h2', {}, running ? 'Running now' : 'Latest turn (its backup is on the way)'),
      log.dropped ? el('p', { class: 'muted' }, `${log.dropped} earlier lines are not kept here; the backup will have them.`) : null,
      log.entries.map(entryNode),
    ),
  )
  if (running && atBottom) window.scrollTo(0, document.body.scrollHeight)
}

function entryNode(e) {
  const label = `${LABELS[e.kind] ?? e.kind}${e.name ? ` · ${e.name}` : ''}`
  const body = e.text.length > 1200 && (e.kind === 'result' || e.kind === 'tool' || e.kind === 'thinking')
    ? el('details', {}, el('summary', {}, `${e.text.slice(0, 200)}…`), el('pre', {}, e.text))
    : el('pre', {}, e.text)
  return el('div', { class: `entry ${e.kind}` }, el('div', { class: 'label' }, label), body)
}

// ---------------------------------------------------------------------------------------------
// Routines.

async function routines() {
  const { routines } = await api('/routines')
  const list = el('div', {})
  for (const r of routines) list.append(routineCard(r))
  show(
    el('h1', {}, 'Routines'),
    el('p', { class: 'muted' }, 'Each run posts a new thread in its channel and runs a whole Claude turn, so a busy schedule costs money.'),
    routineForm(null),
    routines.length ? list : el('p', { class: 'muted' }, 'No routines yet. Add one above, or ask the bot in a thread.'),
  )
}

function routineCard(r) {
  const card = el('div', { class: 'card' })
  const runs = el('div', {})
  const reload = () => routines().catch(fail)
  card.append(
    el(
      'div',
      { class: 'row' },
      el('code', {}, r.id),
      el('span', {}, 'in ', el('code', {}, r.channel)),
      el('code', {}, r.cron),
      el('span', { class: 'muted' }, r.timezone),
      el('span', {}, r.model ?? 'channel default'),
      el('strong', {}, r.status),
      r.nextRun ? el('span', { class: 'muted' }, `next ${r.nextRun}`) : null,
    ),
    el('pre', {}, r.prompt),
    el(
      'div',
      { class: 'row' },
      el('button', { onclick: () => card.replaceChildren(routineForm(r)) }, 'Edit'),
      el('button', { onclick: () => act(card, async () => (await api('/routines', { action: r.status === 'active' ? 'pause' : 'resume', id: r.id }), reload())) }, r.status === 'active' ? 'Pause' : 'Resume'),
      el('button', { onclick: () => confirm(`Delete routine ${r.id}?`) && act(card, async () => (await api('/routines', { action: 'delete', id: r.id }), reload())) }, 'Delete'),
      el('button', { onclick: () => act(card, async () => showRuns(r.id, runs)) }, 'Runs'),
    ),
    runs,
  )
  return card
}

async function showRuns(id, into) {
  const { runs } = await api(`/routines/runs?${new URLSearchParams({ id })}`)
  into.replaceChildren(
    runs.length
      ? el(
          'table',
          {},
          el('tr', {}, el('th', {}, 'Due'), el('th', {}, 'Status'), el('th', {}, 'Thread'), el('th', {}, 'Error')),
          runs.map((run) => el('tr', {}, el('td', {}, when(run.due_at)), el('td', {}, run.status), el('td', {}, run.thread_ts ?? ''), el('td', { class: 'error' }, run.error ?? ''))),
        )
      : el('p', { class: 'muted' }, 'No runs yet.'),
  )
}

/** The add form (r null) or the edit form for routine r. */
function routineForm(r) {
  const channel = el('input', { placeholder: 'Channel id, C…', value: '' })
  const prompt = el('textarea', { placeholder: 'What to do on each run' })
  prompt.value = r?.prompt ?? ''
  const cron = el('input', { placeholder: '0 9 * * 1', value: r?.cron ?? '' })
  const tz = el('input', { value: r?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone })
  const model = el('select', {}, el('option', { value: '' }, 'channel default'), Object.keys(me.models).map((m) => el('option', { value: m }, m)))
  model.value = r?.model ?? ''
  const box = el('div', { class: 'card' })
  const save = () =>
    act(box, async () => {
      const fields = { prompt: prompt.value, cron: cron.value, timezone: tz.value, model: model.value || null }
      await api('/routines', r ? { action: 'update', id: r.id, ...fields } : { action: 'create', channel: channel.value.trim(), ...fields })
      await routines()
    })
  box.append(
    el('h2', {}, r ? `Edit ${r.id}` : 'Add a routine'),
    r ? null : el('div', { class: 'row' }, channel),
    prompt,
    el('div', { class: 'row' }, 'Cron ', cron, ' Time zone ', tz, ' Model ', model),
    el('div', { class: 'row' }, el('button', { onclick: save }, r ? 'Save' : 'Add'), r ? el('button', { onclick: () => routines().catch(fail) }, 'Cancel') : null),
    el('p', { class: 'muted' }, 'Cron: minute hour day month weekday. "0 9 * * 1-5" is 9:00 on weekdays.'),
  )
  return box
}

// ---------------------------------------------------------------------------------------------
// Channels: watched, default model, secrets (write-only: names come back, values never do).

async function channels() {
  const { channels } = await api('/channels')
  const list = el('div', {})
  for (const c of channels) list.append(channelCard(c))
  const id = el('input', { placeholder: 'Channel id, C… / G… / D…' })
  show(
    el('h1', {}, 'Channels'),
    el('p', { class: 'muted' }, 'A watched channel gets an answer to every new message, no @mention needed. Secrets reach only that channel’s sandboxes, as environment variables; anyone who can talk to the bot there could get Claude to print them.'),
    el('div', { class: 'row' }, id, el('button', { onclick: () => id.value.trim() && list.prepend(channelCard({ channel: id.value.trim(), watched: false, model: null, secrets: [] })) }, 'Add a channel')),
    list,
  )
}

function channelCard(c) {
  const card = el('div', { class: 'card' })
  const reload = () => channels().catch(fail)
  const watched = el('input', { type: 'checkbox', checked: c.watched, disabled: c.channel.startsWith('D') })
  watched.addEventListener('change', () => act(card, () => api('/channels', { action: 'watch', channel: c.channel, watched: watched.checked })))
  const model = el('select', {}, el('option', { value: '' }, `default (${me.defaultModel})`), Object.keys(me.models).map((m) => el('option', { value: m }, m)))
  model.value = c.model ?? ''
  model.addEventListener('change', () => act(card, () => api('/channels', { action: 'model', channel: c.channel, model: model.value || null })))
  const name = el('input', { placeholder: 'NAME' })
  const value = el('input', { type: 'password', placeholder: 'value', autocomplete: 'off' })
  card.append(
    el('div', { class: 'row' }, el('strong', {}, el('code', {}, c.channel)), el('label', {}, watched, ' watched'), el('label', {}, 'Model ', model)),
    el(
      'div',
      { class: 'row' },
      'Secrets: ',
      c.secrets.length
        ? c.secrets.map((s) =>
            el('span', {}, el('code', {}, s), ' ', el('button', { onclick: () => confirm(`Delete ${s}?`) && act(card, async () => (await api('/channels', { action: 'delete-secret', channel: c.channel, name: s }), reload())) }, '×')),
          )
        : el('span', { class: 'muted' }, 'none'),
    ),
    el(
      'div',
      { class: 'row' },
      name,
      value,
      el('button', {
        onclick: () =>
          act(card, async () => {
            await api('/channels', { action: 'set-secret', channel: c.channel, name: name.value.trim(), value: value.value })
            value.value = ''
            await reload()
          }),
      }, 'Set secret'),
    ),
  )
  return card
}

start()

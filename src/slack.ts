import { timingSafeEqual } from './callback-token.ts'
import type { Env } from './env.ts'
import { toMrkdwn } from './mrkdwn.js'

/** Slack refuses a message over 40,000 characters and folds long ones badly; split well below. */
const CHUNK_CHARS = 3800

/** Requests older than this are refused, so a captured request cannot be replayed later. */
const MAX_SKEW_SECONDS = 5 * 60

/** https://api.slack.com/authentication/verifying-requests-from-slack */
export async function verifySlackSignature(
  signingSecret: string,
  rawBody: string,
  timestamp: string | null,
  signature: string | null,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  if (!timestamp || !signature?.startsWith('v0=')) return false
  const ts = Number(timestamp)
  if (!Number.isFinite(ts) || Math.abs(nowSeconds - ts) > MAX_SKEW_SECONDS) return false

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(signingSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`v0:${timestamp}:${rawBody}`)))
  const expected = new TextEncoder().encode('v0=' + [...mac].map((b) => b.toString(16).padStart(2, '0')).join(''))
  return timingSafeEqual(expected, new TextEncoder().encode(signature))
}

/**
 * Slack's read methods take only form-encoded arguments; a JSON body reaches them empty. The code
 * channel methods (beta) go form-encoded too, as Slack's own SDK sends them.
 */
const FORM_METHODS = new Set([
  'agents.conversations.create',
  'agents.conversations.listViews',
  'agents.conversations.setView',
  'agents.conversations.archive',
  'agents.sessions.setStatus',
  'conversations.replies',
  'conversations.history',
  'users.info',
  'files.info',
  'conversations.info',
  'files.getUploadURLExternal',
  'files.completeUploadExternal',
])

export async function slackApi(env: Env, method: string, args: Record<string, unknown>) {
  const form = FORM_METHODS.has(method)
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
      'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json; charset=utf-8',
    },
    body: form
      ? new URLSearchParams(Object.entries(args).map(([k, v]) => [k, formValue(v)]))
      : JSON.stringify(args),
  })
  const json = (await res.json()) as { ok: boolean; error?: string; [key: string]: unknown }
  if (!json.ok) throw new Error(`slack ${method}: ${json.error ?? res.status}`)
  return json
}

/** A form field: objects and arrays (Block Kit, a tab's blocks) as JSON, as Slack's SDK sends them. */
export function formValue(v: unknown): string {
  return v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v)
}

/** Posts Markdown into a thread as Slack mrkdwn, split into several messages when it is long. */
export async function postInThread(env: Env, channel: string, threadTs: string, markdown: string) {
  for (const text of splitMessage(toMrkdwn(markdown))) {
    await slackApi(env, 'chat.postMessage', { channel, thread_ts: threadTs, text, unfurl_links: false })
  }
}

/** Posts Markdown at the top level of a channel (a code channel's answer has no thread). */
export async function postInChannel(env: Env, channel: string, markdown: string) {
  for (const text of splitMessage(toMrkdwn(markdown))) {
    await slackApi(env, 'chat.postMessage', { channel, text, unfurl_links: false })
  }
}

/** Splits on paragraph, then line, boundaries so code blocks and lists break as rarely as possible. */
export function splitMessage(text: string, max = CHUNK_CHARS): string[] {
  const trimmed = text.trim()
  if (!trimmed) return []
  const chunks: string[] = []
  let rest = trimmed
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n\n', max)
    if (cut < max / 2) cut = rest.lastIndexOf('\n', max)
    if (cut < max / 2) cut = max
    chunks.push(rest.slice(0, cut).trimEnd())
    rest = rest.slice(cut).trimStart()
  }
  if (rest) chunks.push(rest)
  return chunks
}

/** Reactions are a status light, never worth failing a turn over. */
export async function react(env: Env, channel: string, ts: string, add: string | null, remove: string | null = null) {
  const calls: Promise<unknown>[] = []
  if (remove) calls.push(slackApi(env, 'reactions.remove', { channel, timestamp: ts, name: remove }))
  if (add) calls.push(slackApi(env, 'reactions.add', { channel, timestamp: ts, name: add }))
  await Promise.allSettled(calls)
}

/** The thread's messages before `beforeTs`, oldest first, for the first turn's prompt. */
export async function threadHistory(env: Env, channel: string, threadTs: string, beforeTs: string, limit = 30) {
  const json = await slackApi(env, 'conversations.replies', { channel, ts: threadTs, limit: 200 }).catch((err) => {
    console.warn('could not read thread history:', err.message)
    return { messages: [] }
  })
  const messages = (json.messages as Array<{ ts: string; user?: string; bot_id?: string; text?: string }>) ?? []
  return messages
    .filter((m) => Number(m.ts) < Number(beforeTs) && m.text)
    .slice(-limit)
    .map((m) => ({ ts: m.ts, user: m.user ?? (m.bot_id ? 'a bot' : 'unknown'), text: m.text ?? '' }))
}

/** Posts one message and returns its ts. */
export async function postMessage(env: Env, args: { channel: string; thread_ts: string; text: string; blocks?: unknown[] }) {
  const json = await slackApi(env, 'chat.postMessage', { ...args, unfurl_links: false })
  return json.ts as string
}

export async function updateMessage(env: Env, args: { channel: string; ts: string; text: string; blocks?: unknown[] }) {
  await slackApi(env, 'chat.update', args)
}

/** A status message is tidying, never worth failing anything over; a gone message is fine. */
export async function deleteMessage(env: Env, channel: string, ts: string) {
  await slackApi(env, 'chat.delete', { channel, ts }).catch((err) => {
    if (!String(err?.message).includes('message_not_found')) console.warn(`could not delete ${ts}:`, err?.message ?? err)
  })
}

/** A file's full object (files.info), or null when Slack will not say. */
export async function fileInfo(env: Env, fileId: string): Promise<Record<string, unknown> | null> {
  const json = await slackApi(env, 'files.info', { file: fileId })
  return (json.file as Record<string, unknown>) ?? null
}

/**
 * Posts a file into a thread, with Slack's three-step upload: ask for an upload URL, send the bytes
 * there (that step carries no token), then share the file into the thread. Returns its permalink.
 */
export async function uploadToThread(
  env: Env,
  args: { channel: string; threadTs: string; filename: string; title?: string; comment?: string; bytes: ArrayBuffer },
): Promise<string | null> {
  const start = await slackApi(env, 'files.getUploadURLExternal', { filename: args.filename, length: args.bytes.byteLength })
  const uploadUrl = start.upload_url as string
  const fileId = start.file_id as string
  const sent = await fetch(uploadUrl, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: args.bytes })
  if (!sent.ok) throw new Error(`slack upload: ${sent.status}`)
  const done = await slackApi(env, 'files.completeUploadExternal', {
    files: JSON.stringify([{ id: fileId, ...(args.title ? { title: args.title } : {}) }]),
    channel_id: args.channel,
    thread_ts: args.threadTs,
    ...(args.comment ? { initial_comment: toMrkdwn(args.comment) } : {}),
  })
  const files = done.files as Array<{ permalink?: string }> | undefined
  return files?.[0]?.permalink ?? null
}

/**
 * Makes a canvas from Markdown, lets the channel's members edit it, and returns its id and link.
 * The link line in the thread is the caller's to post. A failed share leaves a canvas only the bot
 * can see, so it throws rather than post a link nobody can open.
 */
export async function createCanvas(env: Env, args: { channel: string; title: string; markdown: string }) {
  const made = await slackApi(env, 'canvases.create', {
    title: args.title,
    document_content: { type: 'markdown', markdown: args.markdown },
  })
  const canvasId = made.canvas_id as string
  await slackApi(env, 'canvases.access.set', { canvas_id: canvasId, access_level: 'write', channel_ids: [args.channel] })
  const info = await fileInfo(env, canvasId).catch(() => null)
  return { canvasId, permalink: (info?.permalink as string | undefined) ?? null }
}

/** A channel's conversations.info object, or null when Slack will not say (not found, no access). */
export async function channelInfo(env: Env, channelId: string): Promise<Record<string, unknown> | null> {
  const json = await slackApi(env, 'conversations.info', { channel: channelId }).catch(() => null)
  return (json?.channel as Record<string, unknown> | undefined) ?? null
}

/** A person's Slack time zone (users.info, scope users:read), or null when Slack will not say. */
export async function userTimezone(env: Env, user: string): Promise<string | null> {
  try {
    const json = await slackApi(env, 'users.info', { user })
    const tz = (json.user as { tz?: unknown } | undefined)?.tz
    return typeof tz === 'string' && tz ? tz : null
  } catch (err) {
    console.warn(`could not read ${user}'s time zone:`, (err as Error).message)
    return null
  }
}

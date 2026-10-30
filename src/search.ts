/**
 * The rules for workspace search. The I/O is in src/index.ts (POST /sandbox/search) and
 * box/tools.mjs (`search`, the sandbox side).
 *
 * PUBLIC CHANNELS ONLY. Claude runs on text anyone can write, so whatever it can search, anyone who
 * can talk to the bot can read. A private channel, a DM or a group DM never comes back, whichever
 * channel the thread is in. Three locks, each enough on its own for the common case:
 *
 *   1. The bot token. Slack's `assistant.search.context` with a bot token sees public channels
 *      only (the bot scopes are `search:read.public`, `.files`, `.users`; there is no private one).
 *   2. The request asks for `channel_types: public_channel` and `content_types: messages` only.
 *   3. Every result is checked against `conversations.info` before it leaves the Worker, and is
 *      dropped unless Slack says its channel is a public channel. A lookup that fails drops it too.
 *
 * THE ACTION TOKEN. Slack lets a bot token search only while a person is talking to the bot: each
 * call needs the `action_token` Slack puts on an @mention or a DM event, and it expires soon after.
 * The thread keeps the newest one its running turn was sent (src/thread.ts), the door reads it from
 * there, and it never enters the sandbox. A turn with none (a follow-up typed without a mention)
 * still tries, and if Slack refuses, Claude is told to ask for an @mention.
 */

/** Slack's own maximum per page. */
export const MAX_RESULTS = 20
export const DEFAULT_RESULTS = 10
export const MAX_QUERY_CHARS = 500
/** Per result, so twenty long messages cannot flood Claude's context. */
export const MAX_RESULT_CHARS = 2000

export type SearchRequest = { ok: true; query: string; limit: number } | { ok: false; error: string }

/** Checks what the sandbox sent. Only the query and a count; nothing else in the body is read. */
export function checkSearch(body: unknown): SearchRequest {
  const b = body as { query?: unknown; limit?: unknown } | null
  const query = typeof b?.query === 'string' ? b.query.trim() : ''
  if (!query) return { ok: false, error: 'missing query' }
  if (query.length > MAX_QUERY_CHARS) return { ok: false, error: `query is over ${MAX_QUERY_CHARS} characters` }
  let limit = DEFAULT_RESULTS
  if (b?.limit !== undefined) {
    if (typeof b.limit !== 'number' || !Number.isInteger(b.limit) || b.limit < 1) return { ok: false, error: 'limit must be a whole number from 1' }
    limit = Math.min(b.limit, MAX_RESULTS)
  }
  return { ok: true, query, limit }
}

/** The arguments for assistant.search.context. Public channels and messages, set here, never by the caller. */
export function searchArgs(query: string, limit: number, actionToken?: string) {
  return {
    query,
    limit,
    channel_types: 'public_channel',
    content_types: 'messages',
    include_context_messages: false,
    // Only when there is one: an empty token is a different, refused, request.
    ...(actionToken ? { action_token: actionToken } : {}),
  }
}

export interface SearchHit {
  channelId: string
  channelName: string
  ts: string
  user: string
  text: string
  permalink: string
}

/**
 * One result in one shape. Slack has used more than one field name for each of these, and reading
 * the wrong one fails silently (the right number of results, every field blank), so try each.
 */
export function normalise(m: Record<string, unknown>): SearchHit {
  const s = (v: unknown) => (typeof v === 'string' ? v : '')
  const channel = (m.channel ?? {}) as Record<string, unknown>
  const text = (s(m.content) || s(m.text)).trim()
  return {
    channelId: s(m.channel_id) || s(channel.id),
    channelName: s(m.channel_name) || s(channel.name),
    ts: s(m.message_ts) || s(m.ts),
    user: s(m.author_user_id) || s(m.user),
    text: text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}…` : text,
    permalink: s(m.permalink),
  }
}

/** The raw results from a search answer, wherever Slack put them. */
export function resultsOf(json: Record<string, unknown>): Record<string, unknown>[] {
  const results = json.results as { messages?: unknown } | undefined
  const list = results?.messages ?? json.messages
  return Array.isArray(list) ? list.filter((m): m is Record<string, unknown> => Boolean(m) && typeof m === 'object') : []
}

/**
 * Is this channel (a conversations.info object) a public channel? Every flag that marks something
 * else has to be clearly off; a missing object is not public.
 */
export function isPublicChannel(info: Record<string, unknown> | null | undefined): boolean {
  if (!info) return false
  if (info.is_channel !== true) return false
  if (info.is_private !== false) return false
  if (info.is_im === true || info.is_mpim === true || info.is_group === true) return false
  return true
}

/**
 * Keeps only results from public channels. `lookup` returns the channel's conversations.info
 * object, or null when Slack would not say; each channel is looked up once. A result with no
 * channel id is dropped, as is one whose lookup throws.
 */
export async function publicOnly(
  hits: SearchHit[],
  lookup: (channelId: string) => Promise<Record<string, unknown> | null>,
): Promise<{ hits: SearchHit[]; dropped: number }> {
  const verdicts = new Map<string, Promise<{ public: boolean; name: string }>>()
  const check = (id: string) => {
    let v = verdicts.get(id)
    if (!v) {
      v = lookup(id).then(
        (info) => ({ public: isPublicChannel(info), name: typeof info?.name === 'string' ? info.name : '' }),
        () => ({ public: false, name: '' }),
      )
      verdicts.set(id, v)
    }
    return v
  }
  // All lookups at once; twenty results span at most twenty channels.
  const verdictList = await Promise.all(hits.map((hit) => (hit.channelId ? check(hit.channelId) : null)))
  const kept: SearchHit[] = []
  hits.forEach((hit, i) => {
    const verdict = verdictList[i]
    if (verdict?.public) kept.push({ ...hit, channelName: hit.channelName || verdict.name })
  })
  return { hits: kept, dropped: hits.length - kept.length }
}

/** What Claude is told when Slack refuses, in words that say what to do next. */
export function searchErrorHint(error: string, hadActionToken: boolean): string {
  if (error.includes('missing_scope')) return `${error}: the Slack app needs the search:read.public scope; add it and reinstall the app`
  if (/action_token/.test(error) || (!hadActionToken && /not_allowed|invalid_auth|token/.test(error))) {
    return hadActionToken
      ? `${error}: Slack's search permission for this turn has expired; ask the person to @mention the bot again`
      : `${error}: Slack lets the bot search only in a turn started by an @mention or a DM; ask the person to @mention the bot`
  }
  return error
}

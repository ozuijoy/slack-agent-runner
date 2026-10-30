/**
 * The live status message: the rules for what it says and for reading a Stop click. Plain
 * functions, so they can be tested without Slack. The I/O lives in src/turn.ts and src/index.ts.
 *
 * While a turn runs, the thread shows ONE status message under the user's message:
 *
 *   ⏳ Running `npm test` · 14 steps · 3m
 *   Follow along                                    (a link to the transcript page)
 *   [ Stop ]
 *
 * The Worker posts it when the turn starts. The sandbox reports what Claude is doing to
 * /sandbox/progress every few seconds, and the Worker edits the message. When the answer arrives
 * it is posted as a NEW message and the status message is deleted, so a late progress edit can
 * only fail on a message that is gone; it can never overwrite the answer.
 *
 * The activity text comes from the sandbox, which runs Claude on text anyone can write. So it is
 * capped and escaped here before it reaches Slack: it can say what Claude is doing, and nothing
 * else (no @channel, no mentions, no links).
 */

export const STOP_ACTION_ID = 'stop_turn'

/** Longest activity text shown. The step counter and the clock always fit after it. */
export const MAX_ACTIVITY_CHARS = 150

export interface StatusLine {
  /** What Claude is doing now, as the sandbox said it. Untrusted. */
  activity?: string
  /** How many tool calls Claude has made this turn, as the sandbox said it. Untrusted. */
  steps?: number
  /** How long the turn has run, measured by the Worker. */
  elapsedMs: number
}

/** The status line, with every untrusted part capped and escaped on its own. */
export function statusLine({ activity, steps, elapsedMs }: StatusLine) {
  const parts = [cleanActivity(activity) || 'Working…']
  const n = Number.isFinite(steps) ? Math.min(Math.max(Math.floor(steps!), 0), 100_000) : 0
  if (n) parts.push(`${n} ${n === 1 ? 'step' : 'steps'}`)
  parts.push(formatElapsed(elapsedMs))
  return `:hourglass_flowing_sand: ${parts.join(' · ')}`
}

/** One line, at most MAX_ACTIVITY_CHARS, with Slack's control characters escaped. */
export function cleanActivity(raw: unknown) {
  if (typeof raw !== 'string') return ''
  let text = raw.replace(/\s+/g, ' ').trim()
  if (text.length > MAX_ACTIVITY_CHARS) text = text.slice(0, MAX_ACTIVITY_CHARS - 1).trimEnd() + '…'
  // Slack reads <...> as a mention, a channel ping or a link; escaped, it is just text.
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

export function formatElapsed(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

/**
 * The transcript page for a thread (/ui/follow, src/ui-routes.ts): its R2 backups and the live
 * turn. `origin` is the UI's own (uiOrigin in src/ui.ts), not the Worker's; null gives no link. Behind Cloudflare Access, so the link carries no credential; a forwarded link opens nothing
 * for someone Access does not let in.
 */
export function followUrl(origin: string, channel: string, threadTs: string): string
export function followUrl(origin: string | null, channel: string, threadTs: string): string | null
export function followUrl(origin: string | null, channel: string, threadTs: string): string | null {
  if (!origin) return null
  const url = new URL('/ui/follow', origin)
  url.searchParams.set('channel', channel)
  url.searchParams.set('thread', threadTs)
  return url.toString()
}

/**
 * The status message's blocks. `chat.update` drops any block it is not sent again, so every edit
 * sends all of them: leaving out the button (`turnId: null`) is how "Stopping…" removes it.
 */
export function statusBlocks(opts: { line: string; followUrl: string | null; turnId: string | null }) {
  const blocks: unknown[] = [{ type: 'section', text: { type: 'mrkdwn', text: opts.line } }]
  // No link while the web UI is not set up (rule 5 in src/ui.ts): it would only open "not set up".
  if (opts.followUrl) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `<${opts.followUrl}|Follow along>` }] })
  if (opts.turnId) {
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          action_id: STOP_ACTION_ID,
          text: { type: 'plain_text', text: 'Stop' },
          style: 'danger',
          // Only the turn id. The channel and thread come from Slack's own fields on the click.
          value: opts.turnId,
        },
      ],
    })
  }
  return blocks
}

export interface StopClick {
  channel: string
  threadTs: string
  /** The status message the button sits on. */
  messageTs: string
  turnId: string
  user: string
  responseUrl?: string
}

/**
 * Reads a Stop click out of an interactivity payload (already signature-checked), or null for
 * anything else. The channel and thread are Slack's own fields for where the button sits, so a
 * click can only stop the turn in that thread; the turn id then has to be the one running there.
 */
export function parseStopClick(payload: unknown): StopClick | null {
  const p = payload as {
    type?: string
    user?: { id?: string }
    channel?: { id?: string }
    container?: { channel_id?: string; message_ts?: string; thread_ts?: string }
    message?: { ts?: string; thread_ts?: string }
    actions?: Array<{ action_id?: string; value?: string }>
    response_url?: string
  } | null
  if (p?.type !== 'block_actions') return null
  const action = p.actions?.find((a) => a.action_id === STOP_ACTION_ID)
  if (!action?.value) return null
  const channel = p.channel?.id ?? p.container?.channel_id
  const messageTs = p.container?.message_ts ?? p.message?.ts
  const threadTs = p.message?.thread_ts ?? p.container?.thread_ts
  if (!channel || !messageTs || !threadTs || !p.user?.id) return null
  const responseUrl = p.response_url?.startsWith('https://hooks.slack.com/') ? p.response_url : undefined
  return { channel, threadTs, messageTs, turnId: action.value.slice(0, 100), user: p.user.id, responseUrl }
}

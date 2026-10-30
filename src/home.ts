/**
 * The App Home tab: recent threads, routines and a link to the web UI. Published with views.publish
 * each time someone opens the tab (the `app_home_opened` event). The I/O is in src/ui-routes.ts
 * (publishHome); this file decides what goes on it.
 *
 * 1. EVERYONE IN THE WORKSPACE CAN OPEN IT, so it shows only what anyone could see anyway: threads
 *    and routines in PUBLIC channels (conversations.info, src/search.ts isPublicChannel), plus the
 *    viewer's own DM with the bot. Never a private channel's, never someone else's DM.
 * 2. TEXT FROM PEOPLE IS ESCAPED. A routine's prompt is shown as written, never as a mention or a link.
 * 3. SMALL. Slack allows 100 blocks on a tab; the lists are capped well below that.
 */

import type { ThreadSummary } from './db.ts'
import { escapeSlack } from './routines.ts'
import { followUrl } from './status.ts'

export const HOME_THREADS = 10
export const HOME_ROUTINES = 15

export interface HomeRoutine {
  id: string
  channel: string
  prompt: string
  cron: string
  timezone: string
  status: string
  nextRun: string | null
}

/**
 * Rule 1: which of these channels the viewer may see listed. `isPublic` answers for one channel id;
 * the viewer's DM with the bot is always theirs.
 */
export async function visibleChannels(channels: string[], viewerDm: string | null, isPublic: (id: string) => Promise<boolean>): Promise<Set<string>> {
  const unique = [...new Set(channels)]
  const verdicts = await Promise.all(unique.map((id) => (id === viewerDm ? true : isPublic(id).catch(() => false))))
  return new Set(unique.filter((_, i) => verdicts[i]))
}

/** `uiOrigin` is the web UI's (uiOrigin in src/ui.ts), or null while it is not set up. */
export function homeView(opts: { uiOrigin: string | null; threads: ThreadSummary[]; routines: HomeRoutine[] }) {
  const blocks: unknown[] = []
  blocks.push({ type: 'header', text: { type: 'plain_text', text: 'Your Claude agent' } })
  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: '@mention me in a channel, or message me here, and I run Claude Code in a sandbox for the thread. `!model sonnet` picks a model for a thread.',
    },
  })
  if (opts.uiOrigin) {
    blocks.push({
      type: 'actions',
      elements: [{ type: 'button', text: { type: 'plain_text', text: 'Open the web UI' }, url: new URL('/ui/', opts.uiOrigin).toString(), action_id: 'open_ui' }],
    })
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: 'Transcripts, routines and channel settings. Sign-in through Cloudflare Access.' }] })
  } else {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: 'The web UI is not set up yet (README, "Web UI").' }] })
  }

  blocks.push({ type: 'divider' })
  blocks.push({ type: 'header', text: { type: 'plain_text', text: 'Recent threads' } })
  const threads = opts.threads.slice(0, HOME_THREADS)
  if (!threads.length) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: 'No threads yet that you can see here.' }] })
  }
  for (const t of threads) {
    const when = slackDate(t.last_at)
    const link = opts.uiOrigin ? ` · <${followUrl(opts.uiOrigin, t.channel, t.thread_ts)}|transcript>` : ''
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `${where(t.channel)} · ${t.turns} ${t.turns === 1 ? 'turn' : 'turns'} · ${when}${link}` },
    })
  }

  blocks.push({ type: 'divider' })
  blocks.push({ type: 'header', text: { type: 'plain_text', text: 'Routines' } })
  const routines = opts.routines.slice(0, HOME_ROUTINES)
  if (!routines.length) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: 'None yet. Ask me in a thread: "every Monday at 9am, check the open PRs".' }] })
  }
  for (const r of routines) {
    const prompt = escapeSlack(r.prompt.replace(/\s+/g, ' ').trim())
    const state = r.status === 'active' ? (r.nextRun ? `next ${r.nextRun}` : 'never fires') : 'paused'
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `\`${r.id}\` in ${where(r.channel)} · \`${r.cron}\` · ${state}\n>${prompt.length > 200 ? `${prompt.slice(0, 199)}…` : prompt}`,
      },
    })
  }
  if (opts.routines.length > routines.length) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `And ${opts.routines.length - routines.length} more on the web UI's Routines page.` }] })
  }
  return { type: 'home', blocks }
}

/** A channel mention, or "your DM" for a DM (Slack renders <#D…> badly). */
function where(channel: string) {
  return channel.startsWith('D') ? 'your DM' : `<#${channel}>`
}

/** Slack shows this in the reader's own time zone. */
function slackDate(ms: number) {
  const s = Math.floor(ms / 1000)
  return `<!date^${s}^{date_short_pretty} {time}|${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC>`
}

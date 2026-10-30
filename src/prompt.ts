import type { SlackMessage } from './thread.ts'

/**
 * The Claude session id for a thread: a UUIDv5 of `channel:threadTs`.
 *
 * Derived, not stored. Every turn in the thread computes the same id, so `claude --resume` finds the
 * conversation with no database. Claude Code only accepts a UUID, hence the v5 shape.
 */
const SESSION_NAMESPACE = '6c9e3a1f-8b2d-4f7a-9c31-5a0e7d24b18f'

export async function sessionIdFor(channel: string, threadTs: string): Promise<string> {
  const ns = Uint8Array.from(SESSION_NAMESPACE.replace(/-/g, '').match(/../g)!, (h) => parseInt(h, 16))
  const name = new TextEncoder().encode(`${channel}:${threadTs}`)
  const input = new Uint8Array(ns.length + name.length)
  input.set(ns)
  input.set(name, ns.length)
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-1', input)).slice(0, 16)
  bytes[6] = (bytes[6] & 0x0f) | 0x50 // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80 // RFC 4122 variant
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/**
 * What Claude reads for one turn. On the first turn of a thread it also gets the messages that came
 * before the mention, so "@bot what do you think of the above?" works.
 */
export function buildPrompt(opts: { messages: SlackMessage[]; history: SlackMessage[]; githubEnabled: boolean }): string {
  const parts: string[] = []
  if (opts.history.length) {
    parts.push('Earlier messages in this Slack thread, oldest first:', ...opts.history.map(line), '')
  }
  parts.push(opts.messages.length > 1 ? 'New messages for you:' : 'New message for you:', ...opts.messages.map(line), '')
  parts.push(
    opts.githubEnabled
      ? 'GitHub access is on for this turn: GH_TOKEN is set and git can push over https.'
      : 'GitHub access is off for this turn.',
  )
  return parts.join('\n')
}

function line(m: SlackMessage) {
  return `<@${m.user}>: ${m.text}`
}

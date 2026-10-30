// Mid-turn messages: a follow-up sent while Claude works reaches it at its next tool step.
//
// The Worker hands follow-ups to the running turn in its /sandbox/progress answers. run-turn.mjs
// writes each one into the turn's inbox folder as `<ts>.json`. After every tool call Claude Code
// runs inbox-hook.mjs (a PostToolUse hook), which claims every waiting file by renaming it to
// `<ts>.taken` and hands the messages to Claude as extra context. When the turn ends, the runner
// reports the `.taken` names; the Worker counts a follow-up as answered only if it was taken AND
// the turn ended with an answer (src/thread.ts rule 7). Anything else runs as the next turn.
//
// Shared by the runner and the hook, which the Worker writes beside each other (src/sandbox.ts).

import { readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** A Slack ts, and so a safe file name: digits, one dot, digits. */
const TS = /^\d+\.\d+$/

/** The status line once Claude has read a follow-up. */
export const READ_ACTIVITY = ':incoming_envelope: Read your new message'

/**
 * Writes the follow-ups not written yet. `written` remembers ts across calls, because the Worker
 * sends the whole inbox on every answer. Each file is written under a temporary name and renamed,
 * so the hook never reads half a file. Returns how many were new.
 */
export function deliver(dir, messages, written) {
  let added = 0
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!TS.test(String(m?.ts)) || written.has(m.ts)) continue
    const body = JSON.stringify({ ts: m.ts, user: String(m.user ?? ''), text: String(m.text ?? '') })
    writeFileSync(join(dir, `${m.ts}.part`), body)
    renameSync(join(dir, `${m.ts}.part`), join(dir, `${m.ts}.json`))
    written.add(m.ts)
    added++
  }
  return added
}

/**
 * Claims every waiting follow-up, oldest first. The rename is the claim: a file renamed here is
 * this call's alone, and its `.taken` name is what tells the Worker Claude has it.
 */
export function takeAll(dir) {
  const taken = []
  for (const ts of list(dir, '.json')) {
    try {
      renameSync(join(dir, `${ts}.json`), join(dir, `${ts}.taken`))
      taken.push(JSON.parse(readFileSync(join(dir, `${ts}.taken`), 'utf8')))
    } catch {
      // Gone or unreadable. Not taken means the Worker runs it as the next turn.
    }
  }
  return taken
}

/** The ts of every follow-up Claude has been handed this turn. */
export function takenTs(dir) {
  return list(dir, '.taken')
}

/** How the follow-ups read to Claude. */
export function frameMessages(messages) {
  return [
    messages.length > 1 ? 'New messages in the Slack thread, sent while you were working:' : 'A new message in the Slack thread, sent while you were working:',
    ...messages.map((m) => `<@${m.user}>: ${m.text}`),
    '',
    'Say in one short line that you saw it, take it into account, and cover it in your final reply. There is no second reply.',
  ].join('\n')
}

/** What the hook prints: Claude Code adds `additionalContext` to what Claude sees after the tool. */
export function hookOutput(messages) {
  if (!messages.length) return ''
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: frameMessages(messages) } })
}

/** The Claude Code settings that run the hook after every tool call. */
export function hookSettings(command) {
  return { hooks: { PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command }] }] } }
}

function list(dir, suffix) {
  let names = []
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  return names
    .filter((n) => n.endsWith(suffix) && TS.test(n.slice(0, -suffix.length)))
    .map((n) => n.slice(0, -suffix.length))
    .sort((a, b) => Number(a) - Number(b))
}

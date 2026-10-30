// Claude Code runs this after every tool call (a PostToolUse hook set by run-turn.mjs). It hands
// Claude any follow-up that arrived in the Slack thread meanwhile. See inbox.mjs.
//
// It must never fail a tool call: any error means "nothing new", and the follow-up then runs as the
// next turn.

import { hookOutput, takeAll } from './inbox.mjs'

try {
  const dir = process.env.AGENT_INBOX
  const out = dir ? hookOutput(takeAll(dir)) : ''
  if (out) process.stdout.write(out)
} catch {
  // nothing new
}
process.exit(0)

import AGENT_INSTRUCTIONS from '../box/CLAUDE.md'
import FILES from '../box/files.mjs'
import INBOX_HOOK from '../box/inbox-hook.mjs'
import INBOX from '../box/inbox.mjs'
import MEMORY from '../box/memory.mjs'
import PROGRESS from '../box/progress.mjs'
import RUNNER from '../box/run-turn.mjs'
import TOOLS from '../box/tools.mjs'

/**
 * The files a turn runs from, as text, so a machine of your own can write them itself (②).
 *
 * They are the same bytes a turn runs from: one copy in the repo, shipped by the
 * Worker, so a redeploy reaches your machine without you pulling anything. The version is a hash of
 * all of them, computed once when the isolate starts (never per request): the daemon caches by it,
 * so a turn re-downloads the runner only when the runner actually changed.
 */
export const BOX_FILES: Record<string, string> = {
  'CLAUDE.md': AGENT_INSTRUCTIONS,
  'run-turn.mjs': RUNNER,
  'progress.mjs': PROGRESS,
  'inbox.mjs': INBOX,
  'inbox-hook.mjs': INBOX_HOOK,
  'files.mjs': FILES,
  'tools.mjs': TOOLS,
  'memory.mjs': MEMORY,
}

/** FNV-1a over the whole bundle. Not a security hash: it only has to change when the files do. */
function fnv1a(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

export const BOX_VERSION = fnv1a(Object.keys(BOX_FILES).sort().map((n) => `${n}:${BOX_FILES[n]}`).join('\u0000'))
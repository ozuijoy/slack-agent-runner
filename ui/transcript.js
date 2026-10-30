// Reads a Claude Code transcript (the JSONL a turn backs up to R2) into the entries the transcript
// page shows: every prompt, Claude's text and thinking, each tool call and its result. Plain
// functions, so test/ui-transcript.test.ts can check them; app.js renders the entries as text.
//
// Each backup is the WHOLE session up to that turn (box/run-turn.mjs), so the newest one holds
// every turn of the thread.

/** Entries from one transcript's text. Lines that are not JSON, or not a message, are skipped. */
export function transcriptEntries(jsonl) {
  const out = []
  for (const line of String(jsonl).split('\n')) {
    if (!line.trim()) continue
    let row
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    out.push(...rowEntries(row))
  }
  return out
}

/** Entries from one transcript row. */
export function rowEntries(row) {
  const at = typeof row?.timestamp === 'string' ? row.timestamp : null
  const content = row?.message?.content
  const out = []
  const add = (entry) => out.push(at ? { ...entry, at } : entry)
  if (row?.type === 'user') {
    // Claude Code's own notes ride as user rows marked isMeta; they are not what anyone typed.
    if (row.isMeta) return out
    if (typeof content === 'string') {
      if (content.trim()) add({ kind: 'prompt', text: content })
      return out
    }
    for (const block of Array.isArray(content) ? content : []) {
      if (block?.type === 'text' && block.text?.trim()) add({ kind: 'prompt', text: block.text })
      else if (block?.type === 'tool_result') add({ kind: block.is_error ? 'error' : 'result', text: resultText(block.content) })
    }
  } else if (row?.type === 'assistant') {
    for (const block of Array.isArray(content) ? content : []) {
      if (block?.type === 'text' && block.text?.trim()) add({ kind: 'text', text: block.text })
      else if (block?.type === 'thinking' && block.thinking?.trim()) add({ kind: 'thinking', text: block.thinking })
      else if (block?.type === 'tool_use') add({ kind: 'tool', name: String(block.name ?? 'tool'), text: JSON.stringify(block.input ?? {}, null, 2) })
    }
  }
  return out
}

function resultText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((c) => (c?.type === 'text' ? c.text : `[${c?.type ?? 'part'}]`)).join('\n')
}

/** What the page labels each kind. */
export const LABELS = { prompt: 'Message', text: 'Claude', thinking: 'Thinking', tool: 'Tool', result: 'Result', error: 'Error' }

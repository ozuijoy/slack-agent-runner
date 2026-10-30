// Reads and writes the answers file (.env.setup) for scripts/setup.mjs.
//
// Setup writes into it in one case: the GitHub webhook secret it generates. GitHub needs the same
// string in the App's Webhook settings, and setup never prints a secret, so the git-ignored file is
// where the human copies it from. Every other line is left exactly as the human wrote it.

/** KEY=value lines. Values may be quoted. Empty values count as missing. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (!m) continue
    const value = m[2].replace(/^(['"])(.*)\1$/, '$2').trim()
    if (value) out[m[1]] = value
  }
  return out
}

/** The file with NAME set to value: the first NAME= line is replaced, else a line is added at the end. */
export function setEnvLine(text: string, name: string, value: string): string {
  if (!/^[A-Z0-9_]+$/.test(name) || /[\r\n]/.test(value)) throw new Error('bad env line')
  const lines = text.split('\n')
  const i = lines.findIndex((l) => new RegExp(`^\\s*${name}\\s*=`).test(l))
  if (i !== -1) {
    lines[i] = `${name}=${value}`
    return lines.join('\n')
  }
  const body = text === '' || text.endsWith('\n') ? text : `${text}\n`
  return `${body}${name}=${value}\n`
}

/**
 * What setup does about GITHUB_WEBHOOK_SECRET. The human's own string wins ('use'). Else one the
 * Worker already holds is kept ('keep'): a new one would break the webhook GitHub already signs
 * with. Else setup makes one ('generate'). `have` is the Worker's secret list; null (unreadable)
 * throws, so a failed read never replaces a working secret.
 */
export function webhookSecretPlan(answer: string | undefined, have: Set<string> | null): 'use' | 'keep' | 'generate' {
  if (answer) return 'use'
  if (have === null) throw new Error('could not read the Worker\'s secret list')
  return have.has('GITHUB_WEBHOOK_SECRET') ? 'keep' : 'generate'
}

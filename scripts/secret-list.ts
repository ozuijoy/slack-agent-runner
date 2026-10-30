// Reads the output of `wrangler secret list --format json` for scripts/setup.mjs.
//
// Fails closed: anything other than a clean, parsed list returns null, never an empty set. Setup
// generates CHANNEL_SECRETS_KEY and CALLBACK_SECRET only when the list says they are missing, so an
// empty set read from a failed command (expired login, network error, a warning in the output)
// would overwrite the real key and make every stored channel secret unreadable for good.

/** The secret names, or null when the command failed or its output is not a list of secrets. */
export function parseSecretList(ok: boolean, stdout: string): Set<string> | null {
  if (!ok) return null
  // wrangler may print a banner before the JSON; try each '[' until one parses as the whole rest.
  for (let i = stdout.indexOf('['); i !== -1; i = stdout.indexOf('[', i + 1)) {
    let parsed: unknown
    try {
      parsed = JSON.parse(stdout.slice(i))
    } catch {
      continue
    }
    if (!Array.isArray(parsed)) return null
    if (!parsed.every((s) => typeof s === 'object' && s !== null && typeof (s as { name?: unknown }).name === 'string')) return null
    return new Set(parsed.map((s) => (s as { name: string }).name))
  }
  return null
}

/** Which generated-once secrets to create. Throws when the list could not be read. */
export function generatedSecretsToCreate(have: Set<string> | null, names: readonly string[]): string[] {
  if (have === null) {
    throw new Error('could not read the Worker\'s secret list, so setup cannot tell whether generated secrets already exist')
  }
  return names.filter((n) => !have.has(n))
}

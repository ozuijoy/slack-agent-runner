/**
 * The Claude models a thread can pick with `!model <alias>`. This is the ONE place the aliases and
 * the model ids live; change a model here and every thread picks it up on its next turn.
 */
export const MODELS = {
  opus: 'claude-opus-5-5',
  sonnet: 'claude-sonnet-5-5',
  haiku: 'claude-haiku-5-5',
} as const

export type ModelAlias = keyof typeof MODELS

export const DEFAULT_MODEL: ModelAlias = 'opus'

export function isModelAlias(value: unknown): value is ModelAlias {
  return typeof value === 'string' && Object.hasOwn(MODELS, value)
}

/** The model id to pass to `claude --model`. Anything unknown falls back to the default. */
export function modelId(alias: string | null | undefined): string {
  return MODELS[isModelAlias(alias) ? alias : DEFAULT_MODEL]
}

/** The thread's own pick wins, then the channel's default, then opus. */
export function resolveModel(threadModel?: string | null, channelDefault?: string | null): ModelAlias {
  if (isModelAlias(threadModel)) return threadModel
  if (isModelAlias(channelDefault)) return channelDefault
  return DEFAULT_MODEL
}

export type ModelCommand = { kind: 'show' } | { kind: 'set'; alias: ModelAlias } | { kind: 'unknown'; given: string }

/**
 * `!model` shows the thread's model, `!model sonnet` sets it. Returns null when the message is not
 * a model command, so it runs as a normal turn. The whole message must be the command: a message
 * that only starts with it ("!model sonnet and fix the bug") is not one, so nothing is half-run.
 */
export function parseModelCommand(text: string): ModelCommand | null {
  const m = text.trim().match(/^!model(?:\s+(\S+))?$/i)
  if (!m) return null
  if (!m[1]) return { kind: 'show' }
  const given = m[1].toLowerCase()
  return isModelAlias(given) ? { kind: 'set', alias: given } : { kind: 'unknown', given: m[1] }
}

export function describeModel(alias: ModelAlias) {
  return `\`${alias}\` (${MODELS[alias]})`
}

export function modelChoices() {
  return Object.keys(MODELS).map((a) => `\`${a}\``).join(', ')
}

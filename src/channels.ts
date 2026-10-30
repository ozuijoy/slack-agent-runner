/**
 * The rules for per-channel settings. The I/O is in src/channel-store.ts (D1); the Channels page
 * of the web UI is the only thing that changes them. Nothing in Slack can.
 *
 * A channel has three settings:
 *
 * 1. WATCHED. In a watched channel the bot answers every new root message, no @mention needed.
 *    Replies in a thread it already answers reach it anyway (src/thread.ts rule 3). DMs need no
 *    watching: every DM is for the bot.
 * 2. A DEFAULT MODEL. A thread's own `!model` pick wins, then the channel's default, then opus
 *    (src/models.ts resolveModel).
 * 3. SECRETS. Named values, such as an API key for a service the channel's work needs. They reach
 *    Claude as environment variables in that channel's sandboxes ONLY, and no other channel's.
 *
 * THE SECRETS BOUNDARY. Values are stored encrypted (AES-GCM) in D1, with a key held as the Worker
 * secret CHANNEL_SECRETS_KEY, so a copy of the database alone reveals nothing. Each value is bound
 * to its channel and name (the AES-GCM additional data), so a row copied to another channel or
 * renamed fails to decrypt instead of leaking into the wrong sandbox. A value is never read back
 * out to a page or a log: the UI sees names only.
 *
 * Treat them as readable by anyone who can talk to the bot in that channel: Claude runs on text
 * anyone there can write, and it can print its environment.
 */

import type { ModelAlias } from './models.ts'
import { isModelAlias } from './models.ts'

export interface ChannelSettings {
  channel: string
  watched: boolean
  /** The channel's default model, or null for opus. */
  model: ModelAlias | null
}

/** One row of `channel_settings` (migrations/0002_channels.sql). */
export interface ChannelSettingsRow {
  channel: string
  watched: number
  default_model: string | null
}

export function defaultSettings(channel: string): ChannelSettings {
  return { channel, watched: false, model: null }
}

/** A row as settings. A model alias that no longer exists (src/models.ts changed) reads as unset. */
export function settingsFromRow(channel: string, row: ChannelSettingsRow | null): ChannelSettings {
  if (!row) return defaultSettings(channel)
  return { channel, watched: row.watched === 1, model: isModelAlias(row.default_model) ? row.default_model : null }
}

/**
 * Slack conversation ids: C (public), G (private, older), D (DM). Upper-case letters and digits.
 * Checked on every write, so the UI cannot make a row no event will ever match.
 */
export function isChannelId(channel: unknown): channel is string {
  return typeof channel === 'string' && /^[CGD][A-Z0-9]{2,30}$/.test(channel)
}

/**
 * Does this event start a thread with no @mention? Only a ROOT message (no thread_ts), only in a
 * channel (a DM is always for the bot already), and only when the channel is watched.
 */
export function startsWatchedThread(event: { threadTs?: string; isDm: boolean }, settings: Pick<ChannelSettings, 'watched'>): boolean {
  return settings.watched && !event.isDm && !event.threadTs
}

// ---------------------------------------------------------------------------------------------
// Secrets: names and values.

export const MAX_SECRETS_PER_CHANNEL = 50
/** Far above an API key or a token; env vars are not the place for a file. */
export const MAX_SECRET_BYTES = 8_000

/**
 * Names the sandbox already uses, or that change how a program runs. A channel secret with one of
 * these names could take over the runner's own doors or Claude's sign-in, or load code into every
 * process. The runner also sets its own envs AFTER the channel's (src/sandbox.ts), so this list is
 * the second guard, not the only one.
 */
const RESERVED_NAMES = new Set([
  'PATH', 'HOME', 'USER', 'SHELL', 'PWD', 'TMPDIR', 'LANG', 'TERM', 'HISTFILE',
  'GH_TOKEN', 'GITHUB_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN',
  'SESSION_ID', 'PROMPT_FILE', 'FILES_MANIFEST', 'FILE_URL', 'MEMORY_URL', 'MEMORY_DIR', 'MEMORY_BASE_FILE',
  'PROGRESS_URL', 'TRANSCRIPT_URL', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'BASH_ENV', 'ENV',
  'PYTHONPATH', 'PYTHONSTARTUP', 'PERL5OPT', 'RUBYOPT',
])
const RESERVED_PREFIXES = ['CLAUDE_', 'ANTHROPIC_', 'AGENT_', 'CALLBACK_', 'TURN_', 'SLACK_', 'NODE_', 'NPM_CONFIG_', 'LD_', 'DYLD_', 'GIT_']

export type Checked<T> = { ok: true; value: T } | { ok: false; error: string }

/** A secret's name: an env var name, upper case, and not one the sandbox needs for itself. */
export function checkSecretName(name: unknown): Checked<string> {
  if (typeof name !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(name)) {
    return { ok: false, error: 'A name is 1 to 64 characters: capital letters, digits and _, starting with a letter.' }
  }
  if (RESERVED_NAMES.has(name) || RESERVED_PREFIXES.some((p) => name.startsWith(p))) {
    return { ok: false, error: `${name} is used by the sandbox itself. Pick another name.` }
  }
  return { ok: true, value: name }
}

/** A secret's value: text, not empty, not huge, and no NUL (an env var cannot carry one). */
export function checkSecretValue(value: unknown): Checked<string> {
  if (typeof value !== 'string' || !value.length) return { ok: false, error: 'The value is empty.' }
  if (value.includes('\0')) return { ok: false, error: 'The value cannot contain a NUL character.' }
  if (new TextEncoder().encode(value).length > MAX_SECRET_BYTES) return { ok: false, error: `The value is over ${MAX_SECRET_BYTES} bytes.` }
  return { ok: true, value }
}

// ---------------------------------------------------------------------------------------------
// Encryption.

/** What D1 stores for one secret: both base64. */
export interface SealedSecret {
  iv: string
  ciphertext: string
}

/**
 * The AES-256 key from CHANNEL_SECRETS_KEY: 64 hex characters (32 random bytes). `npm run setup`
 * makes one. Changing it later makes every stored secret unreadable, so it is made once and kept.
 */
export async function secretsKey(raw: string | undefined): Promise<CryptoKey> {
  const hex = (raw ?? '').trim()
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(
      raw ? 'CHANNEL_SECRETS_KEY must be 64 hex characters (32 bytes).' : 'CHANNEL_SECRETS_KEY is not set. Run `npm run setup`, which makes one.',
    )
  }
  const bytes = Uint8Array.from(hex.match(/../g)!, (h) => parseInt(h, 16))
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

/** Ties a value to its channel and name: a row moved to another channel or name will not open. */
function boundTo(channel: string, name: string) {
  return new TextEncoder().encode(`channel-secret\0${channel}\0${name}`)
}

export async function sealSecret(key: CryptoKey, channel: string, name: string, value: string): Promise<SealedSecret> {
  // A fresh random 96-bit IV per write. Reusing an IV with one key breaks AES-GCM.
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: boundTo(channel, name) }, key, new TextEncoder().encode(value))
  return { iv: toB64(iv), ciphertext: toB64(new Uint8Array(ciphertext)) }
}

/** Throws if the key is wrong, or the row was changed, moved to another channel, or renamed. */
export async function openSecret(key: CryptoKey, channel: string, name: string, sealed: SealedSecret): Promise<string> {
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromB64(sealed.iv), additionalData: boundTo(channel, name) },
    key,
    fromB64(sealed.ciphertext),
  )
  return new TextDecoder().decode(plain)
}

/**
 * What one turn's sandbox gets from its channel: the env vars, and a line for the prompt naming
 * them (never their values) or saying why some could not be opened. A secret that fails to open is
 * left out, and the turn goes on without it.
 */
export function secretsForTurn(opened: Array<{ name: string; value: string | null }>): { envs: Record<string, string>; note: string } {
  const envs: Record<string, string> = {}
  const failed: string[] = []
  for (const { name, value } of opened) {
    // Checked again here: a row written before a name became reserved must not reach the sandbox.
    if (!checkSecretName(name).ok) continue
    if (value === null) failed.push(name)
    else envs[name] = value
  }
  const names = Object.keys(envs).sort()
  const notes: string[] = []
  if (names.length) notes.push(`This channel gives you these environment variables: ${names.join(', ')}. Never print their values.`)
  if (failed.length) notes.push(`These channel secrets could not be opened, so they are not set: ${failed.sort().join(', ')}.`)
  return { envs, note: notes.join('\n') }
}

function toB64(bytes: Uint8Array) {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

function fromB64(text: string) {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0))
}

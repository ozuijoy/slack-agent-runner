import {
  checkSecretName,
  checkSecretValue,
  isChannelId,
  MAX_SECRETS_PER_CHANNEL,
  openSecret,
  sealSecret,
  secretsForTurn,
  secretsKey,
  settingsFromRow,
  type ChannelSettings,
  type ChannelSettingsRow,
  type Checked,
} from './channels.ts'
import { dbAll, dbFirst, dbRun } from './db.ts'
import type { Env } from './env.ts'
import { isModelAlias, type ModelAlias } from './models.ts'

/**
 * Channel settings in D1 (the rules: src/channels.ts). Reads are for the events route and the turn
 * launch; writes are for the web UI's Channels page, which passes who is signed in as `by`.
 */
type DbEnv = Pick<Env, 'DB'>

/** A channel's settings, or the defaults when it has no row. */
export async function channelSettings(env: DbEnv, channel: string): Promise<ChannelSettings> {
  const row = await dbFirst<ChannelSettingsRow>(env, 'SELECT channel, watched, default_model FROM channel_settings WHERE channel = ?', channel)
  return settingsFromRow(channel, row)
}

export interface ChannelListing extends ChannelSettings {
  /** Names only. A value never leaves the database in the clear. */
  secrets: string[]
}

/** Every channel with a setting or a secret, for the Channels page. */
export async function listChannels(env: DbEnv): Promise<ChannelListing[]> {
  const rows = await dbAll<ChannelSettingsRow>(env, 'SELECT channel, watched, default_model FROM channel_settings')
  const names = await dbAll<{ channel: string; name: string }>(env, 'SELECT channel, name FROM channel_secrets ORDER BY name')
  const byChannel = new Map<string, ChannelListing>()
  for (const row of rows) byChannel.set(row.channel, { ...settingsFromRow(row.channel, row), secrets: [] })
  for (const { channel, name } of names) {
    if (!byChannel.has(channel)) byChannel.set(channel, { ...settingsFromRow(channel, null), secrets: [] })
    byChannel.get(channel)!.secrets.push(name)
  }
  return [...byChannel.values()].sort((a, b) => a.channel.localeCompare(b.channel))
}

/** Turns watching on or off. Keeps the channel's default model. */
export async function setWatched(env: DbEnv, channel: string, watched: boolean, by: string | null = null): Promise<Checked<ChannelSettings>> {
  if (!isChannelId(channel)) return { ok: false, error: 'That is not a Slack channel id.' }
  await dbRun(
    env,
    `INSERT INTO channel_settings (channel, watched, updated_at, updated_by) VALUES (?, ?, ?, ?)
     ON CONFLICT (channel) DO UPDATE SET watched = excluded.watched, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    channel,
    watched ? 1 : 0,
    Date.now(),
    by,
  )
  return { ok: true, value: await channelSettings(env, channel) }
}

/** Sets the channel's default model, or clears it with null. Keeps the watched setting. */
export async function setChannelModel(env: DbEnv, channel: string, model: string | null, by: string | null = null): Promise<Checked<ChannelSettings>> {
  if (!isChannelId(channel)) return { ok: false, error: 'That is not a Slack channel id.' }
  if (model !== null && !isModelAlias(model)) return { ok: false, error: `Unknown model "${model}".` }
  await dbRun(
    env,
    `INSERT INTO channel_settings (channel, default_model, updated_at, updated_by) VALUES (?, ?, ?, ?)
     ON CONFLICT (channel) DO UPDATE SET default_model = excluded.default_model, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    channel,
    model as ModelAlias | null,
    Date.now(),
    by,
  )
  return { ok: true, value: await channelSettings(env, channel) }
}

/** Adds or replaces one secret. Encrypted here, before it reaches the database. */
export async function putChannelSecret(
  env: DbEnv & Pick<Env, 'CHANNEL_SECRETS_KEY'>,
  channel: string,
  name: unknown,
  value: unknown,
  by: string | null = null,
): Promise<Checked<string>> {
  if (!isChannelId(channel)) return { ok: false, error: 'That is not a Slack channel id.' }
  const checkedName = checkSecretName(name)
  if (!checkedName.ok) return checkedName
  const checkedValue = checkSecretValue(value)
  if (!checkedValue.ok) return checkedValue

  const others = await dbFirst<{ n: number }>(env, 'SELECT COUNT(*) AS n FROM channel_secrets WHERE channel = ? AND name != ?', channel, checkedName.value)
  if ((others?.n ?? 0) >= MAX_SECRETS_PER_CHANNEL) return { ok: false, error: `A channel can hold ${MAX_SECRETS_PER_CHANNEL} secrets.` }

  const key = await secretsKey(env.CHANNEL_SECRETS_KEY)
  const sealed = await sealSecret(key, channel, checkedName.value, checkedValue.value)
  await dbRun(
    env,
    `INSERT INTO channel_secrets (channel, name, iv, ciphertext, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (channel, name) DO UPDATE SET iv = excluded.iv, ciphertext = excluded.ciphertext, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    channel,
    checkedName.value,
    sealed.iv,
    sealed.ciphertext,
    Date.now(),
    by,
  )
  return { ok: true, value: checkedName.value }
}

export async function deleteChannelSecret(env: DbEnv, channel: string, name: string): Promise<void> {
  await dbRun(env, 'DELETE FROM channel_secrets WHERE channel = ? AND name = ?', channel, name)
}

/**
 * The secrets for one turn in `channel`, opened, with the prompt line naming them. The channel comes
 * from the turn's own job, so a sandbox only ever gets its own channel's secrets. A missing or wrong
 * key costs the turn its secrets (the note says so), never its answer.
 */
export async function channelSecretsForTurn(env: DbEnv & Pick<Env, 'CHANNEL_SECRETS_KEY'>, channel: string) {
  const rows = await dbAll<{ name: string; iv: string; ciphertext: string }>(
    env,
    'SELECT name, iv, ciphertext FROM channel_secrets WHERE channel = ?',
    channel,
  )
  if (!rows.length) return { envs: {}, note: '' }
  let key: CryptoKey
  try {
    key = await secretsKey(env.CHANNEL_SECRETS_KEY)
  } catch (err) {
    console.error(`channel ${channel}: cannot open its secrets:`, (err as Error).message)
    return secretsForTurn(rows.map(({ name }) => ({ name, value: null })))
  }
  const opened = await Promise.all(
    rows.map(async ({ name, iv, ciphertext }) => {
      try {
        return { name, value: await openSecret(key, channel, name, { iv, ciphertext }) }
      } catch {
        console.error(`channel ${channel}: secret ${name} did not decrypt (wrong key, or the row was changed)`)
        return { name, value: null }
      }
    }),
  )
  return secretsForTurn(opened)
}

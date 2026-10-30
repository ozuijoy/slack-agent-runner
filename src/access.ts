/**
 * Cloudflare Access for the web UI (/ui and its API). Access sits in front of /ui and signs the
 * reader in; on every request it lets through, it adds a signed JWT in the `Cf-Access-Jwt-Assertion`
 * header. The Worker checks that JWT itself as well, so a request that reaches the Worker some other
 * way (no Access application, a typo in its path, the workers.dev host left open) gets nothing.
 *
 * The rules:
 *
 * 1. NOT SET UP MEANS CLOSED. With ACCESS_TEAM_DOMAIN or ACCESS_AUD empty, every UI request is
 *    refused. There is no password or "dev mode" fallback.
 * 2. THE JWT MUST BE OURS. RS256 only, signed by a key from the team's own key list
 *    (https://<team>.cloudflareaccess.com/cdn-cgi/access/certs), issued by that team, for this
 *    application's AUD tag, and inside its time window.
 * 3. WHO IT IS COMES FROM THE JWT. The page shows the email, and changes record it as `updated_by`.
 *
 * The checks are plain functions (tested without the network); `accessKeys` is the one fetch.
 */

export interface AccessConfig {
  /** `https://<team>.cloudflareaccess.com`, from normaliseTeamDomain. */
  issuer: string
  aud: string
}

export interface AccessIdentity {
  /** The signed-in person's email, or a service token's name. */
  email: string
}

export type AccessResult = { ok: true; identity: AccessIdentity } | { ok: false; status: number; error: string }

/** A clock skew allowance for `exp` and `nbf`. */
const LEEWAY_SECONDS = 60

/**
 * `myteam`, `myteam.cloudflareaccess.com` or `https://myteam.cloudflareaccess.com/` all mean the
 * same team. Anything else (another host, a path) is refused, so a typo cannot point the key fetch
 * somewhere else.
 */
export function normaliseTeamDomain(raw: string | undefined): string | null {
  let host = (raw ?? '').trim().toLowerCase().replace(/^https:\/\//, '').replace(/\/+$/, '')
  if (!host) return null
  if (!host.includes('.')) host = `${host}.cloudflareaccess.com`
  if (!/^[a-z0-9-]{1,63}\.cloudflareaccess\.com$/.test(host)) return null
  return `https://${host}`
}

/** Rule 1: both vars set and well formed, or null. */
export function accessConfig(env: { ACCESS_TEAM_DOMAIN?: string; ACCESS_AUD?: string }): AccessConfig | null {
  const issuer = normaliseTeamDomain(env.ACCESS_TEAM_DOMAIN)
  const aud = (env.ACCESS_AUD ?? '').trim()
  if (!issuer || !/^[A-Za-z0-9]{16,128}$/.test(aud)) return null
  return { issuer, aud }
}

export interface AccessJwk extends JsonWebKey {
  kid?: string
}

/**
 * Rule 2. `keys` returns the team's keys; it is called again with `refresh: true` once when the
 * JWT names a key it does not have (Access rotates them).
 */
export async function verifyAccessJwt(
  token: string | null | undefined,
  config: AccessConfig,
  keys: (refresh: boolean) => Promise<AccessJwk[]>,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<AccessResult> {
  const refuse = (error: string): AccessResult => ({ ok: false, status: 403, error })
  if (!token) return refuse('no Access token: open this page through Cloudflare Access')
  const parts = token.split('.')
  if (parts.length !== 3) return refuse('malformed Access token')

  const header = decodeJson(parts[0]) as { alg?: unknown; kid?: unknown } | null
  const claims = decodeJson(parts[1]) as Record<string, unknown> | null
  if (!header || !claims) return refuse('malformed Access token')
  if (header.alg !== 'RS256') return refuse('Access token is not RS256')
  if (typeof header.kid !== 'string') return refuse('Access token names no key')

  let jwk = (await keys(false)).find((k) => k.kid === header.kid)
  if (!jwk) jwk = (await keys(true)).find((k) => k.kid === header.kid)
  if (!jwk) return refuse('Access token is signed by an unknown key')

  let valid = false
  try {
    const key = await crypto.subtle.importKey('jwk', { kty: jwk.kty, n: jwk.n, e: jwk.e }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'])
    valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, fromB64Url(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`))
  } catch {
    valid = false
  }
  if (!valid) return refuse('Access token signature does not match')

  const claimError = checkClaims(claims, config, nowSeconds)
  if (claimError) return refuse(claimError)
  const email = typeof claims.email === 'string' && claims.email ? claims.email : typeof claims.common_name === 'string' ? claims.common_name : ''
  return { ok: true, identity: { email: email || 'unknown' } }
}

/** The issuer, audience and time window. Null when they are fine, else what is wrong. */
export function checkClaims(claims: Record<string, unknown>, config: AccessConfig, nowSeconds: number): string | null {
  if (claims.iss !== config.issuer) return 'Access token is from another team'
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
  if (!aud.includes(config.aud)) return 'Access token is for another application'
  if (typeof claims.exp !== 'number' || claims.exp + LEEWAY_SECONDS < nowSeconds) return 'Access token has expired'
  if (typeof claims.nbf === 'number' && claims.nbf - LEEWAY_SECONDS > nowSeconds) return 'Access token is not valid yet'
  return null
}

// ---------------------------------------------------------------------------------------------
// The key list, cached per isolate.

const KEY_TTL_MS = 10 * 60_000
/** A forced refresh at most this often, so a stream of bad tokens cannot hammer the key list. */
const MIN_REFRESH_MS = 60_000
const cache = new Map<string, { at: number; keys: AccessJwk[] }>()

/** The team's signing keys, from cache when fresh. */
export async function accessKeys(issuer: string, refresh: boolean, now = Date.now()): Promise<AccessJwk[]> {
  const hit = cache.get(issuer)
  if (hit && now - hit.at < (refresh ? MIN_REFRESH_MS : KEY_TTL_MS)) return hit.keys
  const res = await fetch(`${issuer}/cdn-cgi/access/certs`)
  if (!res.ok) throw new Error(`Access key list answered ${res.status}`)
  const json = (await res.json()) as { keys?: AccessJwk[] }
  const keys = Array.isArray(json.keys) ? json.keys.filter((k) => k.kty === 'RSA') : []
  cache.set(issuer, { at: now, keys })
  return keys
}

/** The whole check for one request: rules 1 to 3. */
export async function accessIdentity(request: Request, env: { ACCESS_TEAM_DOMAIN?: string; ACCESS_AUD?: string }): Promise<AccessResult> {
  const config = accessConfig(env)
  if (!config) return { ok: false, status: 503, error: 'The web UI is not set up: set ACCESS_TEAM_DOMAIN and ACCESS_AUD (README, "Web UI").' }
  try {
    return await verifyAccessJwt(request.headers.get('cf-access-jwt-assertion'), config, (refresh) => accessKeys(config.issuer, refresh))
  } catch (err) {
    console.error('could not check the Access token:', (err as Error).message)
    return { ok: false, status: 502, error: 'could not reach Cloudflare Access to check the sign-in' }
  }
}

function decodeJson(part: string): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(fromB64Url(part)))
  } catch {
    return null
  }
}

function fromB64Url(text: string): Uint8Array {
  const b64 = text.replaceAll('-', '+').replaceAll('_', '/')
  return Uint8Array.from(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0))
}

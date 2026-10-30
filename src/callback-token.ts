/**
 * The token a sandbox uses to post its reply back to the Worker.
 *
 * The sandbox runs Claude on text anyone in the workspace can write, so treat everything in it as
 * readable by an attacker. That is why the Slack bot token never goes in: a leaked bot token posts
 * anywhere and reads everything. This token can do one thing: deliver the answer for ONE turn in
 * ONE thread, until it expires.
 *
 * Format: base64url(JSON claims) + "." + base64url(HMAC-SHA256(claims)).
 */
export interface CallbackClaims {
  channel: string
  threadTs: string
  turnId: string
  /** The newest message in the turn, whose status reaction the reply swaps. */
  lastTs: string
  /** Expiry, in ms since the epoch. */
  exp: number
}

/**
 * What a token is for. Each purpose signs with its own key, so a token minted for one door can
 * never open another.
 *
 *   reply  The runner's token: the answer, the progress reports and the transcript backup. It is
 *          kept out of Claude's env (box/run-turn.mjs strips it), so Claude does not stumble on it.
 *          That is a guard against accidents, not a wall: Claude runs as the runner's user with
 *          sudo (template/Dockerfile), so a determined prompt injection can read it from the
 *          runner's process. What holds anyway: it opens only this one thread's doors, until it
 *          expires, and a stored transcript is never replaced.
 *   tools  Claude's token, for the doors it calls itself (box/tools.mjs): post a file or a canvas
 *          into this thread. Same claims, same expiry, and only ever this one thread.
 *   file   A grant to download ONE Slack file this thread was sent (src/files.ts).
 */
export type TokenPurpose = 'reply' | 'tools' | 'file'

export async function signCallbackToken(secret: string, claims: CallbackClaims, purpose: TokenPurpose = 'reply'): Promise<string> {
  return signClaims(secret, purpose, claims)
}

/** Signs any claims object for one purpose. */
export async function signClaims(secret: string, purpose: TokenPurpose, claims: object): Promise<string> {
  const body = b64url(new TextEncoder().encode(JSON.stringify(claims)))
  const sig = await hmac(keyFor(secret, purpose), body)
  return `${body}.${b64url(sig)}`
}

/** The claims of a token signed for `purpose` that has not expired, or the reason it is refused. */
export async function readClaims<T extends { exp: number }>(
  secret: string,
  purpose: TokenPurpose,
  token: string | null | undefined,
  now = Date.now(),
): Promise<{ ok: true; claims: T } | { ok: false; reason: string }> {
  if (!token) return { ok: false, reason: 'missing token' }
  const [body, sig] = token.split('.')
  if (!body || !sig) return { ok: false, reason: 'malformed token' }

  const expected = await hmac(keyFor(secret, purpose), body)
  if (!timingSafeEqual(expected, fromB64url(sig))) return { ok: false, reason: 'bad signature' }

  let claims: T
  try {
    claims = JSON.parse(new TextDecoder().decode(fromB64url(body)))
  } catch {
    return { ok: false, reason: 'malformed token' }
  }
  if (typeof claims?.exp !== 'number' || claims.exp <= now) return { ok: false, reason: 'expired' }
  return { ok: true, claims }
}

/** The reply token keeps the bare secret, so tokens minted before purposes existed still verify. */
function keyFor(secret: string, purpose: TokenPurpose) {
  return purpose === 'reply' ? secret : `${purpose}:${secret}`
}

export type VerifyResult = { ok: true; claims: CallbackClaims } | { ok: false; reason: string }

/** Checks the signature, the expiry, and that the token names the turn the caller says it is for. */
export async function verifyCallbackToken(
  secret: string,
  token: string | null | undefined,
  turnId: string,
  now = Date.now(),
  purpose: TokenPurpose = 'reply',
): Promise<VerifyResult> {
  const read = await readClaims<CallbackClaims>(secret, purpose, token, now)
  if (!read.ok) return read
  if (read.claims.turnId !== turnId) return { ok: false, reason: 'token is for another turn' }
  return read
}

async function hmac(secret: string, data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data)))
}

export function timingSafeEqual(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

export function b64url(bytes: Uint8Array) {
  let s = ''
  for (const byte of bytes) s += String.fromCharCode(byte)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromB64url(s: string) {
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'))
    return Uint8Array.from(bin, (c) => c.charCodeAt(0))
  } catch {
    return new Uint8Array()
  }
}

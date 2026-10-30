// The web UI's sign-in check (src/access.ts): a Cloudflare Access JWT, checked by the Worker too.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { accessConfig, accessIdentity, checkClaims, normaliseTeamDomain, verifyAccessJwt, type AccessJwk } from '../src/access.ts'

const ISSUER = 'https://myteam.cloudflareaccess.com'
const AUD = 'a'.repeat(64)
const CONFIG = { issuer: ISSUER, aud: AUD }
const NOW = 1_800_000_000

function b64url(bytes: Uint8Array | string) {
  const raw = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes
  let s = ''
  for (const b of raw) s += String.fromCharCode(b)
  return btoa(s).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

async function keyPair(kid: string) {
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair
  const jwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as AccessJwk
  return { privateKey: pair.privateKey, jwk: { ...jwk, kid } }
}

async function sign(privateKey: CryptoKey, claims: Record<string, unknown>, header: Record<string, unknown> = { alg: 'RS256', kid: 'k1' }) {
  const head = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, new TextEncoder().encode(head)))
  return `${head}.${b64url(sig)}`
}

const good = { iss: ISSUER, aud: [AUD], exp: NOW + 600, nbf: NOW - 10, email: 'me@example.com' }

test('the team domain can be written three ways, and nothing else is accepted', () => {
  assert.equal(normaliseTeamDomain('myteam'), ISSUER)
  assert.equal(normaliseTeamDomain('myteam.cloudflareaccess.com'), ISSUER)
  assert.equal(normaliseTeamDomain('https://MyTeam.cloudflareaccess.com/'), ISSUER)
  assert.equal(normaliseTeamDomain('evil.example.com'), null)
  assert.equal(normaliseTeamDomain('myteam.cloudflareaccess.com/path'), null)
  assert.equal(normaliseTeamDomain(''), null)
})

test('rule 1: with the team domain or the AUD unset, the UI is closed to everyone', async () => {
  assert.equal(accessConfig({}), null)
  assert.equal(accessConfig({ ACCESS_TEAM_DOMAIN: 'myteam', ACCESS_AUD: '' }), null)
  assert.equal(accessConfig({ ACCESS_TEAM_DOMAIN: '', ACCESS_AUD: AUD }), null)
  assert.deepEqual(accessConfig({ ACCESS_TEAM_DOMAIN: 'myteam', ACCESS_AUD: AUD }), CONFIG)
  const result = await accessIdentity(new Request('https://w.example/ui/', { headers: { 'cf-access-jwt-assertion': 'x.y.z' } }), {})
  assert.equal(result.ok, false)
  assert.equal(!result.ok && result.status, 503)
})

test('rule 2: a JWT signed by the team, for this app, in its window, lets the person in', async () => {
  const { privateKey, jwk } = await keyPair('k1')
  const token = await sign(privateKey, good)
  const result = await verifyAccessJwt(token, CONFIG, async () => [jwk], NOW)
  assert.deepEqual(result, { ok: true, identity: { email: 'me@example.com' } })
  // A string aud is fine too.
  assert.equal((await verifyAccessJwt(await sign(privateKey, { ...good, aud: AUD }), CONFIG, async () => [jwk], NOW)).ok, true)
})

test('rule 2: a forged, foreign, stale or malformed JWT is refused', async () => {
  const { privateKey, jwk } = await keyPair('k1')
  const other = await keyPair('k1')
  const keys = async () => [jwk]
  const refused = async (token: string | null) => {
    const r = await verifyAccessJwt(token, CONFIG, keys, NOW)
    assert.equal(r.ok, false)
    return r.ok ? '' : r.error
  }
  assert.match(await refused(null), /no Access token/)
  assert.match(await refused('abc'), /malformed/)
  assert.match(await refused(await sign(other.privateKey, good)), /signature/)
  assert.match(await refused(await sign(privateKey, { ...good, iss: 'https://other.cloudflareaccess.com' })), /another team/)
  assert.match(await refused(await sign(privateKey, { ...good, aud: ['b'.repeat(64)] })), /another application/)
  assert.match(await refused(await sign(privateKey, { ...good, exp: NOW - 120 })), /expired/)
  assert.match(await refused(await sign(privateKey, { ...good, nbf: NOW + 600 })), /not valid yet/)
  assert.match(await refused(await sign(privateKey, good, { alg: 'HS256', kid: 'k1' })), /RS256/)
  assert.match(await refused(await sign(privateKey, good, { alg: 'none', kid: 'k1' })), /RS256/)
  assert.match(await refused(await sign(privateKey, good, { alg: 'RS256', kid: 'k9' })), /unknown key/)
  // The body swapped under a valid signature.
  const token = await sign(privateKey, good)
  const [h, , s] = token.split('.')
  assert.match(await refused(`${h}.${b64url(JSON.stringify({ ...good, email: 'boss@example.com' }))}.${s}`), /signature/)
})

test('a key the cache does not have is fetched once more, for a rotation', async () => {
  const { privateKey, jwk } = await keyPair('k2')
  const calls: boolean[] = []
  const keys = async (refresh: boolean) => {
    calls.push(refresh)
    return refresh ? [jwk] : []
  }
  const r = await verifyAccessJwt(await sign(privateKey, good, { alg: 'RS256', kid: 'k2' }), CONFIG, keys, NOW)
  assert.equal(r.ok, true)
  assert.deepEqual(calls, [false, true])
})

test('the claim checks allow a minute of clock skew and no more', () => {
  assert.equal(checkClaims({ ...good, exp: NOW - 30 }, CONFIG, NOW), null)
  assert.match(checkClaims({ ...good, exp: NOW - 61 }, CONFIG, NOW) ?? '', /expired/)
  assert.match(checkClaims({ ...good, exp: undefined }, CONFIG, NOW) ?? '', /expired/)
})

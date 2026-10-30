import { b64url } from './callback-token.ts'
import type { Env } from './env.ts'

/**
 * GitHub App tokens, for the sandbox and for the memory store.
 *
 * The token GitHub mints for an installation lasts 1 hour and reaches only the repos the student
 * picked when they installed the App. That is the whole reach of the bot on GitHub: no personal
 * token, nothing that outlives the turn by more than the hour.
 *
 * The App is REQUIRED: the bot's memory lives in a repo it reaches through the App (src/memory.ts).
 */

/** What is missing for GitHub and the memory repo, as sentences. Empty when all is set. */
export function githubMissing(env: Pick<Env, 'GITHUB_APP_ID' | 'GITHUB_APP_PRIVATE_KEY' | 'MEMORY_REPO'>): string[] {
  const missing: string[] = []
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) {
    missing.push('Set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY: the GitHub App is required (see "GitHub App" in the README).')
  }
  if (!parseRepo(env.MEMORY_REPO)) {
    missing.push('Set MEMORY_REPO in wrangler.jsonc to the memory repo as owner/name, and install the GitHub App on it.')
  }
  return missing
}

/** `owner/name`, or null when it is not one. */
export function parseRepo(value: string | undefined): { owner: string; name: string } | null {
  const m = String(value ?? '').trim().match(/^([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})$/)
  return m && m[2] !== '.' && m[2] !== '..' ? { owner: m[1], name: m[2] } : null
}

/** What opening a PR needs. A token can never hold more than the App was granted. */
export const PR_PERMISSIONS = { contents: 'write', pull_requests: 'write', metadata: 'read' } as const

/**
 * The turn's token: opening a PR, plus reading why CI failed on it. A CI-failed wake (src/pr-follow.ts
 * wakePrompt) runs `gh pr checks` (checks + commit statuses) and `gh run view --log-failed` (actions).
 * All three must also be granted on the App (README "GitHub App" step 3).
 */
export const TOKEN_PERMISSIONS = { ...PR_PERMISSIONS, checks: 'read', statuses: 'read', actions: 'read' } as const

/** The Worker's own token for the memory repo: that one repo, its files and nothing else. */
export const MEMORY_PERMISSIONS = { contents: 'write', metadata: 'read' } as const

export interface TokenScope {
  permissions?: Record<string, string>
  /** Repo names (no owner) the token may reach. Unset means every repo of the installation. */
  repositories?: string[]
  repositoryIds?: number[]
}

export function githubHeaders(token: string) {
  return {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'slack-agent-starter',
  }
}

export async function mintInstallationToken(env: Env, fetchImpl: typeof fetch = fetch, scope: TokenScope = {}): Promise<string> {
  const jwt = await appJwt(env.GITHUB_APP_ID!, env.GITHUB_APP_PRIVATE_KEY!)
  const headers = githubHeaders(jwt)

  let installationId = env.GITHUB_INSTALLATION_ID
  if (!installationId) {
    const res = await fetchImpl('https://api.github.com/app/installations', { headers })
    if (!res.ok) throw new Error(`github installations: ${res.status} ${await res.text()}`)
    const list = (await res.json()) as Array<{ id: number }>
    if (list.length !== 1) {
      throw new Error(
        list.length
          ? `The GitHub App has ${list.length} installations. Set GITHUB_INSTALLATION_ID to pick one.`
          : 'The GitHub App is not installed on any account yet. Install it on the repos you want the bot to use.',
      )
    }
    installationId = String(list[0].id)
  }

  const res = await fetchImpl(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      permissions: scope.permissions ?? TOKEN_PERMISSIONS,
      ...(scope.repositories ? { repositories: scope.repositories } : {}),
      ...(scope.repositoryIds ? { repository_ids: scope.repositoryIds } : {}),
    }),
  })
  if (!res.ok) throw new GithubTokenError(res.status, `github access token: ${res.status} ${await res.text()}`)
  return ((await res.json()) as { token: string }).token
}

export class GithubTokenError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/** GitHub takes at most this many repos in one scoped token. */
export const MAX_SCOPED_REPOS = 500

/**
 * The turn's token: PR permissions on every repo the App is installed on EXCEPT the memory repo.
 * The sandbox must never reach the memory repo directly, or one channel could read another
 * channel's notes (src/memory.ts). GitHub cannot mint "all but one", so we list the repos with a
 * first token that never leaves the Worker, and mint the turn's token for the rest by id.
 * Null when the memory repo is the only repo: then the turn simply has no GitHub access.
 */
export async function mintTurnToken(env: Env, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const memory = parseRepo(env.MEMORY_REPO)
  const lister = await mintInstallationToken(env, fetchImpl, { permissions: { metadata: 'read' } })
  const ids = withoutRepo(await listInstallationRepos(lister, fetchImpl), memory)
  if (!ids.length) return null
  const repositoryIds = ids.slice(0, MAX_SCOPED_REPOS)
  try {
    return await mintInstallationToken(env, fetchImpl, { repositoryIds })
  } catch (err) {
    // GitHub refuses (422) a token asking for a permission the install has not accepted: an App made
    // before CI reading existed. Fall back to PR access, so the turn still works, and say what to do.
    if (!(err instanceof GithubTokenError) || err.status !== 422) throw err
    console.warn('github turn token: CI read permissions not granted, falling back to PR access. Add Checks, Commit statuses and Actions (Read-only) to the App (README "GitHub App" step 3).')
    return mintInstallationToken(env, fetchImpl, { repositoryIds, permissions: PR_PERMISSIONS })
  }
}

export interface InstalledRepo {
  id: number
  full_name: string
}

/** The ids of every repo but the memory repo. Compared case-blind, as GitHub names are. */
export function withoutRepo(repos: InstalledRepo[], memory: { owner: string; name: string } | null): number[] {
  const skip = memory ? `${memory.owner}/${memory.name}`.toLowerCase() : null
  return repos.filter((r) => String(r.full_name).toLowerCase() !== skip).map((r) => r.id)
}

async function listInstallationRepos(token: string, fetchImpl: typeof fetch): Promise<InstalledRepo[]> {
  const repos: InstalledRepo[] = []
  for (let page = 1; page <= Math.ceil(MAX_SCOPED_REPOS / 100) + 1; page++) {
    const res = await fetchImpl(`https://api.github.com/installation/repositories?per_page=100&page=${page}`, { headers: githubHeaders(token) })
    if (!res.ok) throw new Error(`github repositories: ${res.status} ${await res.text()}`)
    const batch = ((await res.json()) as { repositories: InstalledRepo[] }).repositories ?? []
    repos.push(...batch)
    if (batch.length < 100) break
  }
  return repos
}

/** A 9-minute RS256 JWT that proves we are the App (GitHub allows 10). */
export async function appJwt(appId: string, pem: string, now = Math.floor(Date.now() / 1000)) {
  const enc = (o: object) => b64url(new TextEncoder().encode(JSON.stringify(o)))
  const unsigned = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({ iat: now - 60, exp: now + 9 * 60, iss: appId })}`
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToPkcs8(pem),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned)))
  return `${unsigned}.${b64url(sig)}`
}

/**
 * GitHub hands out keys as PKCS#1 ("BEGIN RSA PRIVATE KEY"), and WebCrypto only imports PKCS#8.
 * PKCS#8 is the PKCS#1 key wrapped in a small header, so we add the header rather than ask every
 * student to run openssl.
 */
export function pemToPkcs8(pem: string): ArrayBuffer {
  // Secrets pasted through a dashboard sometimes arrive with literal "\n" instead of newlines.
  const text = pem.replace(/\\n/g, '\n')
  const der = Uint8Array.from(atob(text.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')), (c) => c.charCodeAt(0))
  if (text.includes('BEGIN PRIVATE KEY')) return der.buffer
  if (!text.includes('BEGIN RSA PRIVATE KEY')) throw new Error('GITHUB_APP_PRIVATE_KEY is not a PEM private key')

  // SEQUENCE { INTEGER 0, SEQUENCE { OID rsaEncryption, NULL }, OCTET STRING { pkcs1 } }
  const version = [0x02, 0x01, 0x00]
  const algorithm = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00]
  const octet = [0x04, ...derLength(der.length), ...der]
  const body = [...version, ...algorithm, ...octet]
  return new Uint8Array([0x30, ...derLength(body.length), ...body]).buffer
}

function derLength(n: number): number[] {
  if (n < 0x80) return [n]
  const bytes: number[] = []
  while (n > 0) {
    bytes.unshift(n & 0xff)
    n >>= 8
  }
  return [0x80 | bytes.length, ...bytes]
}

// ---------------------------------------------------------------------------------------------
// Following PRs (src/pr-follow.ts). Read-only calls the Worker makes; the sandbox never sees these
// tokens.

/** Enough to read one repo's PRs. */
export const READ_PULLS_PERMISSIONS = { pull_requests: 'read', metadata: 'read' } as const

let botLoginCache: string | null = null

/**
 * Our App's bot user, `<app-slug>[bot]`: the author of every PR the bot opens. Asked of GitHub once
 * per isolate (GET /app), so renaming the App needs no setting.
 */
export async function appBotLogin(env: Env, fetchImpl: typeof fetch = fetch): Promise<string> {
  if (botLoginCache) return botLoginCache
  const res = await fetchImpl('https://api.github.com/app', { headers: githubHeaders(await appJwt(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY)) })
  if (!res.ok) throw new Error(`github app: ${res.status} ${await res.text()}`)
  const slug = ((await res.json()) as { slug?: string }).slug
  if (!slug) throw new Error('github app: no slug in the answer')
  botLoginCache = `${slug}[bot]`
  return botLoginCache
}

/** One PR, or null when GitHub has none (or the App cannot see the repo). */
export async function getPull(env: Env, repo: string, number: number, fetchImpl: typeof fetch = fetch): Promise<Record<string, any> | null> {
  const token = await mintInstallationToken(env, fetchImpl, { permissions: READ_PULLS_PERMISSIONS, repositories: [repo.split('/')[1]] }).catch(
    (err) => {
      // GitHub refuses a token for a repo the App is not installed on: that is "no such PR" to us.
      if (/\b422\b|\b404\b/.test((err as Error).message)) return null
      throw err
    },
  )
  if (!token) return null
  const res = await fetchImpl(`https://api.github.com/repos/${repo}/pulls/${number}`, { headers: githubHeaders(token) })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`github pull: ${res.status} ${await res.text()}`)
  return (await res.json()) as Record<string, any>
}

/** The numbers of the open PRs in `repo` whose head is commit `sha`. */
export async function pullsForCommit(env: Env, repo: string, sha: string, fetchImpl: typeof fetch = fetch): Promise<number[]> {
  const token = await mintInstallationToken(env, fetchImpl, { permissions: READ_PULLS_PERMISSIONS, repositories: [repo.split('/')[1]] })
  const res = await fetchImpl(`https://api.github.com/repos/${repo}/commits/${sha}/pulls`, { headers: githubHeaders(token) })
  if (!res.ok) throw new Error(`github commit pulls: ${res.status} ${await res.text()}`)
  const pulls = (await res.json()) as Array<{ number?: number; state?: string; base?: { repo?: { full_name?: string } } }>
  return pulls
    .filter((p) => p.state === 'open' && String(p.base?.repo?.full_name ?? '').toLowerCase() === repo)
    .map((p) => Number(p.number))
    .filter((n) => Number.isSafeInteger(n) && n > 0)
}

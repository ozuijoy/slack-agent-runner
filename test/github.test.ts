// I-5: the GitHub token is an installation token (1 hour, only the picked repos) with PR-only permissions.
import assert from 'node:assert/strict'
import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto'
import { test } from 'node:test'
import { appJwt, githubMissing, mintInstallationToken, mintTurnToken, parseRepo, PR_PERMISSIONS, TOKEN_PERMISSIONS, withoutRepo } from '../src/github.ts'
import { wakePrompt } from '../src/pr-follow.ts'

// GitHub hands out PKCS#1 keys; the code must accept that format as-is.
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
})

test('signs a valid RS256 app JWT from a PKCS#1 key, with escaped newlines too', async () => {
  for (const pem of [privateKey, privateKey.replace(/\n/g, '\\n')]) {
    const jwt = await appJwt('12345', pem, 1_000_000)
    const [h, p, s] = jwt.split('.')
    const ok = verify('sha256', Buffer.from(`${h}.${p}`), createPublicKey(publicKey), Buffer.from(s, 'base64url'))
    assert.equal(ok, true)
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString())
    assert.equal(claims.iss, '12345')
    assert.ok(claims.exp - claims.iat <= 600, 'GitHub refuses a JWT that lives longer than 10 minutes')
  }
})

test('mints an installation token asking only for PR permissions', async () => {
  const calls: Array<{ url: string; body?: string }> = []
  const fakeFetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body as string | undefined })
    if (url.endsWith('/app/installations')) return Response.json([{ id: 77 }])
    return Response.json({ token: 'ghs_test', expires_at: '2030-01-01T00:00:00Z' })
  }) as typeof fetch

  const env = { GITHUB_APP_ID: '12345', GITHUB_APP_PRIVATE_KEY: privateKey } as never
  assert.equal(await mintInstallationToken(env, fakeFetch), 'ghs_test')
  assert.equal(calls[1].url, 'https://api.github.com/app/installations/77/access_tokens')
  assert.deepEqual(JSON.parse(calls[1].body!), { permissions: TOKEN_PERMISSIONS })
  assert.deepEqual(TOKEN_PERMISSIONS, {
    contents: 'write',
    pull_requests: 'write',
    metadata: 'read',
    checks: 'read',
    statuses: 'read',
    actions: 'read',
  })
})

test('the turn token can run what a CI-failed wake tells Claude to run', () => {
  const prompt = wakePrompt(
    { repo: 'me/app', number: 4, url: 'https://github.com/me/app/pull/4', title: 'Fix' } as never,
    ['CI failed: test'],
    1,
  )
  // `gh pr checks` reads the status-check rollup: check runs AND commit statuses.
  assert.match(prompt, /gh pr checks 4 --repo me\/app/)
  assert.equal(TOKEN_PERMISSIONS.checks, 'read')
  assert.equal(TOKEN_PERMISSIONS.statuses, 'read')
  // "Find out why" means the failed job's log: `gh run view --log-failed` needs Actions read.
  assert.match(prompt, /gh run view <run-id> --log-failed --repo me\/app/)
  assert.equal(TOKEN_PERMISSIONS.actions, 'read')
})

test('an App without the CI read permissions still gets a PR-only turn token', async () => {
  const minted: Array<Record<string, unknown>> = []
  const fakeFetch = (async (url: string, init?: RequestInit) => {
    if (url.endsWith('/access_tokens')) {
      const body = JSON.parse(init!.body as string)
      minted.push(body)
      if (body.permissions?.checks) return new Response('{"message":"The permissions requested are not granted to this installation."}', { status: 422 })
      return Response.json({ token: `ghs_${minted.length}` })
    }
    if (url.includes('/installation/repositories')) return Response.json({ repositories: [{ id: 10, full_name: 'me/app' }] })
    throw new Error(url)
  }) as typeof fetch
  const env = { GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY: privateKey, GITHUB_INSTALLATION_ID: '7', MEMORY_REPO: 'me/bot-memory' } as never
  const warn = console.warn
  console.warn = () => {}
  try {
    assert.equal(await mintTurnToken(env, fakeFetch), 'ghs_3')
  } finally {
    console.warn = warn
  }
  assert.deepEqual(minted.slice(1), [
    { permissions: TOKEN_PERMISSIONS, repository_ids: [10] },
    { permissions: PR_PERMISSIONS, repository_ids: [10] },
  ])
})

test('a turn token failure that is not a permissions refusal is not retried', async () => {
  let mints = 0
  const fakeFetch = (async (url: string) => {
    if (url.endsWith('/access_tokens')) return ++mints === 1 ? Response.json({ token: 'ghs_l' }) : new Response('down', { status: 500 })
    return Response.json({ repositories: [{ id: 10, full_name: 'me/app' }] })
  }) as unknown as typeof fetch
  const env = { GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY: privateKey, GITHUB_INSTALLATION_ID: '7', MEMORY_REPO: 'me/bot-memory' } as never
  await assert.rejects(mintTurnToken(env, fakeFetch), /500/)
  assert.equal(mints, 2)
})

test('refuses to guess between several installations', async () => {
  const fakeFetch = (async () => Response.json([{ id: 1 }, { id: 2 }])) as unknown as typeof fetch
  const env = { GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY: privateKey } as never
  await assert.rejects(mintInstallationToken(env, fakeFetch), /GITHUB_INSTALLATION_ID/)
})

test('the GitHub App and the memory repo are required, each with a sentence saying what to set', () => {
  assert.deepEqual(githubMissing({ GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY: 'k', MEMORY_REPO: 'me/bot-memory' }), [])
  const none = githubMissing({ GITHUB_APP_ID: '', GITHUB_APP_PRIVATE_KEY: '', MEMORY_REPO: '' })
  assert.equal(none.length, 2)
  assert.match(none[0], /GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY/)
  assert.match(none[1], /MEMORY_REPO/)
  assert.match(githubMissing({ GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY: 'k', MEMORY_REPO: 'bot-memory' })[0], /owner\/name/)
})

test('parseRepo takes owner/name and nothing that could bend a URL', () => {
  assert.deepEqual(parseRepo(' me/bot-memory '), { owner: 'me', name: 'bot-memory' })
  for (const bad of ['', 'me', 'me/', 'me/a/b', 'me/..', '../x', 'me/a?b', 'me/a#b', undefined]) assert.equal(parseRepo(bad), null, String(bad))
})

test('the turn token reaches every installed repo except the memory repo', async () => {
  assert.deepEqual(
    withoutRepo(
      [
        { id: 1, full_name: 'me/app' },
        { id: 2, full_name: 'Me/Bot-Memory' },
        { id: 3, full_name: 'other/bot-memory' },
      ],
      { owner: 'me', name: 'bot-memory' },
    ),
    [1, 3],
  )

  const minted: Array<Record<string, unknown>> = []
  const fakeFetch = (async (url: string, init?: RequestInit) => {
    if (url.endsWith('/access_tokens')) {
      minted.push(JSON.parse(init!.body as string))
      return Response.json({ token: `ghs_${minted.length}` })
    }
    if (url.includes('/installation/repositories')) {
      assert.equal((init!.headers as Record<string, string>).authorization, 'Bearer ghs_1')
      return Response.json({ repositories: [{ id: 10, full_name: 'me/app' }, { id: 11, full_name: 'me/bot-memory' }] })
    }
    throw new Error(url)
  }) as typeof fetch
  const env = { GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY: privateKey, GITHUB_INSTALLATION_ID: '7', MEMORY_REPO: 'me/bot-memory' } as never
  assert.equal(await mintTurnToken(env, fakeFetch), 'ghs_2')
  // The listing token can only read metadata; the turn's token names the other repos by id.
  assert.deepEqual(minted, [{ permissions: { metadata: 'read' } }, { permissions: TOKEN_PERMISSIONS, repository_ids: [10] }])
})

test('no turn token when the App is installed on the memory repo alone', async () => {
  const fakeFetch = (async (url: string) =>
    url.includes('/installation/repositories')
      ? Response.json({ repositories: [{ id: 11, full_name: 'me/bot-memory' }] })
      : Response.json({ token: 'ghs_x' })) as unknown as typeof fetch
  const env = { GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY: privateKey, GITHUB_INSTALLATION_ID: '7', MEMORY_REPO: 'me/bot-memory' } as never
  assert.equal(await mintTurnToken(env, fakeFetch), null)
})

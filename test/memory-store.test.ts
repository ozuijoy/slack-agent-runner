// The memory repo through GitHub's API (src/memory-store.ts), against a small fake of that API.
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { test } from 'node:test'
import { pullMemory, pushMemory } from '../src/memory-store.ts'

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
})
const env = { GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY: privateKey, GITHUB_INSTALLATION_ID: '77', MEMORY_REPO: 'me/bot-memory' } as never

const gitSha = (text: string) => {
  const bytes = Buffer.from(text, 'utf8')
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
}

/** A repo whose commits are whole snapshots: path -> text. Enough of the git data API for the store. */
function fakeGitHub(files: Record<string, string>, opts: { empty?: boolean } = {}) {
  const blobs = new Map<string, string>()
  const trees = new Map<string, Record<string, string>>()
  const commits = new Map<string, { tree: string; parent: string | null }>()
  let n = 0
  const addTree = (snapshot: Record<string, string>) => {
    const id = `tree${++n}`
    for (const text of Object.values(snapshot)) blobs.set(gitSha(text), text)
    trees.set(id, snapshot)
    return id
  }
  const addCommit = (tree: string, parent: string | null) => {
    const id = `commit${++n}`
    commits.set(id, { tree, parent })
    return id
  }
  let headSha = addCommit(addTree(files), null)
  const state = {
    tokens: [] as Array<Record<string, unknown>>,
    calls: [] as string[],
    /** Runs once, just before the first branch move: another thread pushing in between. */
    beforeMove: null as null | (() => void),
    head: () => trees.get(commits.get(headSha)!.tree)!,
    push(snapshot: Record<string, string>) {
      headSha = addCommit(addTree(snapshot), headSha)
    },
    messages: [] as string[],
  }

  const fetchImpl = (async (input: string, init: RequestInit = {}) => {
    const url = new URL(input)
    const method = init.method ?? 'GET'
    const body = init.body ? JSON.parse(init.body as string) : null
    state.calls.push(`${method} ${url.pathname}`)
    if (url.pathname === '/app/installations/77/access_tokens') {
      state.tokens.push(body)
      return Response.json({ token: 'ghs_memory' })
    }
    assert.equal((init.headers as Record<string, string>).authorization, 'Bearer ghs_memory')
    const path = url.pathname.replace('/repos/me/bot-memory', '')
    if (path === '') return Response.json({ default_branch: 'main' })
    if (path === '/git/ref/heads/main') {
      if (opts.empty) return Response.json({ message: 'Git Repository is empty.' }, { status: 409 })
      return Response.json({ object: { sha: headSha } })
    }
    if (path.startsWith('/git/commits/')) return Response.json({ tree: { sha: commits.get(path.split('/').pop()!)!.tree } })
    if (path.startsWith('/git/trees/') && method === 'GET') {
      const id = path.split('/').pop()!
      if (id.includes(':')) {
        // A channel folder: every file under it, relative.
        const [tree, dir] = id.split(':')
        const entries = Object.entries(trees.get(tree)!)
          .filter(([p]) => p.startsWith(`${dir}/`))
          .map(([p, text]) => ({ path: p.slice(dir.length + 1), type: 'blob', sha: gitSha(text) }))
        return Response.json({ tree: entries, truncated: false })
      }
      const dirs = [...new Set(Object.keys(trees.get(id)!).map((p) => p.split('/')[0]))]
      return Response.json({ tree: dirs.map((d) => ({ path: d, type: 'tree', sha: `${id}:${d}` })) })
    }
    if (path.startsWith('/git/blobs/')) {
      return Response.json({ content: Buffer.from(blobs.get(path.split('/').pop()!)!).toString('base64'), encoding: 'base64' })
    }
    if (path === '/git/trees' && method === 'POST') {
      const next = { ...trees.get(body.base_tree)! }
      for (const e of body.tree) {
        if (e.sha === null) delete next[e.path]
        else next[e.path] = e.content
      }
      return Response.json({ sha: addTree(next) })
    }
    if (path === '/git/commits' && method === 'POST') {
      state.messages.push(body.message)
      return Response.json({ sha: addCommit(body.tree, body.parents[0]) })
    }
    if (path === '/git/refs/heads/main' && method === 'PATCH') {
      if (state.beforeMove) {
        const run = state.beforeMove
        state.beforeMove = null
        run()
      }
      assert.equal(body.force, false)
      if (commits.get(body.sha)!.parent !== headSha) return Response.json({ message: 'Update is not a fast forward' }, { status: 422 })
      headSha = body.sha
      return Response.json({ object: { sha: headSha } })
    }
    throw new Error(`unexpected ${method} ${url.pathname}`)
  }) as unknown as typeof fetch
  return { state, fetchImpl }
}

test('a pull returns only the channel folder, with a token for the memory repo alone', async () => {
  const { state, fetchImpl } = fakeGitHub({
    'README.md': 'hi',
    'CHANNELA/MEMORY.md': '- [Deploy](deploy.md)\n',
    'CHANNELA/deploy.md': 'npm run ship\n',
    'CHANNELB/MEMORY.md': 'a private channel\n',
  })
  const files = await pullMemory(env, 'CHANNELA', fetchImpl)
  assert.deepEqual(
    files.map((f) => [f.path, f.content]),
    [
      ['MEMORY.md', '- [Deploy](deploy.md)\n'],
      ['deploy.md', 'npm run ship\n'],
    ],
  )
  assert.equal(files[0].sha, gitSha('- [Deploy](deploy.md)\n'))
  assert.deepEqual(state.tokens, [{ permissions: { contents: 'write', metadata: 'read' }, repositories: ['bot-memory'] }])
  assert.deepEqual(await pullMemory(env, 'CHANNELNEW', fetchImpl), [])
})

test('a push commits inside the channel folder only, and says which thread taught it', async () => {
  const { state, fetchImpl } = fakeGitHub({ 'CHANNELA/old.md': 'old\n', 'CHANNELB/MEMORY.md': 'other\n' })
  const commit = await pushMemory(
    env,
    { channel: 'CHANNELA', threadTs: '1700000000.000100', turnId: 't1' },
    {
      base: { 'old.md': gitSha('old\n') },
      changes: [
        { path: 'MEMORY.md', content: '- [Deploy](deploy.md)\n' },
        { path: 'deploy.md', content: 'npm run ship\n' },
        { path: 'old.md', content: null },
      ],
    },
    fetchImpl,
  )
  assert.ok(commit)
  assert.deepEqual(state.head(), {
    'CHANNELA/MEMORY.md': '- [Deploy](deploy.md)\n',
    'CHANNELA/deploy.md': 'npm run ship\n',
    'CHANNELB/MEMORY.md': 'other\n',
  })
  assert.match(state.messages[0], /^memory: CHANNELA thread 1700000000\.000100\n/)
})

test('nothing changed means no commit', async () => {
  const { state, fetchImpl } = fakeGitHub({ 'CHANNELA/a.md': 'a\n' })
  const who = { channel: 'CHANNELA', threadTs: '1.2', turnId: 't1' }
  assert.equal(await pushMemory(env, who, { base: {}, changes: [{ path: 'a.md', content: 'a\n' }] }, fetchImpl), null)
  assert.ok(!state.calls.includes('POST /repos/me/bot-memory/git/commits'))
})

test('another thread pushing first is merged, never overwritten', async () => {
  const { state, fetchImpl } = fakeGitHub({ 'CHANNELA/MEMORY.md': '- one\n' })
  const base = { 'MEMORY.md': gitSha('- one\n') }
  // Between our commit and our branch move, another thread adds a line and a note.
  state.beforeMove = () => state.push({ 'CHANNELA/MEMORY.md': '- one\n- theirs\n', 'CHANNELA/theirs.md': 'x\n' })
  await pushMemory(
    env,
    { channel: 'CHANNELA', threadTs: '1.2', turnId: 't2' },
    { base, changes: [{ path: 'MEMORY.md', content: '- one\n- mine\n' }, { path: 'mine.md', content: 'y\n' }] },
    fetchImpl,
  )
  assert.deepEqual(state.head(), {
    'CHANNELA/MEMORY.md': '- one\n- theirs\n- mine\n',
    'CHANNELA/theirs.md': 'x\n',
    'CHANNELA/mine.md': 'y\n',
  })
})

test('an empty memory repo gets a sentence saying what to do', async () => {
  const { fetchImpl } = fakeGitHub({}, { empty: true })
  await assert.rejects(pullMemory(env, 'CHANNELA', fetchImpl), /no commits yet. Add a README/)
})

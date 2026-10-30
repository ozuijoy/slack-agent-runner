// The sandbox side of memory (box/memory.mjs): the pull keeps unpushed notes, the push sends only changes.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync, existsSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { planMerge, blobSha as workerSha } from '../src/memory.ts'

const box = join(dirname(fileURLToPath(import.meta.url)), '..', 'box')
const mem = await import(pathToFileURL(join(box, 'memory.mjs')).href)

async function withServer(handler: (req: IncomingMessage, body: string, res: ServerResponse) => void, run: (url: string) => Promise<void>) {
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => handler(req, body, res))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  try {
    await run(`http://127.0.0.1:${(server.address() as { port: number }).port}/sandbox/memory`)
  } finally {
    server.closeAllConnections()
    server.close()
  }
}

test('the sandbox and the Worker compute the same blob ids, and agree on paths', async () => {
  for (const text of ['', 'a\n', '# Notes\n- é\n']) assert.equal(mem.blobSha(text), await workerSha(text))
  assert.equal(mem.isMemoryPath('topic/note.md'), true)
  assert.equal(mem.isMemoryPath('../x.md'), false)
})

test('planPull keeps unpushed local edits and deletes, and takes the remote for the rest', () => {
  const plan = mem.planPull({
    remote: { 'same.md': 's', 'theirs.md': 't2', 'mine.md': 'r', 'gone-here.md': 'g', 'new.md': 'n' },
    base: { 'same.md': 's', 'theirs.md': 't1', 'mine.md': 'm0', 'gone-here.md': 'g', 'removed.md': 'x' },
    local: { 'same.md': 's', 'theirs.md': 't1', 'mine.md': 'm1', 'removed.md': 'x', 'draft.md': 'd' },
  })
  // theirs.md moved remotely and is untouched here; new.md is new remotely. mine.md, the local delete
  // of gone-here.md, and draft.md are unpushed edits and stay. removed.md went remotely.
  assert.deepEqual(plan.write.sort(), ['new.md', 'theirs.md'])
  assert.deepEqual(plan.remove, ['removed.md'])
  // A pending path keeps the base its edit was made from (mine.md stays m0, draft.md stays absent).
  assert.deepEqual(plan.base, { 'same.md': 's', 'theirs.md': 't2', 'mine.md': 'm0', 'gone-here.md': 'g', 'new.md': 'n' })
})

test('planPull: a pending path that already matches the remote takes the remote as its base', () => {
  const plan = mem.planPull({ remote: { 'a.md': 'new' }, base: { 'a.md': 'old', 'gone.md': 'g' }, local: { 'a.md': 'new' } })
  assert.deepEqual(plan.base, { 'a.md': 'new' })
})

test('an unpushed edit, another thread\'s change, then a pull: the next push conflicts, it does not overwrite', async () => {
  const sha = mem.blobSha
  const [X, L, Y] = ['x\n', 'mine\n', 'theirs\n']
  const [I0, IL, IY] = ['- a\n', '- a\n- mine\n', '- a\n- theirs\n']
  // Turn 1 pulled n=X, MEMORY.md=I0 and d=D, edited n and the index, deleted d; its push failed.
  const base1 = { 'n.md': sha(X), 'MEMORY.md': sha(I0), 'd.md': sha('D\n') }
  const local = {
    'n.md': { sha: sha(L), content: L },
    'MEMORY.md': { sha: sha(IL), content: IL },
  }
  // Thread B rewrote all three meanwhile. The delete of d.md must not land on B's rewrite.
  const remote = { 'n.md': sha(Y), 'MEMORY.md': sha(IY), 'd.md': sha('D2\n') }
  const localShas = Object.fromEntries(Object.entries(local).map(([p, n]) => [p, n.sha]))
  const plan = mem.planPull({ remote, base: base1, local: localShas })
  assert.deepEqual(plan.write, [])
  assert.deepEqual(plan.remove, [])

  const changes = mem.changesSince(plan.base, local)
  const steps = await planMerge(remote, { base: plan.base, changes }, 'turn2')
  assert.deepEqual(steps, [
    { kind: 'write', path: 'n.conflict-turn2.md', content: L },
    { kind: 'union', path: 'MEMORY.md', content: IL },
  ])
})

test('changesSince lists new, edited and deleted notes only', () => {
  const changes = mem.changesSince(
    { 'a.md': 'sa', 'b.md': 'sb', 'gone.md': 'sg' },
    { 'a.md': { sha: 'sa', content: 'A' }, 'b.md': { sha: 'sb2', content: 'B2' }, 'c.md': { sha: 'sc', content: 'C' } },
  )
  assert.deepEqual(changes, [
    { path: 'b.md', content: 'B2' },
    { path: 'c.md', content: 'C' },
    { path: 'gone.md', content: null },
  ])
})

test('readLocal reads Markdown notes and skips links and other files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mem-'))
  try {
    mkdirSync(join(dir, 'topic'))
    writeFileSync(join(dir, 'MEMORY.md'), '- x\n')
    writeFileSync(join(dir, 'topic', 'note.md'), 'n\n')
    writeFileSync(join(dir, 'scratch.txt'), 'no')
    writeFileSync(join(dir, 'secret'), 'outside')
    symlinkSync(join(dir, 'secret'), join(dir, 'link.md'))
    const local = mem.readLocal(dir)
    assert.deepEqual(Object.keys(local).sort(), ['MEMORY.md', 'topic/note.md'])
    assert.equal(local['MEMORY.md'].sha, mem.blobSha('- x\n'))
    assert.deepEqual(mem.readLocal(join(dir, 'missing')), {})
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('pull writes the channel notes with the token, and a failed push survives into the next turn', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mem-'))
  const dir = join(root, 'memory')
  const baseFile = join(root, 'memory-base.json')
  let remote: Array<{ path: string; content: string }> = [
    { path: 'MEMORY.md', content: '- [Deploy](deploy.md)\n' },
    { path: 'deploy.md', content: 'npm run ship\n' },
    { path: '../escape.md', content: 'refused' },
  ]
  const pushes: Array<Record<string, unknown>> = []
  let pushStatus = 503
  try {
    await withServer(
      (req, body, res) => {
        assert.equal(req.headers.authorization, 'Bearer tok')
        assert.match(String(req.headers['x-turn-id']), /^turn-[12]$/)
        if (req.method === 'GET') return res.end(JSON.stringify({ ok: true, files: remote }))
        pushes.push(JSON.parse(body))
        res.statusCode = pushStatus
        res.end('{}')
      },
      async (url) => {
        const first = await mem.pull({ url, token: 'tok', turnId: 'turn-1', dir, baseFile })
        assert.equal(first.ok, true)
        assert.equal(readFileSync(join(dir, 'deploy.md'), 'utf8'), 'npm run ship\n')
        assert.equal(existsSync(join(root, 'escape.md')), false)

        // Claude edits a note and adds one; the Worker is mid-deploy for the whole push.
        writeFileSync(join(dir, 'deploy.md'), 'npm run ship -- --prod\n')
        writeFileSync(join(dir, 'gotcha.md'), 'tests need TZ=UTC\n')
        const local = mem.readLocal(dir)
        const changes = mem.changesSince(first.base, local)
        assert.equal(await mem.push({ url, token: 'tok', turnId: 'turn-1', base: first.base, changes, baseFile, local, attempts: 1 }), false)
        assert.deepEqual(pushes[0].changes, [
          { path: 'deploy.md', content: 'npm run ship -- --prod\n' },
          { path: 'gotcha.md', content: 'tests need TZ=UTC\n' },
        ])

        // The next turn pulls: someone else changed MEMORY.md meanwhile. The unpushed notes stay.
        remote = [{ path: 'MEMORY.md', content: '- [Deploy](deploy.md)\n- [Other](other.md)\n' }, { path: 'deploy.md', content: 'npm run ship\n' }]
        const second = await mem.pull({ url, token: 'tok', turnId: 'turn-2', dir, baseFile })
        assert.equal(second.ok, true)
        assert.equal(readFileSync(join(dir, 'MEMORY.md'), 'utf8'), '- [Deploy](deploy.md)\n- [Other](other.md)\n')
        assert.equal(readFileSync(join(dir, 'deploy.md'), 'utf8'), 'npm run ship -- --prod\n')
        assert.equal(readFileSync(join(dir, 'gotcha.md'), 'utf8'), 'tests need TZ=UTC\n')

        // ...and its push sends them again, this time stored.
        pushStatus = 200
        const local2 = mem.readLocal(dir)
        const changes2 = mem.changesSince(second.base, local2)
        assert.deepEqual(changes2.map((c: { path: string }) => c.path), ['deploy.md', 'gotcha.md'])
        assert.equal(await mem.push({ url, token: 'tok', turnId: 'turn-2', base: second.base, changes: changes2, baseFile, local: local2 }), true)
        assert.deepEqual(mem.loadBase(baseFile).base, Object.fromEntries(Object.entries(local2).map(([p, n]) => [p, (n as { sha: string }).sha])))
      },
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a pull that fails leaves the folder alone and says why', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mem-'))
  try {
    await withServer(
      (_req, _body, res) => {
        res.statusCode = 502
        res.end(JSON.stringify({ ok: false, error: 'the memory repo has no commits yet' }))
      },
      async (url) => {
        const result = await mem.pull({ url, token: 'tok', turnId: 't', dir: join(root, 'm'), baseFile: join(root, 'b.json') })
        assert.deepEqual(result, { ok: false, error: 'the memory repo has no commits yet' })
        assert.match(mem.memoryNote(result), /could not be loaded this turn: the memory repo has no commits yet/)
        assert.equal(mem.memoryNote({ ok: true }), '')
      },
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("a push's base is written only while its turn still owns the base file", () => {
  const root = mkdtempSync(join(tmpdir(), 'mem-'))
  const file = join(root, 'b.json')
  try {
    mem.saveBase(file, { 'a.md': 'x' }, 'turn-1')
    // The next turn pulled while turn-1's push was still running.
    mem.saveBase(file, { 'a.md': 'y' }, 'turn-2')
    assert.equal(mem.saveBase(file, { 'a.md': 'z' }, 'turn-1', { onlyIfOwner: true }), false)
    assert.deepEqual(mem.loadBase(file), { turnId: 'turn-2', base: { 'a.md': 'y' } })
    assert.deepEqual(mem.loadBase(join(root, 'none.json')), { turnId: '', base: {} })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('auto memory is pointed at the folder, or turned off, without losing other settings', () => {
  const root = mkdtempSync(join(tmpdir(), 'mem-'))
  const file = join(root, '.claude', 'settings.json')
  try {
    mkdirSync(dirname(file))
    writeFileSync(file, JSON.stringify({ theme: 'dark' }))
    mem.writeMemorySettings(file, '/home/user/.agent/memory')
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { theme: 'dark', autoMemoryEnabled: true, autoMemoryDirectory: '/home/user/.agent/memory' })
    mem.writeMemorySettings(file, null)
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { theme: 'dark', autoMemoryEnabled: false })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

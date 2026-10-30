// Memory rules (src/memory.ts): one folder per channel, which paths sync, and how two threads merge.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import {
  blobSha,
  channelDir,
  checkPush,
  commitMessage,
  conflictPath,
  isMemoryPath,
  MAX_FILE_BYTES,
  MAX_FILES,
  planMerge,
  unionLines,
} from '../src/memory.ts'

const gitSha = (text: string) => {
  const bytes = Buffer.from(text, 'utf8')
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
}

test('the folder is the channel id, and nothing in it can name another folder', () => {
  assert.equal(channelDir('CHANNELX'), 'CHANNELX')
  assert.equal(channelDir('../C1/..'), 'C1')
  assert.throws(() => channelDir(''), /no channel/)
  assert.throws(() => channelDir('/../'), /no channel/)
})

test('only plain Markdown paths inside the folder sync', () => {
  for (const ok of ['MEMORY.md', 'deploy_steps.md', 'topic/note.md', 'a/b/c/d.md', 'v1.2-notes.md']) assert.equal(isMemoryPath(ok), true, ok)
  for (const bad of ['../C1/MEMORY.md', '/etc/x.md', 'a/../b.md', '.git/config.md', '.hidden.md', 'notes.txt', 'a//b.md', 'a/b/c/d/e.md', '', 'x..md', 7]) {
    assert.equal(isMemoryPath(bad), false, String(bad))
  }
})

test('blobSha is the git blob id, so the Worker, the sandbox and GitHub agree', async () => {
  assert.equal(await blobSha(''), 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391')
  for (const text of ['hello\n', '# Memory\n- [é](x.md)\n']) assert.equal(await blobSha(text), gitSha(text))
})

test('checkPush refuses bad paths, duplicates, non-text and oversize, and drops a bad base', () => {
  assert.equal(checkPush(null).ok, false)
  assert.equal(checkPush({ changes: 'x' }).ok, false)
  assert.match((checkPush({ changes: [{ path: '../C1/MEMORY.md', content: 'x' }] }) as { error: string }).error, /not a memory path/)
  assert.match((checkPush({ changes: [{ path: 'a.md', content: 'x' }, { path: 'a.md', content: null }] }) as { error: string }).error, /twice/)
  assert.match((checkPush({ changes: [{ path: 'a.md', content: 5 }] }) as { error: string }).error, /text or null/)
  assert.match((checkPush({ changes: [{ path: 'a.md', content: 'x'.repeat(MAX_FILE_BYTES + 1) }] }) as { error: string }).error, /over/)
  const many = Array.from({ length: MAX_FILES + 1 }, (_, i) => ({ path: `n${i}.md`, content: '' }))
  assert.equal(checkPush({ changes: many }).ok, false)

  const ok = checkPush({
    base: { 'a.md': 'a'.repeat(40), '../x.md': 'b'.repeat(40), 'b.md': 'not-a-sha' },
    changes: [{ path: 'a.md', content: 'new' }, { path: 'gone.md', content: null }],
  })
  assert.deepEqual(ok, {
    ok: true,
    push: { base: { 'a.md': 'a'.repeat(40) }, changes: [{ path: 'a.md', content: 'new' }, { path: 'gone.md', content: null }] },
  })
})

test('planMerge: the sandbox wins where the remote has not moved, and a no-op is skipped', async () => {
  const old = gitSha('old\n')
  const steps = await planMerge(
    { 'a.md': old, 'same.md': gitSha('same\n'), 'gone.md': old },
    {
      base: { 'a.md': old, 'same.md': old, 'gone.md': old },
      changes: [
        { path: 'a.md', content: 'new\n' },
        { path: 'same.md', content: 'same\n' },
        { path: 'fresh.md', content: 'fresh\n' },
        { path: 'gone.md', content: null },
      ],
    },
    'turn-1',
  )
  assert.deepEqual(steps, [
    { kind: 'write', path: 'a.md', content: 'new\n' },
    { kind: 'write', path: 'fresh.md', content: 'fresh\n' },
    { kind: 'delete', path: 'gone.md' },
  ])
})

test('planMerge: another thread changed it too, so the index unions and a note is saved beside', async () => {
  const base = gitSha('v1\n')
  const theirs = gitSha('v2 from another thread\n')
  const steps = await planMerge(
    { 'MEMORY.md': theirs, 'topic/MEMORY.md': theirs, 'note.md': theirs, 'edited.md': theirs, 'already.md': undefined as never },
    {
      base: { 'MEMORY.md': base, 'topic/MEMORY.md': base, 'note.md': base, 'edited.md': base, 'already.md': base },
      changes: [
        { path: 'MEMORY.md', content: 'mine\n' },
        { path: 'topic/MEMORY.md', content: 'mine\n' },
        { path: 'note.md', content: 'mine\n' },
        // A delete never removes a note someone changed since the pull, or one already gone.
        { path: 'edited.md', content: null },
        { path: 'already.md', content: null },
      ],
    },
    'turn/9',
  )
  assert.deepEqual(steps, [
    { kind: 'union', path: 'MEMORY.md', content: 'mine\n' },
    { kind: 'union', path: 'topic/MEMORY.md', content: 'mine\n' },
    { kind: 'write', path: 'note.conflict-turn9.md', content: 'mine\n' },
  ])
})

test('a file new on both sides is a conflict, not an overwrite', async () => {
  const steps = await planMerge({ 'x.md': gitSha('theirs\n') }, { base: {}, changes: [{ path: 'x.md', content: 'mine\n' }] }, 't1')
  assert.deepEqual(steps, [{ kind: 'write', path: conflictPath('x.md', 't1'), content: 'mine\n' }])
  assert.equal(conflictPath('x.md', 't1'), 'x.conflict-t1.md')
  assert.equal(isMemoryPath(conflictPath('a/b.md', 'abc-123')), true)
})

test('unionLines keeps the remote, then adds only the new lines', () => {
  assert.equal(unionLines('- a\n- b\n', '- a\n- c\n'), '- a\n- b\n- c\n')
  assert.equal(unionLines('- a', '- a\n'), '- a')
  assert.equal(unionLines('', 'x\n'), 'x\n')
  assert.equal(unionLines('x\n', ''), 'x\n')
})

test('the commit message names the channel, the thread and the files', () => {
  const msg = commitMessage('CHANNELX', '1700000000.000100', [
    { kind: 'write', path: 'a.md', content: '' },
    { kind: 'delete', path: 'b.md' },
  ])
  assert.equal(msg, 'memory: CHANNELX thread 1700000000.000100\n\n- a.md\n- b.md\n')
})

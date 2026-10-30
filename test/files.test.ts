// Files both ways: the grant rules, the checks on uploads and canvases, and the doors' sources.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { signCallbackToken, verifyCallbackToken } from '../src/callback-token.ts'
import {
  canvasLinkText,
  checkCanvas,
  checkUpload,
  downloadHeaders,
  filesFromEvent,
  fileSharedIn,
  looksLikeSignInPage,
  manifestFor,
  MAX_FILE_BYTES,
  MAX_FILES_PER_TURN,
  MAX_UPLOAD_BYTES,
  safeName,
  verifyFileGrant,
} from '../src/files.ts'

const SECRET = 'test-secret-test-secret'
const NOW = 1_000_000
const thread = { channel: 'C1', threadTs: '111.222', exp: NOW + 60_000 }

test('reads the file refs from an event, dropping anything without a Slack file id', () => {
  const refs = filesFromEvent([
    { id: 'F1', name: 'a.png', size: 10, mimetype: 'image/png', url_private: 'https://x' },
    { id: 'F2', file_access: 'check_file_info' },
    { id: 'F3', name: 'doc', mode: 'external' },
    { name: 'no id' },
    { id: '../etc' },
    null,
  ])
  assert.deepEqual(refs, [
    { id: 'F1', name: 'a.png', size: 10, mimetype: 'image/png' },
    // A stub is still a Slack file: the door reads it in full from files.info.
    { id: 'F2', name: 'file' },
    { id: 'F3', name: 'doc', external: true },
  ])
  assert.deepEqual(filesFromEvent(undefined), [])
})

test('a file name cannot climb out of the folder or hide', () => {
  assert.equal(safeName('../../etc/passwd'), 'passwd')
  assert.equal(safeName('..\\evil.sh'), 'evil.sh')
  assert.equal(safeName('.bashrc'), 'bashrc')
  assert.equal(safeName('rapport été.pdf'), 'rapport _t_.pdf')
  assert.equal(safeName(''), 'file')
  assert.equal(safeName(undefined), 'file')
  assert.ok(safeName('x'.repeat(500)).length <= 100)
})

test('each downloadable file gets a grant for that file in this thread, and a path under slack-files', async () => {
  const manifest = await manifestFor(SECRET, {
    ...thread,
    messages: [
      { user: 'U1', files: [{ id: 'F1', name: 'log.txt', size: 5 }] },
      { user: 'U2', files: [{ id: 'F1', name: 'log.txt', size: 5 }, { id: 'F2', name: 'big.mov', size: MAX_FILE_BYTES + 1 }] },
      { user: 'U2', files: [{ id: 'F3', name: 'doc', external: true }] },
      { user: 'U3' },
    ],
  })
  assert.equal(manifest.length, 3, 'deduped by file id')
  const [first, big, external] = manifest
  assert.ok('grant' in first)
  assert.equal(first.path, 'slack-files/F1-log.txt')
  assert.equal(first.from, 'U1')
  assert.match((big as { error: string }).error, /too large/)
  assert.match((external as { error: string }).error, /outside Slack/)

  const verified = await verifyFileGrant(SECRET, first.grant, NOW)
  assert.ok(verified.ok)
  assert.deepEqual(verified.claims, { channel: 'C1', threadTs: '111.222', fileId: 'F1', exp: NOW + 60_000 })
})

test('past the per-turn limit a file is listed with the reason, not dropped', async () => {
  const files = Array.from({ length: MAX_FILES_PER_TURN + 2 }, (_, i) => ({ id: `F${i}`, name: `f${i}` }))
  const manifest = await manifestFor(SECRET, { ...thread, messages: [{ user: 'U1', files }] })
  assert.equal(manifest.length, MAX_FILES_PER_TURN + 2)
  assert.equal(manifest.filter((e) => 'grant' in e).length, MAX_FILES_PER_TURN)
  assert.match((manifest.at(-1) as { error: string }).error, /limit/)
})

test('a grant is refused when expired, forged, or a token for another door', async () => {
  const [entry] = await manifestFor(SECRET, { ...thread, messages: [{ user: 'U1', files: [{ id: 'F1', name: 'a' }] }] })
  const grant = (entry as { grant: string }).grant
  assert.equal((await verifyFileGrant(SECRET, grant, NOW + 60_000)).ok, false)
  assert.equal((await verifyFileGrant('another-secret-entirely', grant, NOW)).ok, false)
  assert.equal((await verifyFileGrant(SECRET, null, NOW)).ok, false)

  // The reply and tools tokens are signed with other keys: neither is a file grant, and a grant
  // opens neither of their doors.
  const claims = { channel: 'C1', threadTs: '111.222', turnId: 't1', lastTs: '111.300', exp: NOW + 60_000 }
  const reply = await signCallbackToken(SECRET, claims)
  const tools = await signCallbackToken(SECRET, claims, 'tools')
  assert.equal((await verifyFileGrant(SECRET, reply, NOW)).ok, false)
  assert.equal((await verifyFileGrant(SECRET, tools, NOW)).ok, false)
  assert.equal((await verifyCallbackToken(SECRET, grant, 't1', NOW)).ok, false)
})

test("Claude's tools token cannot deliver the answer, and the reply token cannot use the tools doors", async () => {
  const claims = { channel: 'C1', threadTs: '111.222', turnId: 't1', lastTs: '111.300', exp: NOW + 60_000 }
  const reply = await signCallbackToken(SECRET, claims)
  const tools = await signCallbackToken(SECRET, claims, 'tools')
  assert.equal((await verifyCallbackToken(SECRET, reply, 't1', NOW)).ok, true)
  assert.equal((await verifyCallbackToken(SECRET, tools, 't1', NOW)).ok, false)
  assert.equal((await verifyCallbackToken(SECRET, tools, 't1', NOW, 'tools')).ok, true)
  assert.equal((await verifyCallbackToken(SECRET, reply, 't1', NOW, 'tools')).ok, false)
  assert.equal((await verifyCallbackToken(SECRET, tools, 'other-turn', NOW, 'tools')).ok, false)
})

test('a file counts as in the channel by either of the shapes Slack answers in', () => {
  assert.equal(fileSharedIn({ shares: { public: { C1: [] } } }, 'C1'), true)
  assert.equal(fileSharedIn({ shares: { private: { G1: [] } } }, 'G1'), true)
  assert.equal(fileSharedIn({ channels: ['C2', 'C1'] }, 'C1'), true)
  assert.equal(fileSharedIn({ ims: ['D1'] }, 'D1'), true)
  assert.equal(fileSharedIn({ shares: { public: { C2: [] } }, channels: ['C3'] }, 'C1'), false)
  assert.equal(fileSharedIn(null, 'C1'), false)
})

test('the download keeps a length only when Slack did not compress the body', () => {
  const plain = downloadHeaders(new Headers({ 'content-type': 'image/png', 'content-length': '10' }), { size: 10 })
  assert.deepEqual(plain, { 'content-type': 'image/png', 'content-length': '10', 'x-file-size': '10' })
  const gz = downloadHeaders(new Headers({ 'content-length': '4', 'content-encoding': 'gzip' }), { size: 10 })
  assert.deepEqual(gz, { 'content-type': 'application/octet-stream', 'x-file-size': '10' })
})

test("Slack's sign-in page is not mistaken for the file", () => {
  assert.equal(looksLikeSignInPage(new Headers({ 'content-type': 'text/html; charset=utf-8' }), { mimetype: 'image/png' }), true)
  assert.equal(looksLikeSignInPage(new Headers({ 'content-type': 'text/html' }), { mimetype: 'text/html' }), false)
  assert.equal(looksLikeSignInPage(new Headers({ 'content-type': 'image/png' }), { mimetype: 'image/png' }), false)
})

test('an upload is checked before its body is read', () => {
  const base = { contentLength: '12', filename: encodeURIComponent('../report é.html'), title: null, comment: null }
  const ok = checkUpload(base)
  assert.ok(ok.ok)
  assert.deepEqual(ok.upload, { filename: 'report _.html' })
  assert.equal(ok.size, 12)

  assert.deepEqual(checkUpload({ ...base, contentLength: null }), { ok: false, status: 411, error: 'content-length required' })
  assert.equal((checkUpload({ ...base, contentLength: '0' }) as { status: number }).status, 400)
  assert.equal((checkUpload({ ...base, contentLength: String(MAX_UPLOAD_BYTES + 1) }) as { status: number }).status, 413)
  assert.equal((checkUpload({ ...base, filename: null }) as { status: number }).status, 400)
  assert.equal((checkUpload({ ...base, comment: encodeURIComponent('x'.repeat(5000)) }) as { status: number }).status, 400)

  const titled = checkUpload({ ...base, title: encodeURIComponent('Line one\nline two'), comment: encodeURIComponent('Here it is') })
  assert.ok(titled.ok)
  assert.deepEqual(titled.upload, { filename: 'report _.html', title: 'Line one line two', comment: 'Here it is' })
})

test('a canvas needs a title and some markdown, under the cap', () => {
  assert.deepEqual(checkCanvas({ title: ' Plan ', markdown: '# Hi' }), { ok: true, title: 'Plan', markdown: '# Hi' })
  assert.equal(checkCanvas({ markdown: '# Hi' }).ok, false)
  assert.equal(checkCanvas({ title: 'Plan', markdown: '  ' }).ok, false)
  assert.equal(checkCanvas({ title: 'Plan', markdown: 'x'.repeat(200_001) }).ok, false)
  assert.equal(checkCanvas(null).ok, false)
})

test('the canvas link line cannot be bent by the title', () => {
  assert.equal(canvasLinkText('Plan <b>|x', 'https://s/c'), ':page_facing_up: Canvas: <https://s/c|Plan bx>')
  assert.match(canvasLinkText('Plan', null), /no link/)
})

test('the upload and canvas doors take the thread from the tools token, never the request', () => {
  const index = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.ts'), 'utf8')
  for (const name of ['sandboxUpload', 'sandboxCanvas']) {
    const start = index.indexOf(`async function ${name}`)
    const door = index.slice(start, index.indexOf('\n}\n', start))
    assert.match(door, /'tools'\)/, `${name} checks the tools token`)
    assert.match(door, /const { channel, threadTs, turnId } = verified\.claims/)
    assert.doesNotMatch(door, /body\??\.(channel|threadTs|thread_ts)/)
  }
  const start = index.indexOf('async function sandboxFile')
  const door = index.slice(start, index.indexOf('\n}\n', start))
  assert.match(door, /verifyFileGrant\(env\.CALLBACK_SECRET, grant\)/)
  assert.match(door, /fileSharedIn\(file, channel\)/)
  assert.doesNotMatch(door, /searchParams|request\.json/)
})

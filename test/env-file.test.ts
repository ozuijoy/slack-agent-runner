// scripts/setup.mjs reads .env.setup, and writes the GitHub webhook secret it generates back into it
// so the human can copy it into the GitHub App without setup ever printing it.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseEnvFile, setEnvLine, webhookSecretPlan } from '../scripts/env-file.ts'

test('the answers file: quotes stripped, comments and empty values skipped', () => {
  const text = '# a comment\nSANDBOX_PROVIDER=e2b\nMEMORY_REPO="you/my-bot-memory"\nGITHUB_WEBHOOK_SECRET=\nnot a line\n'
  assert.deepEqual(parseEnvFile(text), { SANDBOX_PROVIDER: 'e2b', MEMORY_REPO: 'you/my-bot-memory' })
})

test('setEnvLine fills the empty line in place and leaves every other line alone', () => {
  const text = '# keep me\nSLACK_BOT_TOKEN=xyz\nGITHUB_WEBHOOK_SECRET=\nMEMORY_REPO=a/b\n'
  const out = setEnvLine(text, 'GITHUB_WEBHOOK_SECRET', 'abc123')
  assert.equal(out, '# keep me\nSLACK_BOT_TOKEN=xyz\nGITHUB_WEBHOOK_SECRET=abc123\nMEMORY_REPO=a/b\n')
  assert.equal(parseEnvFile(out).GITHUB_WEBHOOK_SECRET, 'abc123')
})

test('setEnvLine adds the line when the file has none, or when there is no file yet', () => {
  assert.equal(setEnvLine('A=1', 'GITHUB_WEBHOOK_SECRET', 'x'), 'A=1\nGITHUB_WEBHOOK_SECRET=x\n')
  assert.equal(setEnvLine('', 'GITHUB_WEBHOOK_SECRET', 'x'), 'GITHUB_WEBHOOK_SECRET=x\n')
  // A longer name that starts the same is a different line.
  assert.equal(setEnvLine('GITHUB_WEBHOOK_SECRET_OLD=y\n', 'GITHUB_WEBHOOK_SECRET', 'x'), 'GITHUB_WEBHOOK_SECRET_OLD=y\nGITHUB_WEBHOOK_SECRET=x\n')
})

test('setEnvLine refuses a value that would add a line', () => {
  assert.throws(() => setEnvLine('', 'GITHUB_WEBHOOK_SECRET', 'a\nSLACK_BOT_TOKEN=evil'), /bad env line/)
})

test('webhook secret: the human\'s string wins, a stored one is kept, else setup makes one', () => {
  assert.equal(webhookSecretPlan('mine', null), 'use')
  assert.equal(webhookSecretPlan(undefined, new Set(['GITHUB_WEBHOOK_SECRET'])), 'keep')
  assert.equal(webhookSecretPlan(undefined, new Set(['CALLBACK_SECRET'])), 'generate')
})

test('webhook secret: an unreadable secret list never generates a new one', () => {
  assert.throws(() => webhookSecretPlan(undefined, null), /could not read/)
})

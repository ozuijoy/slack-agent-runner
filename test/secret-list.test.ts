// scripts/setup.mjs generates CALLBACK_SECRET and CHANNEL_SECRETS_KEY only when it read the
// Worker's secret list and they are not on it. A failed read must never look like "none exist".
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { generatedSecretsToCreate, parseSecretList } from '../scripts/secret-list.ts'

const GENERATED = ['CALLBACK_SECRET', 'CHANNEL_SECRETS_KEY']

test('a clean list is read, banner or not, and only missing generated secrets are created', () => {
  const json = JSON.stringify([{ name: 'CHANNEL_SECRETS_KEY', type: 'secret_text' }, { name: 'SLACK_BOT_TOKEN', type: 'secret_text' }])
  assert.deepEqual([...parseSecretList(true, json)!], ['CHANNEL_SECRETS_KEY', 'SLACK_BOT_TOKEN'])
  const have = parseSecretList(true, ` ⛅️ wrangler 4.152.0 [beta]\n----\n${json}\n`)
  assert.deepEqual(generatedSecretsToCreate(have, GENERATED), ['CALLBACK_SECRET'])
})

test('an empty list on a fresh Worker creates both generated secrets', () => {
  assert.deepEqual(generatedSecretsToCreate(parseSecretList(true, '[]'), GENERATED), GENERATED)
})

test('a failed or unreadable list never creates a generated secret', () => {
  const unreadable = [
    parseSecretList(false, '[]'), // non-zero exit
    parseSecretList(true, ''), // nothing printed
    parseSecretList(true, '✘ [ERROR] Not logged in.'), // an error, not a list
    parseSecretList(true, '[{"name": "CHANNEL_SECR'), // cut off
    parseSecretList(true, '{"error": "network"}'), // not an array
    parseSecretList(true, '[1, 2]'), // not secrets
  ]
  for (const have of unreadable) {
    assert.equal(have, null)
    assert.throws(() => generatedSecretsToCreate(have, GENERATED), /could not read/)
  }
})

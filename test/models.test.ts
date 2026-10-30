// Model choice: `!model opus|sonnet|haiku` per thread, aliases in src/models.ts, default opus.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_MODEL, modelId, MODELS, parseModelCommand, resolveModel } from '../src/models.ts'

test('the three aliases map to their model ids, and the default is opus', () => {
  assert.deepEqual(MODELS, { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5' })
  assert.equal(DEFAULT_MODEL, 'opus')
})

test('parses the command, case-insensitively, with or without a model', () => {
  assert.deepEqual(parseModelCommand('!model sonnet'), { kind: 'set', alias: 'sonnet' })
  assert.deepEqual(parseModelCommand('  !MODEL Haiku  '), { kind: 'set', alias: 'haiku' })
  assert.deepEqual(parseModelCommand('!model'), { kind: 'show' })
  assert.deepEqual(parseModelCommand('!model gpt'), { kind: 'unknown', given: 'gpt' })
})

test('a message that is not only the command runs as a normal turn', () => {
  assert.equal(parseModelCommand('!model sonnet and fix the bug'), null)
  assert.equal(parseModelCommand('which !model is this?'), null)
  assert.equal(parseModelCommand('!models'), null)
  assert.equal(parseModelCommand('hello'), null)
})

test('the thread pick wins, then the channel default, then opus', () => {
  assert.equal(resolveModel('haiku', 'sonnet'), 'haiku')
  assert.equal(resolveModel(undefined, 'sonnet'), 'sonnet')
  assert.equal(resolveModel(null, null), 'opus')
  assert.equal(resolveModel('toString', 'constructor'), 'opus')
})

test('an unknown or missing alias runs on the default model', () => {
  assert.equal(modelId('sonnet'), 'claude-sonnet-5-5')
  assert.equal(modelId(undefined), 'claude-opus-5-5')
  assert.equal(modelId('__proto__'), 'claude-opus-5-5')
})

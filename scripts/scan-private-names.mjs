#!/usr/bin/env node
// Fails if a secret or a private name is in the repo: every tracked file AND every commit in history.
// Runs in CI on every PR, and must pass before the repo is made public.
//
//   npm run scan

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const SELF = 'scripts/scan-private-names.mjs'

// Built from parts so this file does not match itself.
const j = (...parts) => new RegExp(parts.join(''), 'i')
const RULES = [
  // Secrets
  ['Slack token', /xox[abpr]-[0-9A-Za-z-]{10,}/],
  ['Anthropic key', /sk-ant-[0-9A-Za-z_-]{10,}/],
  ['E2B or Impello key', /\b(e2b|imp)_[0-9a-f]{20,}/],
  ['GitHub token', /\bgh[pousr]_[0-9A-Za-z]{20,}/],
  ['Claude OAuth token', /sk-ant-oat[0-9A-Za-z_-]+/],
  ['private key block', j('-----BEGIN ', '(RSA |EC |OPENSSH )?PRIVATE KEY-----', '[\\s\\S]{20}')],
  // Private infrastructure this repo was made from
  ['private org', j('21', '[- ]?dreams')],
  ['private repo', j('dream', '-team')],
  ['private service', j('agents\\.', '21')],
  ['private agent internals', j('percy', '-(agent|memory|[0-9])')],
  ['private agent', j('joe', 'star')],
  ['private product', j('hyper', 'whisper|agent', 'stack')],
  ['private account', j('ray', '-?amjad')],
  ['private secret store', j('infis', 'ical')],
  ['private Impello host', j('build-1|impello', '-infra')],
  // Real Slack ids (channels, users, teams). Example ids in docs use X's, which this skips.
  ['Slack id', /\b[CUTGDW]0[A-Z0-9]{8,10}\b/],
]

function scan(label, text, hits) {
  for (const [name, re] of RULES) {
    const m = text.match(re)
    if (m) hits.push(`${label}: ${name}: "${m[0].slice(0, 40)}"`)
  }
}

const hits = []
const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean)
for (const file of files) {
  if (file === SELF || file === 'package-lock.json') continue
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    continue
  }
  scan(file, text, hits)
}

// History: every line ever added, in any commit. A secret removed later is still public.
let history = ''
try {
  history = execFileSync('git', ['log', '--all', '-p', '--no-color', '--', '.', `:!${SELF}`, ':!package-lock.json'], {
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
  })
} catch {
  // no commits yet
}
for (const [i, chunk] of history.split(/^commit /m).entries()) {
  const added = chunk.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).join('\n')
  scan(`history commit ${chunk.slice(0, 12) || i}`, added, hits)
}

if (hits.length) {
  console.error(`Found ${hits.length} private name(s) or secret(s):\n  ${[...new Set(hits)].join('\n  ')}`)
  process.exit(1)
}
console.log(`scan clean: ${files.length} files and all history`)

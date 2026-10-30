#!/usr/bin/env node
// Setup, two ways:
//
//   npm run setup                         asks you questions (for a person at a terminal)
//   npm run setup -- --file .env.setup    reads the answers from a file (for your coding agent; see SETUP.md)
//
// Either way it builds the sandbox template, deploys the Worker and stores each secret with
// `wrangler secret put`. It never prints a secret. Every step is safe to repeat, so run it again
// after you add a missing value; it ends by printing what is still to do.

import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { stdin, stdout } from 'node:process'
import { createInterface } from 'node:readline/promises'
import { normaliseUiHost } from '../src/ui.ts'
import { parseEnvFile, setEnvLine, webhookSecretPlan } from './env-file.ts'
import { generatedSecretsToCreate, parseSecretList } from './secret-list.ts'

const WRANGLER = ['npx', '--yes', 'wrangler']
const QUEUE = 'slack-agent-turns'
// Must match wrangler.jsonc.
const BUCKET = 'slack-agent-transcripts'
const DATABASE = 'slack-agent'
const fileArg = process.argv.indexOf('--file')
const FILE = fileArg !== -1 ? process.argv[fileArg + 1] : null
const SKIP_TEMPLATE = process.argv.includes('--skip-template')

const bold = (s) => `\x1b[1m${s}\x1b[0m`
const dim = (s) => `\x1b[2m${s}\x1b[0m`
const step = (s) => console.log(`\n${bold('==')} ${s}`)

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: opts.capture ? ['inherit', 'pipe', 'pipe'] : 'inherit', encoding: 'utf8', ...opts })
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, stdout: r.stdout ?? '' }
}
const wrangler = (args, opts) => run(WRANGLER[0], [...WRANGLER.slice(1), ...args], opts)

function putSecret(name, value) {
  const r = spawnSync(WRANGLER[0], [...WRANGLER.slice(1), 'secret', 'put', name], { input: value, stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8' })
  if (r.status !== 0) {
    // Only wrangler's last line: it names the problem and never holds the value.
    console.error(`NEXT: could not store ${name} (${(r.stderr || r.stdout || '').trim().split('\n').pop()}). Check \`npx wrangler whoami\` works, then run setup again.`)
    process.exit(1)
  }
  console.log(`  stored ${name}`)
}

/** Removes a secret. CI=1 answers wrangler's "Are you sure?" with yes. */
function deleteSecret(name) {
  const r = wrangler(['secret', 'delete', name], { capture: true, env: { ...process.env, CI: '1' } })
  if (!r.ok) {
    console.error(`NEXT: could not delete the old ${name} (${r.out.trim().split('\n').pop()}). Run \`npx wrangler secret delete ${name}\`, then run setup again.`)
    process.exit(1)
  }
  console.log(`  deleted the old ${name}`)
}

/** The Worker's secret names, or null when they could not be read. Never an empty set on failure. */
function existingSecrets() {
  const r = wrangler(['secret', 'list', '--format', 'json'], { capture: true })
  return parseSecretList(r.ok, r.stdout)
}

function getVar(name) {
  return readFileSync('wrangler.jsonc', 'utf8').match(new RegExp(`"${name}":\\s*"([^"]*)"`))?.[1] ?? null
}

function setVar(name, value) {
  const path = 'wrangler.jsonc'
  const text = readFileSync(path, 'utf8')
  writeFileSync(path, text.replace(new RegExp(`("${name}":\\s*)"[^"]*"`), `$1"${value}"`))
}

/** The Worker's routes in wrangler.jsonc. Only the UI's custom domain ever goes here; Slack uses workers.dev. */
function setRoutes(routes) {
  const path = 'wrangler.jsonc'
  const text = readFileSync(path, 'utf8')
  writeFileSync(path, text.replace(/("routes":\s*)\[[^\]]*\]/, `$1${JSON.stringify(routes)}`))
}

function findDatabaseId(name) {
  const r = wrangler(['d1', 'list', '--json'], { capture: true })
  try {
    const list = JSON.parse(r.out.slice(r.out.indexOf('[')))
    return list.find((d) => d.name === name)?.uuid ?? null
  } catch {
    return null
  }
}

function setDatabaseId(id) {
  const path = 'wrangler.jsonc'
  const text = readFileSync(path, 'utf8')
  writeFileSync(path, text.replace(/("database_id":\s*)"[^"]*"/, `$1"${id}"`))
}

// ---------------------------------------------------------------------------------------------
// Answers: from the file, or from questions.

let rl
let answers
if (FILE) {
  if (!existsSync(FILE)) {
    console.error(`${FILE} does not exist. Copy .env.setup.example to ${FILE} and fill it in.`)
    process.exit(1)
  }
  answers = parseEnvFile(readFileSync(FILE, 'utf8'))
} else {
  rl = createInterface({ input: stdin, output: stdout })
  answers = await askEverything()
}

const provider = (answers.SANDBOX_PROVIDER ?? '').toLowerCase()
if (provider !== 'e2b' && provider !== 'impello') {
  console.error('NEXT: set SANDBOX_PROVIDER to "e2b" or "impello", then run again.')
  process.exit(1)
}
const claudeName = answers.ANTHROPIC_API_KEY ? 'ANTHROPIC_API_KEY' : answers.CLAUDE_CODE_OAUTH_TOKEN ? 'CLAUDE_CODE_OAUTH_TOKEN' : null
const missing = [...(answers.SANDBOX_API_KEY ? [] : ['SANDBOX_API_KEY']), ...(claudeName ? [] : ['CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY'])]
if (missing.length) {
  console.error(`NEXT: fill in ${missing.join(', ')}${FILE ? ` in ${FILE}` : ''}, then run again.`)
  process.exit(1)
}

// ---------------------------------------------------------------------------------------------
step('Cloudflare login')
const whoami = wrangler(['whoami'], { capture: true })
if (!whoami.ok || /not authenticated|not logged in/i.test(whoami.out)) {
  if (FILE) {
    console.error('NEXT: not logged in to Cloudflare. The human runs `npx wrangler login` (it opens a browser), then run setup again.')
    process.exit(1)
  }
  wrangler(['login'])
}
console.log(dim('  Workers Paid must be on: dash.cloudflare.com > Workers & Pages > Plans.'))

step(`Sandbox template on ${provider}`)
setVar('SANDBOX_PROVIDER', provider)
if (SKIP_TEMPLATE) {
  console.log('  skipped (--skip-template)')
} else {
  const build = run('npm', ['run', '-s', 'template:build'], {
    env: { ...process.env, SANDBOX_PROVIDER: provider, SANDBOX_API_KEY: answers.SANDBOX_API_KEY },
  })
  if (!build.ok) {
    console.error('NEXT: the template build failed. Check SANDBOX_PROVIDER and SANDBOX_API_KEY, then run again.')
    process.exit(1)
  }
}

// The memory repo is a plain var (not a secret), so it goes into wrangler.jsonc before the deploy.
const MEMORY_REPO_RE = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/
const memoryRepo = (answers.MEMORY_REPO ?? '').replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/$/, '')
const memoryRepoOk = MEMORY_REPO_RE.test(memoryRepo)
if (memoryRepoOk) setVar('MEMORY_REPO', memoryRepo)

// The web UI's own host (rule 5 in src/ui.ts): a custom domain on a zone in the human's Cloudflare
// account, attached by the deploy below. Access cannot cover only /ui on workers.dev, so the UI never
// lives there; Slack and GitHub stay on workers.dev. Unset, /ui refuses everyone.
const uiHost = normaliseUiHost(answers.UI_HOST)
if (uiHost) {
  setVar('UI_HOST', uiHost)
  setRoutes([{ pattern: uiHost, custom_domain: true }])
}

// The web UI's Cloudflare Access application (README, "Web UI"): plain vars too. Made for UI_HOST,
// so after it exists. Unset, /ui refuses everyone (src/access.ts).
const accessTeam = (answers.ACCESS_TEAM_DOMAIN ?? '').trim().toLowerCase().replace(/^https:\/\//, '').replace(/\/+$/, '')
const accessAud = (answers.ACCESS_AUD ?? '').trim()
const accessOk = /^[a-z0-9-]{1,63}(\.cloudflareaccess\.com)?$/.test(accessTeam) && /^[A-Za-z0-9]{16,128}$/.test(accessAud)
if (accessOk) {
  setVar('ACCESS_TEAM_DOMAIN', accessTeam)
  setVar('ACCESS_AUD', accessAud)
}

step('Queue, bucket, database and Worker')
const queue = wrangler(['queues', 'create', QUEUE], { capture: true })
if (!queue.ok && !/already exists|already taken|11009/i.test(queue.out)) {
  console.error(queue.out)
  console.error('NEXT: could not create the queue. Check that Workers Paid is on for this Cloudflare account.')
  process.exit(1)
}

// The transcript backups. No lifecycle rule: they are kept forever (see the README on cost).
const bucket = wrangler(['r2', 'bucket', 'create', BUCKET], { capture: true })
if (!bucket.ok && !/already exists|already own|10004/i.test(bucket.out)) {
  console.error(bucket.out)
  console.error('NEXT: could not create the R2 bucket. Open R2 once in the Cloudflare dashboard to turn it on, then run again.')
  process.exit(1)
}
console.log(`  R2 bucket ${BUCKET} ready`)

const db = wrangler(['d1', 'create', DATABASE], { capture: true })
if (!db.ok && !/already exists|7502/i.test(db.out)) {
  console.error(db.out)
  console.error('NEXT: could not create the D1 database. Fix the error above, then run again.')
  process.exit(1)
}
const databaseId = findDatabaseId(DATABASE)
if (!databaseId) {
  console.error(`NEXT: created the D1 database, but \`wrangler d1 list\` does not show ${DATABASE}. Run setup again.`)
  process.exit(1)
}
setDatabaseId(databaseId)
// CI=1 answers wrangler's "Ok to proceed?" for us. Applied migrations are skipped, so this repeats safely.
const migrate = wrangler(['d1', 'migrations', 'apply', DATABASE, '--remote'], { capture: true, env: { ...process.env, CI: '1' } })
if (!migrate.ok) {
  console.error(migrate.out)
  console.error('NEXT: the database migrations failed. Fix the error above, then run again.')
  process.exit(1)
}
console.log(`  D1 database ${DATABASE} ready, migrations applied`)

// The deploy also sets the Cron Trigger in wrangler.jsonc (routines, every minute); a redeploy keeps it.
function deployWorker() {
  const deploy = wrangler(['deploy'], { capture: true })
  if (deploy.ok) return deploy
  console.error(deploy.out)
  if (uiHost) {
    console.error(
      `NEXT: if the error above is about ${uiHost}: UI_HOST must be a hostname on a domain (zone) in this Cloudflare account, ` +
        'with no DNS record of its own yet; the deploy makes one. Fix UI_HOST, or empty it and set "routes" in wrangler.jsonc back to [], then run again.',
    )
  }
  console.error(
    'NEXT: the deploy failed; read the error above. A new Cloudflare account may first need a workers.dev subdomain ' +
      '(the human opens dash.cloudflare.com > Workers & Pages once and picks one). Fix it, then run setup again.',
  )
  process.exit(1)
}
const deploy = deployWorker()
const workerUrl = deploy.out.match(/https:\/\/[^\s]+\.workers\.dev/)?.[0]
console.log(`  deployed: ${workerUrl ?? '(no workers.dev URL in the output; find it in the Cloudflare dashboard)'}`)
// A routine made on the web UI reports back to WORKER_URL, never to UI_HOST (rule 6 in src/ui.ts).
// The address is only known after the first deploy, so a new or changed one costs one more deploy.
if (workerUrl && getVar('WORKER_URL') !== workerUrl) {
  setVar('WORKER_URL', workerUrl)
  deployWorker()
  console.log(`  WORKER_URL set to ${workerUrl}`)
}

step('Secrets')
// Generated once, and only when the secret list was read and does not name them. CALLBACK_SECRET:
// replacing it would cut off any turn that is running right now. CHANNEL_SECRETS_KEY encrypts
// per-channel secrets (src/channels.ts): replacing it would make every channel secret already
// stored unreadable, for good. So a failed `wrangler secret list` stops setup here.
// GITHUB_WEBHOOK_SECRET is made here too unless the human gave one (scripts/env-file.ts); a stored
// one is kept, because GitHub already signs with it.
let toGenerate
let webhookPlan
let have
try {
  have = existingSecrets()
  toGenerate = generatedSecretsToCreate(have, ['CALLBACK_SECRET', 'CHANNEL_SECRETS_KEY'])
  webhookPlan = webhookSecretPlan(answers.GITHUB_WEBHOOK_SECRET, have)
} catch {
  console.error('NEXT: `wrangler secret list` failed or printed something setup cannot read, so no secret was written. Check `npx wrangler secret list` works (and `npx wrangler whoami`), then run setup again.')
  process.exit(1)
}
putSecret('SANDBOX_API_KEY', answers.SANDBOX_API_KEY)
putSecret(claudeName, answers[claudeName])
// The Worker prefers ANTHROPIC_API_KEY when both are stored (src/env.ts claudeAuth), so switching to
// a plan token only works once the old key is gone. The reverse is deleted too, to keep one sign-in.
const otherClaude = claudeName === 'ANTHROPIC_API_KEY' ? 'CLAUDE_CODE_OAUTH_TOKEN' : 'ANTHROPIC_API_KEY'
if (have.has(otherClaude)) deleteSecret(otherClaude)
for (const name of toGenerate) putSecret(name, randomBytes(32).toString('hex'))

const next = []
if (workerUrl) {
  writeFileSync('slack-manifest.local.json', readFileSync('slack-manifest.json', 'utf8').replaceAll('https://YOUR-WORKER.workers.dev', workerUrl))
}
if (answers.SLACK_SIGNING_SECRET && answers.SLACK_BOT_TOKEN) {
  putSecret('SLACK_SIGNING_SECRET', answers.SLACK_SIGNING_SECRET)
  putSecret('SLACK_BOT_TOKEN', answers.SLACK_BOT_TOKEN)
} else {
  next.push(
    'The human creates the Slack app: https://api.slack.com/apps > Create New App > From a manifest > pick the workspace > ' +
      'paste the contents of slack-manifest.local.json > Create > Install to Workspace. Then they put the Signing Secret ' +
      '(Basic Information page) into SLACK_SIGNING_SECRET and the Bot User OAuth Token, xoxb-... (OAuth & Permissions page), ' +
      'into SLACK_BOT_TOKEN, and you run setup again.',
  )
}

// The GitHub App is REQUIRED: the bot keeps its memory in a repo it reaches through the App. A turn
// refuses to start until the App and MEMORY_REPO are set (src/github.ts githubMissing).
if (answers.GITHUB_APP_ID && answers.GITHUB_APP_PRIVATE_KEY_PATH) {
  if (!existsSync(answers.GITHUB_APP_PRIVATE_KEY_PATH)) {
    next.push(`GITHUB_APP_PRIVATE_KEY_PATH is ${answers.GITHUB_APP_PRIVATE_KEY_PATH}, and no file is there. Fix the path and run again.`)
  } else {
    putSecret('GITHUB_APP_ID', answers.GITHUB_APP_ID)
    putSecret('GITHUB_APP_PRIVATE_KEY', readFileSync(answers.GITHUB_APP_PRIVATE_KEY_PATH, 'utf8'))
    if (answers.GITHUB_INSTALLATION_ID) putSecret('GITHUB_INSTALLATION_ID', answers.GITHUB_INSTALLATION_ID)
  }
} else {
  next.push(
    'The human creates the GitHub App (README, "GitHub App"; it is required) and installs it on the memory repo and ' +
      'the repos the bot may work in. Then they fill in GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY_PATH, and you run setup again.',
  )
}
// The App's webhook wakes the thread that opened a PR (src/pr-follow.ts). GitHub needs the same
// string in the App's Webhook settings. Setup never prints a secret, so a generated one goes into the
// git-ignored answers file, written BEFORE it is stored: if storing fails, the next run stores the
// same string from the file.
const webhookUrl = `${workerUrl ?? '<worker URL>'}/github/webhook`
if (webhookPlan === 'use') {
  putSecret('GITHUB_WEBHOOK_SECRET', answers.GITHUB_WEBHOOK_SECRET)
} else if (webhookPlan === 'generate') {
  const secretFile = FILE ?? '.env.setup'
  const value = randomBytes(32).toString('hex')
  writeFileSync(secretFile, setEnvLine(existsSync(secretFile) ? readFileSync(secretFile, 'utf8') : '', 'GITHUB_WEBHOOK_SECRET', value), { mode: 0o600 })
  putSecret('GITHUB_WEBHOOK_SECRET', value)
  next.push(
    `Setup made the GitHub webhook secret and wrote it into GITHUB_WEBHOOK_SECRET in ${secretFile} (git-ignored; do not read it aloud). ` +
      `When the human makes or edits the GitHub App (README, "GitHub App", step 2), they keep Webhook Active, set the Webhook URL to ` +
      `${webhookUrl}, and copy that line's value from ${secretFile} into the Webhook secret field themselves. Until then the bot opens PRs but is never woken by them.`,
  )
}
if (!memoryRepoOk) {
  next.push(
    (answers.MEMORY_REPO ? `MEMORY_REPO is "${answers.MEMORY_REPO}", which is not owner/name. ` : '') +
      'The human creates a PRIVATE GitHub repo for the bot\'s memory (for example my-bot-memory) with a README, and ' +
      'installs the GitHub App on it. Put it in MEMORY_REPO as owner/name and run setup again.',
  )
}

if (!uiHost) {
  next.push(
    (answers.UI_HOST ? `UI_HOST is "${answers.UI_HOST}", which is not a hostname setup can use (a workers.dev host cannot be one). ` : '') +
      'The web UI is optional, and the bot works without it. It needs its own hostname on a domain the human has in this ' +
      'Cloudflare account (README, "Web UI"), because Cloudflare Access cannot put only /ui behind sign-in on workers.dev: ' +
      'its workers.dev switch covers the whole address and would lock Slack and GitHub out, so leave that switch off. ' +
      'If they have such a domain, put a new subdomain of it into UI_HOST (for example agent.example.com) and run setup again. ' +
      'Until then the web UI answers "not set up", and the Follow along and App Home links are left out.',
  )
} else if (!accessOk) {
  next.push(
    ((answers.ACCESS_TEAM_DOMAIN || answers.ACCESS_AUD) ? 'ACCESS_TEAM_DOMAIN or ACCESS_AUD is not in the right form. ' : '') +
      `The human puts the web UI behind Cloudflare Access (README, "Web UI"): Zero Trust > Access > Applications > Add an application > ` +
      `Self-hosted, hostname ${uiHost} (the whole host; leave the path empty), with a policy that allows only their own email. ` +
      'Slack and GitHub stay on workers.dev, so this does not touch them. They put its Application Audience (AUD) Tag into ACCESS_AUD and the team domain ' +
      '(Zero Trust > Settings, <team>.cloudflareaccess.com) into ACCESS_TEAM_DOMAIN, and you run setup again. Until then the ' +
      'web UI answers "not set up", and the Follow along and App Home links are left out.',
  )
}

rl?.close()
console.log(`\n${bold('Setup ran.')} Worker: ${workerUrl ?? '?'}${uiHost ? `  Web UI: https://${uiHost}/ui/` : ''}`)
if (next.length) {
  for (const n of next) console.log(`NEXT: ${n}`)
} else {
  console.log("NEXT: the Slack app's Event Subscriptions page must show the Request URL as Verified (click Retry if not).")
  console.log('NEXT: invite the bot to a channel (/invite @percy-jr) and @mention it. Watch it with `npx wrangler tail`.')
}

// ---------------------------------------------------------------------------------------------
// Interactive mode.

async function askEverything() {
  console.log(bold('\nSlack agent setup\n'))
  console.log('You need: Cloudflare on Workers Paid ($5/month), a Slack workspace where you can install apps,')
  console.log('and a Claude plan or an Anthropic API key. Tip: your coding agent can do this for you; see SETUP.md.')
  const a = {}

  a.SANDBOX_PROVIDER = await choose('\nWhich sandbox provider do you want to use?', [
    { label: 'E2B', hint: 'e2b.dev, $100 free credit when you sign up', value: 'e2b' },
    { label: 'Impello', hint: 'impello.ai, 7-day free trial', value: 'impello' },
  ])
  console.log(a.SANDBOX_PROVIDER === 'e2b' ? 'Make a key at https://e2b.dev/dashboard.' : 'Make a key at https://dashboard.impello.ai (API Keys tab).')
  a.SANDBOX_API_KEY = await askHidden('Paste the API key:')

  const claude = await choose('\nHow should the bot sign in to Claude?', [
    { label: 'My Claude Pro or Max plan', hint: '`claude setup-token`; only YOU should use the bot', value: 'oauth' },
    { label: 'An Anthropic API key', hint: 'pay per use; the right choice for a team', value: 'api' },
  ])
  if (claude === 'oauth') {
    console.log("Anthropic's terms allow a plan token for your own use of Claude Code. Keep the bot in a workspace or")
    console.log('channel only you use. If other people will use it, pick the API key instead.')
    a.CLAUDE_CODE_OAUTH_TOKEN = await askHidden('Run `claude setup-token` in another terminal and paste the token:')
  } else {
    a.ANTHROPIC_API_KEY = await askHidden('Paste the API key:')
  }

  console.log('\nThe Slack app needs your Worker URL, which exists after the first deploy.')
  console.log('Skip these on the first run. Setup then tells you how to make the app, and you run it again.')
  a.SLACK_SIGNING_SECRET = await askHidden('Slack Signing Secret (Enter to skip):')
  a.SLACK_BOT_TOKEN = await askHidden('Slack Bot User OAuth Token (Enter to skip):')

  console.log('\nThe GitHub App is required: the bot keeps its memory in a private repo it reaches through the App.')
  console.log('See "GitHub App" in the README. Press Enter to skip for now; setup then tells you what is left.')
  a.GITHUB_APP_ID = (await rl.question('App ID: ')).trim()
  a.GITHUB_APP_PRIVATE_KEY_PATH = (await rl.question('Path to the private key (.pem): ')).trim()
  a.MEMORY_REPO = (await rl.question('Memory repo, owner/name (for example you/my-bot-memory): ')).trim()
  console.log('\nThe GitHub App\'s Webhook secret. Press Enter and setup makes one and writes it into .env.setup')
  console.log('(git-ignored) for you to copy into the App. Type one only if the App already has a secret you chose.')
  a.GITHUB_WEBHOOK_SECRET = await askHidden('GitHub App webhook secret (Enter to have setup make one):')

  console.log('\nThe web UI is optional. It needs its own hostname on a domain you have in Cloudflare, for example')
  console.log('agent.example.com, behind Cloudflare Access (README, "Web UI"). Skip these if you have no such domain.')
  a.UI_HOST = (await rl.question('Web UI hostname (Enter to skip): ')).trim()
  a.ACCESS_TEAM_DOMAIN = (await rl.question('Access team domain, <team>.cloudflareaccess.com (Enter to skip): ')).trim()
  a.ACCESS_AUD = (await rl.question('Access application AUD tag (Enter to skip): ')).trim()
  return a
}

async function choose(question, options) {
  console.log(question)
  options.forEach((o, i) => console.log(`  ${bold(String(i + 1))}) ${o.label}${o.hint ? dim(`  ${o.hint}`) : ''}`))
  for (;;) {
    const n = Number(await rl.question('Pick a number: '))
    if (options[n - 1]) return options[n - 1].value
  }
}

/** Reads a line without echoing it, for keys and tokens. */
async function askHidden(question) {
  stdout.write(`${question} ${dim('(hidden)')} `)
  rl.pause()
  stdin.setRawMode?.(true)
  stdin.resume()
  let value = ''
  return await new Promise((resolve) => {
    const onData = (buf) => {
      for (const ch of buf.toString('utf8')) {
        if (ch === '\r' || ch === '\n') {
          stdin.off('data', onData)
          stdin.setRawMode?.(false)
          stdout.write('\n')
          rl.resume()
          return resolve(value.trim())
        }
        if (ch === '\u0003') process.exit(130)
        if (ch === '\u007f') value = value.slice(0, -1)
        else value += ch
      }
    }
    stdin.on('data', onData)
  })
}

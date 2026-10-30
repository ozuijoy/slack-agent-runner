// Builds template/Dockerfile into a sandbox template on E2B or Impello.
//
//   SANDBOX_PROVIDER=e2b     SANDBOX_API_KEY=e2b_... npm run template:build
//   SANDBOX_PROVIDER=impello SANDBOX_API_KEY=imp_... npm run template:build
//
// `npm run setup` runs this for you. Run it again only when you change the Dockerfile.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const provider = (process.env.SANDBOX_PROVIDER ?? '').toLowerCase()
const apiKey = process.env.SANDBOX_API_KEY
const name = process.env.SANDBOX_TEMPLATE || 'slack-agent'

if (provider !== 'e2b' && provider !== 'impello') {
  console.error('Set SANDBOX_PROVIDER to "e2b" or "impello".')
  process.exit(1)
}
if (!apiKey) {
  console.error(`Set SANDBOX_API_KEY to your ${provider === 'e2b' ? 'E2B' : 'Impello'} API key.`)
  process.exit(1)
}

// The two SDKs share one builder API. Impello keeps its builder on a subpath so the Worker bundle
// does not carry it.
const { Template } =
  provider === 'e2b' ? await import('e2b') : ((await import('@impello/sdk/template')) as unknown as typeof import('e2b'))
const conn = provider === 'e2b' ? { apiKey } : { apiKey, domain: 'sandbox.impello.ai' }

// The context must be given explicitly: the SDK's default is the CALLING script's folder.
const context = join(dirname(fileURLToPath(import.meta.url)), '..', 'template')

console.log(`Building template "${name}" on ${provider}. The first build takes a few minutes.`)
// The Dockerfile's text, not its path: a path is resolved against the process's folder, not the context.
const dockerfile = readFileSync(join(context, 'Dockerfile'), 'utf8')
await Template.build(Template({ fileContextPath: context }).fromDockerfile(dockerfile), name, {
  ...conn,
  cpuCount: 2,
  memoryMB: 4096,
  onBuildLogs: (log: unknown) => console.log(String(log)),
})

console.log(`\nDone. Template "${name}" is ready on ${provider}.`)

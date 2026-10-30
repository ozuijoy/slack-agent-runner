import type { ThreadState } from './thread-state.ts'
import type { TurnJob } from './turn.ts'

/**
 * Everything the Worker reads from Cloudflare. Secrets are set with `wrangler secret put`
 * (`npm run setup` does it for you); vars live in wrangler.jsonc.
 */
export interface Env {
  THREADS: DurableObjectNamespace<ThreadState>
  TURNS: Queue<TurnJob>
  /** Routines, channel settings and the transcript index. Tables: migrations/. */
  DB: D1Database
  /** Every turn's Claude transcript, kept forever (src/transcripts.ts). */
  TRANSCRIPTS: R2Bucket

  // Slack app (Basic Information and OAuth & Permissions pages)
  SLACK_SIGNING_SECRET: string
  SLACK_BOT_TOKEN: string

  // Sandbox provider
  SANDBOX_PROVIDER: string
  SANDBOX_API_KEY: string
  SANDBOX_TEMPLATE: string

  // Claude: set ONE of these. See the README on which to pick.
  CLAUDE_CODE_OAUTH_TOKEN?: string
  ANTHROPIC_API_KEY?: string

  // Signs the token a sandbox uses to post its reply back. Any long random string.
  CALLBACK_SECRET: string

  // Encrypts per-channel secrets in D1 (src/channels.ts). 64 hex characters, made once by
  // `npm run setup`. Changing it makes every stored channel secret unreadable.
  CHANNEL_SECRETS_KEY?: string

  // GitHub App, REQUIRED. The bot's memory lives in a repo it reaches through the App, and the
  // same App lets it open pull requests. A turn refuses to start without it (src/github.ts).
  GITHUB_APP_ID: string
  GITHUB_APP_PRIVATE_KEY: string
  GITHUB_INSTALLATION_ID?: string
  /**
   * Checks GitHub's webhook deliveries (src/pr-follow.ts rule 2): the same string is the App's
   * Webhook secret. Unset, the webhook refuses everything and no PR is ever followed.
   */
  GITHUB_WEBHOOK_SECRET?: string
  /** The memory repo, `owner/name` (a var in wrangler.jsonc). One folder per channel: src/memory.ts. */
  MEMORY_REPO: string

  /**
   * The web UI's Cloudflare Access application (src/access.ts): the Zero Trust team domain and the
   * application's AUD tag. Vars in wrangler.jsonc. Either empty, the UI refuses every request.
   */
  ACCESS_TEAM_DOMAIN?: string
  ACCESS_AUD?: string
  /**
   * The web UI's own hostname, a custom domain on this Worker (for example agent.example.com). Access
   * cannot cover only /ui on workers.dev, so the UI lives here and Slack stays on workers.dev
   * (rule 5 in src/ui.ts). Empty, the UI is not set up.
   */
  UI_HOST?: string
  /**
   * The Worker's workers.dev address, `https://<name>.<subdomain>.workers.dev`, written by `npm run
   * setup` from the deploy output. A routine made on the web UI reports back here (rule 6 in
   * src/ui.ts). Empty, the UI cannot make routines.
   */
  WORKER_URL?: string

  MAX_TURN_MINUTES: string
  IDLE_PAUSE_MINUTES: string
}

export function maxTurnMs(env: Env) {
  return minutes(env.MAX_TURN_MINUTES, 45)
}

export function idlePauseMs(env: Env) {
  return minutes(env.IDLE_PAUSE_MINUTES, 5)
}

function minutes(value: string | undefined, fallback: number) {
  const n = Number(value)
  return (Number.isFinite(n) && n > 0 ? n : fallback) * 60_000
}

/** The Claude credential to hand the sandbox, or a sentence saying what is missing. */
export function claudeAuth(env: Env): { envs: Record<string, string> } | { missing: string } {
  if (env.ANTHROPIC_API_KEY) return { envs: { ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY } }
  if (env.CLAUDE_CODE_OAUTH_TOKEN) return { envs: { CLAUDE_CODE_OAUTH_TOKEN: env.CLAUDE_CODE_OAUTH_TOKEN } }
  return { missing: 'Set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY with `npx wrangler secret put`.' }
}

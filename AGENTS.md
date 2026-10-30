# Slack Agent Starter

A Cloudflare Worker that runs Claude Code in a per-thread cloud sandbox (E2B or Impello) and
replies in Slack. The README explains the design; read it first.

**If you were asked to set this repo up, follow SETUP.md step by step.** Never ask the human to
paste a secret into the chat; secrets go in `.env.setup`.

- Run `npm test`, `npm run typecheck` and `npm run scan` before you commit.
- `src/thread.ts` holds the thread rules as plain functions. Change the rules there and add a test in
  `test/thread.test.ts`; `src/thread-state.ts` only stores data and calls them.
- Mid-turn follow-ups (rule 7 in `src/thread.ts`) are never lost: one counts as answered only when
  the sandbox says Claude took it AND the turn answered; every other path puts it back in `pending`.
  Keep it that way. The sandbox half is `box/inbox.mjs` + `box/inbox-hook.mjs` (`test/inbox.test.ts`,
  and `test/run-turn.test.ts` runs it end to end).
- Model aliases (`!model opus|sonnet|haiku`) and their ids live only in `src/models.ts`.
- D1 tables are made by numbered SQL files in `migrations/`; add a new file, never edit an applied
  one. `npm run setup` applies them. Query through `src/db.ts`, always with bound `?` values.
- Every sandbox-to-Worker door (`/sandbox/callback`, `/sandbox/transcript`, `/sandbox/progress`,
  `/sandbox/memory`, `/sandbox/upload`, `/sandbox/canvas`, `/sandbox/search`, `/sandbox/routines`, `/sandbox/follow-pr`, `/sandbox/code-channel`, `/sandbox/file`) checks a signed token and builds every key,
  channel and thread from the token's claims, never from the request body. Each token purpose signs
  with its own key (`src/callback-token.ts`): `reply` (the runner's; kept out of Claude's env, but Claude shares its uid and sudo, so it is no wall: a transcript backup is write-once for that reason),
  `tools` (Claude's, for upload, canvas, search, routines, follow-pr and code-channel), `file` (one grant per Slack file, `src/files.ts`). Text a sandbox sends for Slack is capped and escaped (`src/status.ts`).
- Slack's own routes (`/slack/events`, `/slack/interactive`) check the signing secret before reading
  the body. The Stop button only marks the turn (rule 6 in `src/thread.ts`); the sandbox ends it.
- Never put the Slack bot token, the signing secret, `CALLBACK_SECRET` or `GITHUB_WEBHOOK_SECRET` into a sandbox
  (`test/sandbox-config.test.ts` checks this).
- Sandboxes pause on timeout, never kill: the Claude transcript lives on the sandbox's disk.
- Secrets go in with `npx wrangler secret put`. Never commit `.dev.vars` or a key.
- `scripts/setup.mjs` makes `CALLBACK_SECRET`, `CHANNEL_SECRETS_KEY` and `GITHUB_WEBHOOK_SECRET`
  once, only when it READ the Worker's secret list and they are not on it (`scripts/secret-list.ts`,
  `scripts/env-file.ts`); a failed read stops setup. Never regenerate one over a stored one. The
  webhook secret is written into the git-ignored answers file before it is stored, so the human can
  copy it into the GitHub App; setup never prints a secret. Setup also creates the queue, the R2
  bucket, the D1 database and applies `migrations/`, and every step must stay safe to re-run. A new
  Cloudflare resource goes in `wrangler.jsonc` AND in setup; a new secret or var goes in setup,
  `.env.setup.example`, SETUP.md and the README together.
- `box/` files are written into every sandbox on every turn (`run-turn.mjs` imports `progress.mjs`,
  `inbox.mjs` and `files.mjs` from beside it, and `inbox-hook.mjs` imports `inbox.mjs`; a new box file must be added to the write list in `src/sandbox.ts`). A change there reaches running threads
  on the next deploy; a change to `template/Dockerfile` needs `npm run template:build`.
- Workspace search (`/sandbox/search`, `src/search.ts`) answers from PUBLIC channels only: the bot
  token, `channel_types: public_channel`, and a `conversations.info` check on every result, which
  drops anything Slack does not call a public channel. Slack lets a bot token search only with the
  `action_token` from an @mention or DM event; the thread keeps it (rule 8 in `src/thread.ts`) and it
  never enters the sandbox. Never add a user token for search.
- Channel settings (`src/channels.ts` rules, `src/channel-store.ts` D1): watched channels, the
  channel's default model (rule 9 in `src/thread.ts`), and per-channel secrets. Secrets are set only
  from the web UI, never from Slack; they are AES-GCM encrypted with `CHANNEL_SECRETS_KEY`, bound to
  their channel and name, and handed to a turn by the job's own channel (`src/turn.ts`). In
  `src/sandbox.ts` they are spread FIRST into the runner's envs so no built-in can be overridden,
  and reserved names are refused (`checkSecretName`). Never return a value to a page or a log.
- Memory (`src/memory.ts`, `src/memory-store.ts`, `box/memory.mjs`) is Claude Code's own auto memory
  kept in the `MEMORY_REPO` git repo, one folder per channel. The Worker picks the folder from the
  token's channel and commits through GitHub's API with a token for that repo only; the sandbox never
  gets a token that reaches it (`mintTurnToken` in `src/github.ts` leaves it out). Keep both, or one
  channel could read another's, private ones included. The GitHub App and `MEMORY_REPO` are required
  (`githubMissing`). Do not add a memory skill or recall tool: auto memory already loads the index.
- Routines (`src/routines.ts` rules, `src/routine-store.ts` D1, `src/routine-fire.ts` the sweep,
  `box/tools.mjs routine`): the routine's channel comes from the tools token and every sandbox query
  is scoped to it, so a thread only sees its own channel's routines. The Cron Trigger
  (`triggers.crons` in `wrangler.jsonc`, every minute) claims a run by inserting its
  (routine, due time) row, which the unique key lets through once; it then moves the routine on
  whether or not it won, so a dead sweep never leaves one stuck. Each run posts a new root message
  and starts its turn through the thread's Durable Object (`acceptRoutineRun` in `src/thread.ts`).
  No limits on count or frequency, by decision; do not add any.
- Following PRs (`src/pr-follow.ts` rules, `src/pr-follow-store.ts` D1, `src/pr-follow-fire.ts` the
  webhook and the sweep, `box/tools.mjs follow-pr`): `POST /github/webhook` checks GitHub's
  HMAC-SHA256 over the raw body with `GITHUB_WEBHOOK_SECRET` before reading anything, and refuses
  everything when it is unset. `/sandbox/follow-pr` takes the thread from the tools token and asks
  GitHub that the PR is open and authored by the App's bot (`appBotLogin`), so a thread follows only
  the bot's own PRs and only for itself; never the memory repo. Events from bots never wake a thread.
  The webhook only batches lines in D1 (one conditional `UPDATE`); the every-minute sweep wakes the
  thread through its Durable Object like a mention, at most 3 wakes per PR per UTC day, then posts
  one "stopped auto-fixing" note. Merged or closed posts a note and ends the follow. GitHub's text
  is escaped and fenced as data in the prompt (rule 7); keep it that way.
- Code channels (`src/code-channels.ts` rules, `src/code-channel-door.ts` the Slack side,
  `box/tools.mjs code-channel`) are a Slack BETA. The action set is closed (create, post, view,
  status, archive, summary); never add delete, kick or a generic Slack call. `create` takes its
  origin from the tools token and refuses from inside a code channel, reading the calling channel
  fresh with `conversations.info` and refusing when Slack cannot say (fail closed). `post` writes
  only where `agents.conversations.listViews` answers. `post`, `view`, `status` and `archive` act on
  the body's channel only when Slack's origin for it is the token's thread, or (not archive) the turn
  runs inside it; the lookup fails closed. `summary` posts where Slack's record says the
  channel came from, never where the body says. The Context root Slack posts in a new code channel
  is dropped by `/slack/events` (`isContextRoot`), or a quoted @mention would start a turn. When
  Slack says the feature is off, the thread gets one note (`noteOnce`, rule 10 in `src/thread.ts`)
  and the command prints `NOT AVAILABLE` so Claude carries on in the thread.
- The web UI (`/ui`, `src/ui-routes.ts`, rules in `src/ui.ts`, pages in `ui/`) lives on its own
  custom domain, `UI_HOST` (rule 5 in `src/ui.ts`): Access cannot cover only `/ui` on workers.dev,
  where Slack and GitHub stay. Every UI link uses `uiOrigin(env)`, never the request's origin, and on
  any other host `/ui` only redirects there. It is behind Cloudflare Access, and EVERY `/ui` request (pages, script and API) is checked by `accessIdentity`
  (`src/access.ts`: RS256 against the team's keys, `iss` from `ACCESS_TEAM_DOMAIN`, `aud` =
  `ACCESS_AUD`, time window) before anything else; unset vars refuse everyone. Never add a password,
  cookie or dev-mode bypass. Writes are same-origin JSON POSTs (`checkWrite`). The pages put data on
  the page as text only (no `innerHTML`; `test/ui.test.ts` checks), and the CSP allows only the
  Worker's own scripts. Channel secrets stay write-only: never return a value from the API.
- The transcript page reads the R2 backups (each is the whole session so far, `ui/transcript.js`
  parses it in the browser) and the live turn: the runner sends `liveEntries` (`box/progress.mjs`)
  with each `/sandbox/progress` report, and the thread's Durable Object keeps them under its own
  `live` key, only for the turn running in the token's thread (`src/live.ts`, capped).
- The App Home tab (`src/home.ts`) is seen by everyone in the workspace: it lists only public
  channels (`isPublicChannel`) and the viewer's own DM, never a private channel's threads or routines.

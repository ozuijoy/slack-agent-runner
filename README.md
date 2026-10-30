# Slack Agent Starter

Your own coding agent in Slack. @mention it in a thread, and it runs **Claude Code** in its own
cloud sandbox and replies in the thread. Follow-ups in the thread continue the same conversation.
It remembers what it learns in each channel, in a private GitHub repo you own, and through the
same GitHub App it can clone your repos, open pull requests, and come back to them when CI fails or
someone reviews.

It runs on **Cloudflare Workers**, and the sandbox runs on **E2B** or **Impello** (you pick).

What it does:

- **Threads are conversations.** Each Slack thread gets its own sandbox and Claude session. A
  follow-up sent while it works reaches Claude at its next step (📨), and the one reply covers both.
- **You see it work.** A status message says what Claude is doing, with a **Stop** button and a
  **Follow along** link to the live transcript.
- **Files both ways.** Files you drop in the thread reach Claude; Claude can post files and canvases back.
- **Workspace search**, public channels only.
- **Pick the model** per thread (`!model opus|sonnet|haiku`) or per channel.
- **Memory** per channel, kept in a private GitHub repo you can read and edit.
- **Routines**: "every Monday at 9am, check X" posts a new thread on schedule.
- **Follows its PRs**: a failed check, a review or a comment brings it back to the thread.
- **Code channels** (a Slack beta), **watched channels** (answers without an @mention), and
  per-channel **secrets**.
- **A web UI** behind Cloudflare Access (live transcripts, routines, channels) and a Slack **Home tab**.
- **Every transcript backed up** to R2, kept forever.

```
 Slack ──@mention──▶ Worker ──queue──▶ sandbox (one per thread)
   ▲                  │                    │  claude -p --resume <thread session>
   └──── reply ◀──────┴──◀── callback ─────┘  (posts its own answer back)
```

## What you need

| Thing | Cost | Notes |
|---|---|---|
| Cloudflare account on **Workers Paid** | $5/month | The free plan's CPU limit is too small for the sandbox calls. Setup also makes a D1 database and an R2 bucket (both have a free allowance). |
| A sandbox provider: **E2B** or **Impello** | E2B: $100 free credit. Impello: 7-day free trial. | Setup asks which one. |
| Claude: a **Pro/Max plan** or an **Anthropic API key** | Your plan, or pay per use | Read [Which Claude sign-in?](#which-claude-sign-in) first. |
| A Slack workspace where you can install apps | Free | |
| Node.js 22.6 or newer | Free | `node --version` |
| A GitHub account | Free | Required: the bot's memory lives in a private repo, reached through a GitHub App. |

## Setup

### The easy way: let your coding agent do it

1. Click **Use this template** at the top of this page, then clone your copy.
2. Open the folder in Claude Code (or Codex, or any coding agent) and say:

   > Set up this repo by following SETUP.md.

The agent asks you two questions (E2B or Impello? Claude plan or API key?), runs every command, and
tells you when you need to do something by hand: log in to Cloudflare, make the keys, and create the
Slack app. **You put the keys in a file, `.env.setup`, never in the chat.** The file is git-ignored.

### By hand

```bash
npm install
npm run setup
```

It asks the same questions in the terminal. The Slack app needs your Worker URL, so the first run
deploys the Worker and tells you how to make the app; then you run `npm run setup` again with the
Slack secrets. Every step is safe to repeat.

Every secret is stored with `wrangler secret put`. None of them go in a file in this repo. Setup
makes three random ones once and keeps them: `CALLBACK_SECRET` (signs the sandbox's tokens),
`CHANNEL_SECRETS_KEY` (encrypts channel secrets; replacing it makes every stored channel secret
unreadable) and `GITHUB_WEBHOOK_SECRET` (checks GitHub's webhook; setup also writes it into the
git-ignored `.env.setup` so you can copy it into the GitHub App). If setup cannot read the Worker's
secret list, it stops rather than make a new one over a working one.

When it is done, invite the bot to a channel (`/invite @percy-jr`) and @mention it.

### Which sandbox provider?

Both work the same way. Pick one, and setup handles the rest.

- **E2B** ([e2b.dev](https://e2b.dev)): sign up, then make a key on the dashboard. New accounts get
  $100 of credit. The Hobby plan stops a sandbox after 1 hour of continuous running, so a single
  turn is limited to 45 minutes by default.
- **Impello** ([impello.ai](https://www.impello.ai)): sign up at
  [dashboard.impello.ai](https://dashboard.impello.ai/sign-up), then make a key on the API Keys tab.
  7-day free trial.

To switch later, run `npm run setup` again and pick the other one.

### Which Claude sign-in?

- **Your Pro or Max plan** (`claude setup-token`). No extra cost. **Anthropic's terms allow a plan
  token for your own use of Claude Code.** Put the bot in a workspace or a channel that only you use.
  Anyone who can @mention the bot spends your plan.
- **An Anthropic API key** ([console.anthropic.com](https://console.anthropic.com)). You pay per
  token. Use this if other people will use the bot. A long coding turn can cost several dollars.

The Worker uses `ANTHROPIC_API_KEY` whenever it is stored, so to switch from a key to a plan token,
fill in only `CLAUDE_CODE_OAUTH_TOKEN` and run setup again: it deletes the old key for you (and the
other way round).

### Who can use it

The bot answers **anyone** in the workspace who @mentions it (or, in a watched channel, anyone who
posts). This is on purpose: it keeps the starter simple. Pick the workspace, the channel and the
sign-in with that in mind. Three things follow from it:

- **Memory outlives the thread.** Anyone can teach the bot something, and the note is read by every
  later thread in that channel. Read the memory repo now and then, and delete what is wrong.
- **Routines outlive the thread, and have no limits.** Anyone can make one, at any frequency (every
  minute is allowed), and it runs until someone pauses or deletes it. Each run is a whole Claude turn
  in a sandbox, so it costs money or plan usage. Check `routine list` in each channel, or the web UI.
- **The web UI sees everything**, private channels and channel secrets' names included. It is behind
  Cloudflare Access with a policy that lets in only you; keep it that way ([Web UI](#web-ui)).

## GitHub App (required)

The bot keeps its memory in a private GitHub repo and reaches it through a GitHub App you make. The
same App lets it clone your repos, push a branch and open a pull request.

0. Create the memory repo first: **GitHub > New repository**, name it (for example `my-bot-memory`),
   make it **Private**, and tick **Add a README** (the bot cannot write to an empty repo).

1. Go to **GitHub > Settings > Developer settings > GitHub Apps > New GitHub App**.
2. Name it anything. Homepage URL: your Worker URL. Leave **Webhook > Active** ticked (it is
   required), set the **Webhook URL** to `<your Worker URL>/github/webhook`, and the **Webhook
   secret** to the value setup wrote into `GITHUB_WEBHOOK_SECRET` in `.env.setup` (open the file and
   copy it; setup never prints it).
3. Repository permissions: **Contents: Read and write**, **Pull requests: Read and write**,
   **Checks: Read-only**, **Commit statuses: Read-only**, **Actions: Read-only** (so the bot can see
   why CI failed on its PR and read the failed job's log). Metadata (read) is added for you.
   Under **Subscribe to events**, tick **Check run**, **Status**, **Pull request**,
   **Pull request review**, **Pull request review comment** and **Issue comment**.
4. "Where can this GitHub App be installed?": **Only on this account**. Click **Create**.
5. Note the **App ID**. Scroll down and click **Generate a private key**. A `.pem` file downloads.
6. Click **Install App**, then pick **Only select repositories** and choose the **memory repo** and
   the repos the bot may work in.
7. Run `npm run setup` again and give it the App ID, the `.pem` path and the memory repo
   (`owner/name`, which goes into `MEMORY_REPO` in `wrangler.jsonc`). Lost the webhook secret? Make
   a new long random string (`openssl rand -hex 32`), put it in the App and in
   `GITHUB_WEBHOOK_SECRET`, and run setup again: a value you give always replaces the stored one.

Made the App before this step existed? Open it (Developer settings > GitHub Apps > Edit), do steps
2 and 3 (including Checks, Commit statuses and Actions: Read-only), and accept the new permissions on
the install page (GitHub emails you a link). Until you accept them, the bot still opens PRs but
cannot see why CI failed.

**Protect your main branch.** In each repo: Settings > Rules > Rulesets > New branch ruleset,
target `main`, and tick **Require a pull request before merging**. The bot is told never to push to
`main`, but a rule is what actually stops it.

What the bot's GitHub token can do: it lasts 1 hour, reaches only the repos you picked in step 6
**except the memory repo**, and can only read and write code and pull requests. The sandbox never
gets a token for the memory repo; see [Memory](#memory).

## How it works

- **One sandbox per thread.** The Worker finds a thread's sandbox by the thread id stored on the
  sandbox itself, so no database is needed. The Claude session id is made from the thread id, so
  `claude --resume` finds the conversation the same way.
- **Paused, not deleted.** 5 minutes after a thread goes quiet, its sandbox is paused. A paused
  sandbox costs no compute and keeps its disk, so the next message in the thread resumes it in a
  few seconds with its history and files.
- **One turn at a time.** Each thread has a Cloudflare Durable Object that lets one Claude turn run at a
  time. A message with files that arrives during a turn gets an ⏳ and goes into the next turn.
- **Follow-ups reach the running turn.** A plain follow-up sent while Claude works ("actually, use
  the other branch") gets a 📨 instead. The sandbox picks it up on its next report to
  `/sandbox/progress`, drops it in an inbox folder, and a Claude Code hook (`box/inbox-hook.mjs`,
  PostToolUse) hands it to Claude after its next tool call. Claude covers it in the same reply, so
  there is no second answer, and the status line shows "Read your new message". The follow-up gets
  a ✅ only if Claude read it AND the turn answered. If the turn fails, is stopped or is lost, or
  Claude never made another tool call, the follow-up runs as the next turn: a race can cost a
  second answer, never a message. Follow-ups with files, after a Stop, behind a queued message, or
  after a `!model` change wait for the next turn as before.
- **Nothing waits for Claude.** The Worker starts Claude in the sandbox and returns. When Claude is
  done, the sandbox posts its answer back to `/sandbox/callback`. A turn can take as long as it needs
  (up to the limit), far longer than any Worker request.
- **You can watch it work, and stop it.** When a turn starts, the Worker posts a status message
  under your message: what Claude is doing now (`Running npm test · 14 steps · 3m`), a **Follow
  along** link to the turn's transcript page (`/ui/follow`, part of the web UI, once it is set up), and a **Stop**
  button. The sandbox reports to `/sandbox/progress` every 10 seconds and the Worker edits the
  message; the sandbox never holds the Slack token. Stop goes to `/slack/interactive` (signature
  checked), which marks the turn; the sandbox sees the mark on its next report, ends Claude, and the
  bot posts "Stopped". When the answer arrives it is a new message, and the status message is
  deleted. Anyone who can see the thread can press Stop, as anyone can talk to the bot.
- **Every turn is backed up.** After each turn the sandbox copies the thread's Claude transcript to
  an R2 bucket through `/sandbox/transcript`, using its one-turn token. The Worker picks the object
  key from the token (`transcripts/<channel>/<thread>/<turn>.jsonl.gz`), so a sandbox can only write
  its own thread's backups. Backups are kept forever; a D1 table indexes them.
- **Files go both ways, without the Slack token.** Files dropped in the thread reach Claude as files
  in `~/work/slack-files/`. When a turn starts, the Worker writes a manifest into the sandbox with a
  signed grant for each file that turn's messages carried. Before Claude starts, the sandbox swaps
  each grant for the bytes at `/sandbox/file`, which checks the grant, asks Slack the file is in that
  channel, and streams it through with the bot token. A grant opens one file in one thread, so
  Claude can never pull a file from another channel. Claude posts files and canvases back with
  `node ~/.agent/tools.mjs upload|canvas` (`/sandbox/upload`, `/sandbox/canvas`), using a second
  token of its own that can only post into its own thread, and cannot deliver the answer or stop the
  turn. A canvas is shared with the channel, so its members can edit it.
- **Search sees public channels only.** Claude searches the workspace with
  `node ~/.agent/tools.mjs search "<question>"`, which calls `/sandbox/search` with the same tools
  token. The Worker asks Slack's `assistant.search.context` with the bot token (scope
  `search:read.public`) for public-channel messages, then checks every result's channel with
  `conversations.info` and drops anything that is not a public channel, so a private channel, a DM
  or a group DM never reaches Claude. Slack lets a bot search only with the short-lived
  `action_token` it puts on an @mention or a DM, so search works in turns started that way; a
  follow-up typed without a mention may be refused, and Claude asks for a mention. The thread keeps
  the token; it never enters the sandbox.
- **Watched channels answer without a mention.** A channel you mark as watched on the web UI's
  Channels page gets an answer to every new root message, no @mention needed. Elsewhere a thread
  starts with an @mention. Either way, replies in a thread the bot answers reach it without one.
- **Channel secrets reach that channel only.** On the same page you can give a channel secrets
  (say, an API key its work needs). They are stored encrypted (AES-GCM) in D1 with the Worker secret
  `CHANNEL_SECRETS_KEY`, and only that channel's sandboxes get them, as environment variables for
  Claude. Claude is told their names, never their values. Treat a secret as readable by anyone who
  can talk to the bot in that channel: Claude can print its own environment. They are never set
  from Slack, and the page shows names only.
- **Routines run on a schedule.** Ask in any thread: "every Monday at 9am, check the open PRs".
  Claude makes the routine with `node ~/.agent/tools.mjs routine create`, which calls
  `/sandbox/routines` with its tools token; the Worker stores it in D1 under the token's channel. A
  Cron Trigger runs every minute and fires each due routine: the bot posts a new thread in that
  channel and starts a turn there, like a mention. See [Routines](#routines).
- **It follows the PRs it opens.** After `gh pr create`, Claude runs `node ~/.agent/tools.mjs
  follow-pr <link>`, and the Worker records the PR against the thread in D1. GitHub's webhook then
  wakes that thread when CI fails or a person reviews or comments, and says so when the PR is merged
  or closed. See [Following PRs](#following-prs).
- **It can open a Slack code channel (beta).** Ask for one and Claude runs `node ~/.agent/tools.mjs
  code-channel create "<name>"`: a channel linked to the thread, with tabs Claude writes (an HTML
  page, a diff, Block Kit) and a session status. See [Code channels](#code-channels).
- **It remembers, per channel.** Claude Code's own auto memory writes notes into a folder, and the
  bot keeps that folder in your memory repo, one folder per channel. See [Memory](#memory).
- **A web UI, behind Cloudflare Access, on a domain of yours.** `/ui` shows each thread's transcript (every prompt, tool
  call and result, from the R2 backups plus the turn running now), the routines (add, edit, pause,
  delete, see runs) and the channel settings. See [Web UI](#web-ui).
- **The Home tab** in Slack lists recent threads, routines and a link to the web UI, for public
  channels and your own DM with the bot only.
- **The Slack token never enters the sandbox.** The sandbox gets a token that can post one turn's answer
  into one thread, and it expires. Claude reads text anyone can write, so the sandbox holds as little
  as possible.

| File | What it does |
|---|---|
| `src/index.ts` | The Slack events and interactivity routes, the sandbox doors, the queue consumer |
| `src/thread.ts` | The thread rules: one turn at a time, dedupe, mid-turn follow-ups, when to pause |
| `src/thread-state.ts` | The Durable Object that stores a thread and runs its alarm |
| `src/thread-stub.ts` | Finds a thread's Durable Object by its channel and thread |
| `src/turn.ts` | Starts one turn: prompt, tokens, launch |
| `src/sandbox.ts` | E2B / Impello: find, create, pause, launch |
| `src/github.ts` | GitHub App tokens: the turn's (every repo but memory) and the memory repo's |
| `src/memory.ts` | The memory rules: one folder per channel, which paths sync, merging two threads' notes |
| `src/memory-store.ts` | Reads and commits a channel's memory folder through GitHub's API |
| `src/models.ts` | The `!model` aliases and their model ids, in one place |
| `src/status.ts` | The live status message and the Stop button: the line, its caps, reading a click |
| `src/transcripts.ts` | The transcript backup rules: the R2 key, the size limit |
| `src/files.ts` | The file rules, both ways: grants, caps, the checks on uploads and canvases |
| `src/search.ts` | The search rules: public channels only, the request Slack gets, the result shape |
| `src/channels.ts` | The channel rules: watched channels, the default model, secret names and their encryption |
| `src/channel-store.ts` | Reads and writes channel settings and encrypted secrets in D1 |
| `src/routines.ts` | The routine rules: cron in a time zone, the next run, what the sandbox may ask, what a run posts |
| `src/routine-store.ts` | Routines and their runs in D1, scoped to a channel, and the claim that fires a run once |
| `src/routine-fire.ts` | The every-minute sweep: posts each due run's thread and starts its turn |
| `src/pr-follow.ts` | The PR-follow rules: the webhook signature, which events wake a thread, batching, the daily cap |
| `src/pr-follow-store.ts` | Followed PRs in D1: follow, batch an event, claim a batch once, end on merge or close |
| `src/pr-follow-fire.ts` | The GitHub webhook route, and the every-minute sweep that wakes a followed PR's thread |
| `src/code-channels.ts` | The code-channel rules: the closed action set, the tab fields, nested creates, feature off |
| `src/code-channel-door.ts` | The code-channel door's Slack calls: create, post, view, status, archive, summary |
| `src/access.ts` | The web UI's sign-in check: verifies the Cloudflare Access JWT (team, AUD, signature, time) |
| `src/ui.ts` | The web UI rules: same-origin JSON writes, which transcript a page may read, what the Routines and Channels pages may send |
| `src/ui-routes.ts` | The web UI's pages and API under `/ui`, and the App Home tab's publish |
| `src/home.ts` | The App Home tab: what it lists (public channels and your own DM only) |
| `src/live.ts` | The live turn for the transcript page: what the sandbox may send, the capped log |
| `ui/` | The web UI: one HTML shell, one script, one stylesheet, and `transcript.js` (reads a backup) |
| `src/db.ts` | The D1 database helpers |
| `migrations/` | The D1 tables. `npm run setup` applies them |
| `box/run-turn.mjs` | Runs inside the sandbox: runs Claude, reports progress, posts the answer back |
| `box/progress.mjs` | Runs inside the sandbox: turns Claude's stream events into the status line and the live transcript |
| `box/memory.mjs` | Runs inside the sandbox: pulls the channel's notes before Claude starts and pushes what changed |
| `box/files.mjs` | Runs inside the sandbox: downloads the turn's files before Claude starts |
| `box/tools.mjs` | Runs inside the sandbox: Claude's commands to post a file or a canvas into its thread, to search public channels, to make and change routines, to follow a PR, and to drive a code channel |
| `box/inbox.mjs`, `box/inbox-hook.mjs` | Runs inside the sandbox: follow-ups sent mid-turn, and the hook that hands them to Claude |
| `box/CLAUDE.md` | The instructions Claude reads in the sandbox. Edit this to change the bot's behavior. |
| `template/Dockerfile` | The sandbox image. Run `npm run template:build` after you change it. |

## Pick the model

Each thread runs on **Opus** unless you say otherwise. Send `!model sonnet` (or `opus`, `haiku`) in
the thread, on its own, to switch; `!model` alone shows the current one. A turn that is already
running keeps its model, and the switch applies from the next turn. A channel can have its own
default model, set on the web UI's Channels page; a thread's `!model` pick still wins over it. The
aliases and the model ids they map to live in `src/models.ts`.

## Memory

The bot remembers. It uses **Claude Code's own auto memory**: Claude reads a `MEMORY.md` index when
a turn starts and writes short notes as it learns (a decision, how your repo builds, a gotcha). Those
notes live in your **memory repo**, one folder per Slack channel, named by the channel id:

```
my-bot-memory/
  C1EXAMPLE01/MEMORY.md
  C1EXAMPLE01/deploy_steps.md
```

- **Each turn:** before Claude starts, the sandbox pulls its channel's folder from `/sandbox/memory`
  and points auto memory at it. After Claude stops, it sends what changed back to the same door,
  and the Worker commits it to the repo. A commit message names the channel and the thread.
- **A channel sees only its own folder.** The Worker picks the folder from the sandbox's one-turn
  token, never from the request, and the sandbox never holds a token for the memory repo: the turn's
  GitHub token is minted for every installed repo except that one. So a private channel's memory is
  never shared with another channel.
- **Two threads at once** in one channel merge: the index keeps both sides' lines, and a note both
  changed keeps the stored version with the other saved beside it as `<name>.conflict-<turn>.md`.
  A failed push is kept in the sandbox and sent with the next turn.
- **Read it, fix it, undo it.** It is a git repo: browse it on GitHub, edit or delete a note, or
  revert a commit. Do look now and then. Anyone who can talk to the bot can teach it something, and
  a note **outlives the thread**: it is read by every later thread in that channel.

## Routines

Anyone who can talk to the bot can give it a schedule: "every weekday at 9am, summarise yesterday's
open PRs in this channel". Claude turns that into a cron and a self-contained prompt, and saves the
routine. It can also list this channel's routines, and pause, resume or delete one.

- **Each run is a new thread** in the channel the routine was made in, with a fresh sandbox. It
  starts with the channel's memory notes and nothing else from the thread that made it.
- **Times are in a time zone.** Without one, the person's own Slack time zone is used, so "9am"
  means their 9am, through daylight saving changes too.
- **A channel sees only its own routines.** The Worker takes the channel from the sandbox's token.
  A private channel's routines never show up in another channel.
- **The model** is the routine's own if it was given one, else the channel's default.
- **A run fires once.** The every-minute sweep claims each run with a row D1 will not insert twice,
  so overlapping sweeps never double it. If the Worker misses some minutes, a routine fires once
  when it is back, not once per missed run. A run that cannot post (say the bot was removed from
  the channel) is recorded as failed and the routine keeps its schedule.

**There are no limits** on how many routines there are or how often they run: every minute is
allowed. Each run is a whole Claude turn in a sandbox, so a routine that runs every few minutes can
cost real money on an API key, and a lot of them can use up a plan's limits. Check
`routine list` in each channel now and then. **A routine outlives its thread**, like memory: anyone
in the workspace can make one, and it keeps running until someone pauses or deletes it.

## Following PRs

When the bot opens a pull request it follows it, and GitHub's webhook brings it back to the thread
that opened it:

- **A failed check** (a check run or a commit status), **a review**, or **a comment** from a person
  wakes the thread. The bot posts a short :telescope: line and starts a turn: Claude reads what
  happened, looks with `gh`, and pushes a fix to the PR's branch or answers in the thread. Comments
  from bots never wake it, its own included.
- **Merged or closed** posts a note and stops following the PR.
- **Events are batched.** The bot waits a minute after the first event, so a CI run that fails five
  checks wakes it once.
- **At most 3 wakes per PR per day** (UTC). After that the bot posts "stopped auto-fixing, @mention
  me to go on" once, and ignores that PR's events until the next day. You can always carry on by
  talking in the thread.
- **Only the bot's own PRs.** The Worker asks GitHub that a PR is open and was opened by your App
  before it follows it, and the thread comes from the sandbox's token. `unfollow-pr <link>` stops
  it early.

Every delivery must carry GitHub's signature made with `GITHUB_WEBHOOK_SECRET`; anything else is
refused, and with the secret unset every delivery is. A comment on the PR can be written by anyone
who can see the repo, so the bot reads GitHub's text as information, never as orders. Each wake is a
whole Claude turn, which is what the daily cap is for.

## Code channels

Slack's code channels are a **beta** feature: a channel bound to one agent session, with tabs the
agent writes and a status. The manifest asks for them (`features.code_channels` and the scope
`code_channels:manage`); if your workspace or app does not have the beta, the bot says so **once**
in the thread and keeps working there.

Claude has six actions and no others, through `/sandbox/code-channel` with its tools token:

| Action | What it does |
|---|---|
| `create "<name>"` | Opens a code channel linked to the calling thread, invites the person who asked, and posts its link in the thread |
| `post <C…> "<text>"` | Posts in a code channel, only one this app is the agent of, from the thread that opened it or from inside it |
| `view <C…> <file>` | Sets a tab: `--type html`, `diff` or `block_kit`, `--name`, and `--key` to replace it later |
| `status <C…> <status>` | `processing`, `active` or `suspended` (`view` and `status`: from the opening thread or inside) |
| `archive <C…>` | Closes the session and archives the channel, from the thread that opened it |
| `summary "<text>"` | From a turn inside a code channel: posts into the thread Slack says opened it |

- **Only the opener touches it.** `post`, `view`, `status` and `archive` read the channel from Slack
  and act only when Slack says the calling thread opened it (or, except archive, the turn runs
  inside it). A thread elsewhere cannot write into or archive another thread's code channel.
- **No delete.** Nothing deletes a channel, a message or a tab, and nobody is removed.
- **No code channel from a code channel.** Slack posts a "Context from #origin" message at the top
  of a new code channel that quotes the origin message, @mention included. The bot ignores that
  message, and a turn inside a code channel cannot open another one, so one channel never opens the
  next in a loop. If Slack cannot say what the calling channel is, the create is refused.
- **Talking to it there** works as anywhere else: @mention the bot in the code channel and it
  answers in a thread.

## Web UI

The Worker serves a small web UI at `/ui`, plain HTML and JavaScript from `ui/`:

- **Threads** (`/ui/`): the threads with transcript backups, newest first.
- **Follow** (`/ui/follow?channel=…&thread=…`, the **Follow along** link on every status message):
  the thread's transcript. Every finished turn comes from the newest R2 backup (each backup is the
  whole session so far; pick an older one from the list). The turn running now comes from the
  sandbox's progress reports: the prompt, Claude's text and thinking, each tool call and its result,
  every few seconds. The page refreshes every 5 seconds.
- **Routines** (`/ui/routines`): every routine in every channel. Add one (give the channel id), edit
  its prompt, schedule, time zone or model, pause, resume, delete, and see its runs.
- **Channels** (`/ui/channels`): watched on or off, the default model, and secrets. A secret is
  write-only: the page sets and deletes it and shows its name, and the value never comes back out.

**It needs a domain of yours on Cloudflare.** Cloudflare Access can only put a path behind sign-in
on a domain (zone) in your own Cloudflare account. On `workers.dev` its one switch covers the whole
address, and Slack and GitHub would get its login page instead of the Worker. So the UI gets its own
hostname, `UI_HOST` (a new subdomain such as `agent.example.com`): setup attaches it to the Worker
as a custom domain, every UI link points there, and Slack and GitHub stay on `workers.dev`. On
`workers.dev`, `/ui` only redirects to `UI_HOST`. Leave the Worker's workers.dev Access switch off.
No domain on Cloudflare means no web UI; the bot works the same without it, minus the **Follow
along** link and the Home tab's UI button.

**It is behind Cloudflare Access, and the Worker checks too.** You make an Access application that
covers the whole `UI_HOST` hostname (SETUP.md step 7), with a policy that lets in only you.
Access signs you in and adds a signed token to each request; the Worker verifies that token itself
(`src/access.ts`: RS256, your team's keys, your application's AUD tag, not expired) on every page
and API call. With `UI_HOST`, `ACCESS_TEAM_DOMAIN` or `ACCESS_AUD` unset, it refuses everyone. A change must be
a JSON POST from the page itself (its `Origin`), so another site cannot use your sign-in. The UI
sees every channel, private ones included, so keep its Access policy to yourself.

The App Home tab in Slack is for everyone in the workspace, so it lists only public channels' threads
and routines, plus the viewer's own DM with the bot.

## Transcript backups

Every turn's transcript is copied to the R2 bucket `slack-agent-transcripts` and **never deleted**:
the bucket has no lifecycle rule. Transcripts are small (gzipped text) and R2 storage is cheap, but
it grows with every turn. To keep less, add a lifecycle rule to the bucket in the Cloudflare
dashboard (R2 > the bucket > Settings > Object lifecycle rules).

## Settings

In `wrangler.jsonc` under `vars`. Run `npm run deploy` after you change one.

| Var | Default | What it does |
|---|---|---|
| `MAX_TURN_MINUTES` | 45 | How long one turn may run. Keep it under 50 on E2B Hobby. |
| `IDLE_PAUSE_MINUTES` | 5 | How long a thread may be quiet before its sandbox pauses. |
| `SANDBOX_TEMPLATE` | `slack-agent` | The sandbox image name. |
| `MEMORY_REPO` | (set by setup) | The memory repo, `owner/name`. Required. |
| `UI_HOST` | (set by setup) | The web UI's own hostname, a custom domain on the Worker (also in `routes`). Empty: no web UI. |
| `ACCESS_TEAM_DOMAIN` | (set by setup) | The web UI's Cloudflare Access team, `<team>.cloudflareaccess.com`. Empty: the UI refuses everyone. |
| `ACCESS_AUD` | (set by setup) | The web UI's Access application AUD tag. Empty: the UI refuses everyone. |
| `WORKER_URL` | (set by setup) | The Worker's workers.dev address. A routine made on the web UI reports back here, never to `UI_HOST`. Empty: the UI cannot make routines. |

## When something goes wrong

- **See the logs:** `npx wrangler tail`
- **No reply and no 👀:** Slack is not reaching the Worker. In the Slack app's Event Subscriptions,
  check that the Request URL is verified (click Retry), and that the bot is in the channel.
- **👀 but no reply:** the turn failed to start or is still running. `npx wrangler tail` shows why.
  A turn that never reports back is released after its limit, with a note in the thread.
- **Stop does nothing:** check that Interactivity is on in the Slack app with the Request URL
  `<worker>/slack/interactive`. A click is seen by the sandbox on its next report (up to 10 seconds).
- **A routine did not run:** `routine list` in its channel shows whether it is paused and when it
  runs next. A run that could not post (the bot is not in the channel) is recorded as failed in
  D1's `routine_runs` table, with Slack's error. `npx wrangler tail` shows the sweep each minute.
- **A PR does not wake its thread:** the App's Advanced tab (Developer settings > GitHub Apps >
  Edit > Advanced) lists each delivery and the Worker's answer. 401 means the Webhook secret and
  `GITHUB_WEBHOOK_SECRET` differ; 503 means the secret is not set; "ignored: not followed" means
  Claude did not run `follow-pr`, or the PR was merged, closed or unfollowed. Check the App
  subscribes to the six events in "GitHub App", step 3.
- **"Code channels are not turned on":** Slack refused the beta (`feature_disabled`,
  `missing_scope`, `unknown_method`). Check the app has `code_channels:manage` and Code channels on
  in its manifest and was reinstalled after; the workspace may simply not have the beta yet.
- **The web UI says "not set up":** `UI_HOST`, `ACCESS_TEAM_DOMAIN` or `ACCESS_AUD` is empty or
  not in the right form (a `workers.dev` host is refused); run setup again with them in
  `.env.setup`. **"another application"** means `ACCESS_AUD` is not this Access application's AUD
  tag; **"no Access token"** means the request did not come through Access (check the application's
  hostname is `UI_HOST`).
- **The deploy fails on the custom domain:** `UI_HOST` must be on a domain in the same Cloudflare
  account and must not already have a DNS record. Fix it, or empty it and set `"routes"` in
  `wrangler.jsonc` back to `[]`.
- **Slack stopped reaching the Worker after Access went on:** Access covers the `workers.dev`
  address. Turn off the Worker's workers.dev Cloudflare Access switch (Settings > Domains & Routes)
  and put Access on `UI_HOST` only; `curl <worker>/` must answer "slack-agent is running".
- **The Home tab is empty or says "This is still being worked on":** reinstall the app from the
  manifest (it turns on `home_tab_enabled` and subscribes to `app_home_opened`).
- **"Invalid API key" from Claude:** the Claude secret is wrong or expired. Run
  `npx wrangler secret put CLAUDE_CODE_OAUTH_TOKEN` (or `ANTHROPIC_API_KEY`) again. A stored
  `ANTHROPIC_API_KEY` always wins, so if you meant to use a plan token, also run
  `npx wrangler secret delete ANTHROPIC_API_KEY` (setup does this when only the token is filled in).

## Develop

```bash
npm test            # unit tests
npm run typecheck
npm run scan        # checks the repo and its history for secrets
npm run deploy
```

## License

MIT

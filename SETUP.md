# Setup guide for a coding agent

You are a coding agent (Claude Code, Codex or similar). The human asked you to set up this repo.
Follow these steps in order. They take about 15 minutes, most of it waiting on the human.

**The one rule: never ask the human to paste a key, token or secret into the chat.** Secrets go into
the file `.env.setup`, which the human edits and which git ignores. You never read the values in it
aloud, print them, or put them in a command. The setup script reads the file itself and never prints
a secret.

## 1. Check the machine

- `node --version` must be 22.6 or newer.
- Run `npm install`.
- Run `npx wrangler whoami`. If it says the human is not logged in, ask them to run
  `npx wrangler login` themselves (it opens a browser). Wait for them to say it is done.
- Tell the human: their Cloudflare account must be on **Workers Paid** ($5/month):
  dash.cloudflare.com > Workers & Pages > Plans. The free plan does not work. R2 must be turned on
  too: dash.cloudflare.com > R2 > Purchase / Get started (it has a free allowance).

## 2. Ask two questions

Ask each one on its own, with these options, and wait for the answer.

1. **Which sandbox provider: E2B or Impello?** Each Slack thread gets its own cloud computer from it.
   - E2B (e2b.dev): $100 of free credit on sign-up. Keys at https://e2b.dev/dashboard.
   - Impello (impello.ai): 7-day free trial. Keys at https://dashboard.impello.ai (API Keys tab).
2. **How does the bot sign in to Claude?**
   - Their Claude Pro or Max plan: they run `claude setup-token` and copy the token. Tell them:
     Anthropic's terms allow a plan token for their own use of Claude Code, so the bot must stay in a
     workspace or channel only they use.
   - An Anthropic API key (https://console.anthropic.com): pay per use. The right choice if other
     people will use the bot.

## 3. Make the file, and have the human fill it in

- Copy `.env.setup.example` to `.env.setup`.
- Write the provider they picked into `SANDBOX_PROVIDER` (`e2b` or `impello`). That is not a secret.
- Ask the human to open `.env.setup` in their editor and paste in `SANDBOX_API_KEY` and ONE of
  `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY`, then save it and tell you. Leave the Slack, GitHub,
  `MEMORY_REPO`, `UI_HOST` and `ACCESS_*` lines empty for now.

## 4. Run setup

```bash
npm run setup -- --file .env.setup
```

It builds the sandbox image (a few minutes the first time), creates the queue, the R2 bucket for
transcript backups and the D1 database (and applies `migrations/`), deploys the Worker (which also
turns on its every-minute Cron Trigger for routines), stores the secrets,
and writes `slack-manifest.local.json` with the Worker URL in it. It makes three random secrets
itself, once: `CALLBACK_SECRET`, `CHANNEL_SECRETS_KEY` and `GITHUB_WEBHOOK_SECRET`. The last one
GitHub needs too, so setup also writes it into `GITHUB_WEBHOOK_SECRET` in `.env.setup` for the human
to copy in step 6. Do not read it or print it yourself. It ends with `NEXT:` lines. Read
them and do what they say. If a step fails, the `NEXT:` line says why; fix that and run it again.
Running it again is always safe.

To skip the image build on later runs, add `--skip-template`.

## 5. The Slack app (the human does this)

Walk the human through it:

1. Open https://api.slack.com/apps and click **Create New App > From a manifest**.
2. Pick the workspace. Paste the contents of `slack-manifest.local.json` (you can show them the file;
   it holds no secret). Click **Create**, then **Install to Workspace**.
3. Paste the **Signing Secret** (Basic Information page) into `SLACK_SIGNING_SECRET` and the
   **Bot User OAuth Token**, `xoxb-...` (OAuth & Permissions page), into `SLACK_BOT_TOKEN` in
   `.env.setup`.

Then run `npm run setup -- --file .env.setup --skip-template` again. After it finishes, the human
opens **Event Subscriptions** in the Slack app and clicks **Retry** if the Request URL is not marked
Verified. The manifest also turns on **Interactivity** with the Request URL `<worker>/slack/interactive`
(it carries the Stop button's clicks); nothing to do there unless the Worker URL changes.

## 6. GitHub and the memory repo (required)

The bot keeps its memory in a private GitHub repo, so this step is not optional: a turn refuses to
start until it is done. Walk the human through "GitHub App" in the README:

1. They create a **private** repo for the memory (for example `my-bot-memory`) **with a README**.
2. They create the GitHub App with the permissions in README "GitHub App" step 3 (Contents and Pull
   requests: Read and write; Checks, Commit statuses and Actions: Read-only) and install it on the
   memory repo and on any repos the bot may work in.
3. They fill in `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY_PATH` (the path to the downloaded `.pem`
   file) and `MEMORY_REPO` (`owner/name`, not a secret; you may write it yourself) in `.env.setup`.
4. The App's webhook stays **Active**: Webhook URL `<worker>/github/webhook` (setup printed the
   Worker URL) and the events in README "GitHub App" step 3. For the **Webhook secret**, they open
   `.env.setup` and copy the value of `GITHUB_WEBHOOK_SECRET` (setup made it in step 4) into that
   field themselves. Do not read it or copy it for them. The webhook is how the bot comes back to a
   PR it opened when CI fails or someone reviews. If the line is empty (say `.env.setup` was made
   again after the first run), the Worker already holds a secret nobody can read back: they make a
   new long random string, put it in both the App and `GITHUB_WEBHOOK_SECRET`, and setup stores it.

Then run setup again with `--skip-template`. Remind them to protect `main` in the repos the bot
works in.

## 7. The web UI behind Cloudflare Access (optional; the human does this)

The web UI (`/ui`: live transcripts, routines, channel settings and secrets) is only reachable
through Cloudflare Access, and the Worker checks Access's signed token as well. Until this is done
the UI answers "not set up", the status message has no **Follow along** link and the Home tab has no
UI button. The bot works fine without it. Walk the human through README "Web UI":

1. **It needs a domain of theirs on Cloudflare.** Access can only put a path behind sign-in on a
   domain (zone) in their own Cloudflare account. On `workers.dev` its one switch (Worker > Settings
   > Domains & Routes > workers.dev > Cloudflare Access) covers the whole address: Slack and GitHub
   would get Access's login page and the bot would stop answering. Tell them to leave that switch
   OFF. No domain on Cloudflare: stop here, the UI stays off.
2. They pick a NEW subdomain of that domain for the UI, for example `agent.example.com` (one with
   no DNS record yet). You write it into `UI_HOST` in `.env.setup` (not a secret) and run setup
   again with `--skip-template`. Setup puts it into `UI_HOST` and `routes` in `wrangler.jsonc`, and
   the deploy attaches it to the Worker as a custom domain. Slack and GitHub stay on `workers.dev`.
3. In the Cloudflare dashboard: **Zero Trust > Access > Applications > Add an application >
   Self-hosted**. Hostname: the `UI_HOST` subdomain, path left empty (the whole host is the UI's).
   A policy that allows only their own email (Action: Allow, Include: Emails).
4. From the application's Overview tab they copy the **Application Audience (AUD) Tag** into
   `ACCESS_AUD` in `.env.setup`, and the team domain (**Zero Trust > Settings**,
   `<team>.cloudflareaccess.com`) into `ACCESS_TEAM_DOMAIN`. Neither is a secret; you may write them.

Then run setup again with `--skip-template`. Check both halves yourself:

```bash
curl -s <worker>/                    # must say "slack-agent is running": Slack still reaches the Worker
curl -sI https://<UI_HOST>/ui/ | head -3   # must redirect to <team>.cloudflareaccess.com: the UI is behind Access
curl -sI <worker>/ui/ | head -3      # must redirect to https://<UI_HOST>/ui/: workers.dev never serves the UI
grep '"WORKER_URL"' wrangler.jsonc   # must be <worker>: a routine made on the UI reports back there, not to UI_HOST
```

Then the human opens `https://<UI_HOST>/ui/` in a browser, signs in, and sees the Threads page.

## 8. Test it

- Ask the human to invite the bot to a channel (`/invite @percy-jr`) and @mention it with a question.
- Run `npx wrangler tail --format pretty` while they do, and read it together. A 👀 on their message
  means the turn started. A status message with a **Stop** button appears under it and updates with
  what Claude is doing; the answer arrives in the thread and the status message goes away.
- Ask them to try **Stop** on a longer task: the status turns to "Stopping…" and within about 10
  seconds the bot posts "Stopped".
- Ask them to send a follow-up while a longer task runs ("also add a test"). It gets a 📨, the
  status line soon says "Read your new message", and the one answer covers both. Nothing to set up.
- In the GitHub App's settings (Advanced > Recent Deliveries), the `ping` GitHub sent when the
  webhook was saved should show a 200 answer. 401 means the Webhook secret differs from the one in
  `.env.setup`.
- If they have a test repo, ask the bot to open a small PR there. Its reply links the PR, and a
  comment on the PR from the human gets a :telescope: line in the thread about a minute later and a
  new turn. Merging it posts "stopped following".
- Code channels are a Slack beta. Ask them to say "open a code channel for this" in a thread. A new
  channel appears with a link in the thread, or, if the workspace does not have the beta, the bot
  says once that code channels are off and answers in the thread instead. Either is a pass.
- Ask them to tell the bot something worth keeping ("remember that we deploy with `npm run ship`"),
  then ask about it in a NEW thread in the same channel. The memory repo shows a commit named for
  the channel, and the new thread knows the answer.
- If the web UI is set up (step 7): while a turn runs, ask them to click **Follow along** on the status message: the transcript page
  shows the turn's prompt and each tool call as it happens, and the finished turns from R2 once it
  ends. Then ask them to open the bot's **Home** tab in Slack: recent threads, routines and an
  "Open the web UI" button.
- On the web UI's **Channels** page, they can mark a test channel as watched; a new message there
  without an @mention then gets an answer.
- If nothing happens, see "When something goes wrong" in the README.

## 9. Finish

- Tell the human `.env.setup` can be deleted now (the secrets are stored in Cloudflare, and the
  webhook secret is in the GitHub App), and offer to delete it. Check with them first that they copied
  `GITHUB_WEBHOOK_SECRET` into the App: once the file is gone, nobody can read that value back.
- Tell them what outlives a thread (README "Who can use it"): memory notes and routines. Anyone in
  the workspace can teach the bot something or make a routine, and both last until someone removes
  them. Routines have no limit on count or frequency, so check `routine list` (or the web UI's
  Routines page) now and then.
- Point them at README.md "How it works" for what each part does.

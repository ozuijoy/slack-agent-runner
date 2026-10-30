# ②: running the turns on your own machine

The Worker keeps what has to be consistent — Slack, the turn queue, the sessions, the status
message. This directory keeps the one thing that needs a real machine: Claude, with a disk to work
on and nobody's CPU limit but yours.

```
your machine                     Cloudflare
────────────                     ──────────
runner-daemon.mjs  ──poll─────▶  POST /runner/next     (the queue, D1)
                   ◀──job─────   { prompt, envs, file grants }
box/run-turn.mjs   ──answers──▶  POST /sandbox/callback, /sandbox/progress, /sandbox/memory
                   ──session──▶  PUT  /runner/session   (D1, chunked)
```

The turn posts its own answer to Slack through the Worker, so the daemon never holds an answer and
a dropped connection costs nothing but a retry. This is why the Worker needs ~1 ms of CPU per turn:
it dispatches, and the machine does the work.

## Turn it on

```sh
# 1. on Cloudflare: one long random string, the same on both sides
wrangler secret put RUNNER_SECRET

# 2. schema for the queue and the sessions
wrangler d1 migrations apply slack-agent-runner --remote

# 3. deploy, so the Worker has the doors and the runner bundle
npm run deploy

# 4. on your machine
export WORKER_ORIGIN=https://your-worker.workers.dev
export RUNNER_SECRET=...            # the same string
npm run runner                      # node runner/runner-daemon.mjs

# 5. in Slack, say something in a channel the bot is in
```

With `RUNNER_SECRET` unset the doors answer 401 and no turn can run: there is no sandbox to fall back
to, so the string is required.

## What lives where

| | |
|---|---|
| `$RUNNER_WORKDIR/threads/<channel>_<thread>/` | one directory per thread |
| `…/work` | the thread's `~/work`: the checkout Claude works in, kept between turns |
| `…/.agent` | the runner and tools, rewritten from the Worker's bundle each turn |
| `…/.claude/projects/…/<session>.jsonl` | the thread's Claude session, mirrored to D1 after each turn |
| D1 `runner_jobs` | the queue: one row per turn, `queued → leased → done/failed` |
| D1 `session_chunks` | the sessions, gzipped and chunked (D1 allows 2 MB per row) |

The thread's `HOME` is its own directory, so `~/work` and `~/.claude` are per thread and no two
threads can see each other's files or conversation.

## The lease

A machine claims a job for 3 minutes and re-claims it every 30 seconds while it works. If the
machine dies, sleeps, or loses its network, the lease runs out and the next machine that asks gets
the job: the queue is at-least-once, so a turn is never silently lost.

Two turns of the same thread can therefore overlap after a crash. The Worker's status message and
the thread's alarm already serialise turns at the other end, so the cost is a duplicated answer, not
a corrupted conversation.

## Bounds

- **One turn at a time.** The daemon runs turns serially on purpose: this machine is sized for one
  `claude` process, not two.
- **Memory.** `RUNNER_NODE_OPTIONS` (default `--max-old-space-size=2048`) is Node's ceiling. A turn
  killed by the OOM killer exits with SIGKILL and is reported as failed with "out of memory?", and
  the thread keeps its session, so the next turn resumes rather than restarts.
- **Sessions over 20 MB** are refused rather than stored (src/runner-jobs.ts), which is a sign the
  thread should be started fresh.

## Keep it running

```ini
# /etc/systemd/system/slack-runner.service
[Unit]
Description=Slack agent runner
After=network-online.target

[Service]
User=yourname
WorkingDirectory=/path/to/slack-agent-runner
Environment=WORKER_ORIGIN=https://your-worker.workers.dev
Environment=RUNNER_SECRET=...
Environment=RUNNER_WORKDIR=/var/lib/slack-runner
ExecStart=/usr/bin/node runner/runner-daemon.mjs
Restart=always
RestartSec=10
# The daemon survives a turn that dies; a reboot mid-turn only costs the turn (its lease expires).

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl enable --now slack-runner && journalctl -fu slack-runner
```

## Limits worth knowing

- `POST /runner/next` long-polls for 25 seconds. A Worker has no wall-clock limit while the client
  stays connected, so an idle machine costs ~3,500 requests a day, not 86,000.
- The Worker now bundles no sandbox SDK: the deploy is 265 KiB, 73 KiB gzipped.
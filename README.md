# factory

Works a queue of coding tasks with headless `claude` and `pi`, until their usage limits run out. You pick tasks from what [workwork](https://github.com/Soleone/workwork) finds across your repos, or let auto mode keep the queue topped up. In the morning, the results list what each agent did, with the PR or issue it opened.

```sh
npm install -g @soleone/factory
factory serve    # http://127.0.0.1:7040
```

Needs node 22+, git, [workwork](https://github.com/Soleone/workwork) with `--json` support, and whichever of `claude` and `pi` you use, logged in.

## How it works

- **Jobs** are workwork candidates in the queue. Your picks always go first, in the order you give them; auto jobs follow. A job can name its agent, model and effort. Once an agent has started a job, the job stays with that agent.
- **Auto mode** only fills the queue: while the factory is on, it keeps up to 5 of its jobs per agent queued, cheapest attention first, with repos taking turns. It never re-queues a candidate that already had a job. You can limit it to some levels and plays.
- **The factory** is what works the queue, one worker per agent. With nothing to do it waits, and it picks up new jobs within seconds. Turning it on starts a **run** with its own agents, models, efforts, limit and end time, defaulting to the settings.
- **Limits:** a limit of 1 (the default) stops an agent at its first usage-limit hit, so only the current allowance gets used. A limit of 2 waits for one reset and stops at the second hit. "None" always waits for the reset, which it logs. Once every agent has stopped, the factory turns itself off. Three quick failures in a row also count as a limit hit, so a broken login can't burn through the queue.
- **Failures:** a failed or timed-out job gets one more try by the same agent. After that it waits for you to retry it.

## Commands

The page and the CLI do the same things on the same state; `serve` is only an interface, and the factory runs without it.

```sh
factory start [run options]   # turn on, in the background (factory run: in the foreground)
factory stop                  # turn off; jobs in progress go back to the queue
factory status                # on or off, what each agent does, the queue
factory add <id>... [--repo DIR] [--agent NAME] [--model M] [--effort E]
factory remove <job> | retry <job>
factory auto on|off
factory report [--all]        # the last run (or every run): outcome, agent, PR/issue link or log
factory serve [--port 7040] [--host 127.0.0.1]
```

Run options: `--agents claude,pi`, `--limit N|none`, `--until HH:MM` (start nothing new after), `--model claude=opus`, `--effort pi=high` (claude's `--effort`, pi's `--thinking`), `--timeout MIN`.

`serve` listens on 127.0.0.1. Anyone who can reach it can queue jobs and turn the factory on, and the agents run with full permissions, so it amounts to running commands on your machine. Reach it from a phone through something like `tailscale serve`, not with `--host 0.0.0.0` on a network you don't trust.

## Worktrees

Each agent gets one worktree per repo, under the state folder, reused from job to job so installed dependencies survive. Before every job it's reset to a freshly fetched `origin/HEAD`, and untracked files are removed but ignored ones are kept. Your own checkout is never touched. If an agent leaves commits that aren't on a remote, or uncommitted changes, they're saved to a branch `factory/<job>-<attempt>` in the repo, and the result says so.

## State

In `$DATA/apps/factory/` when `DATA` is set, otherwise `~/.local/share/factory/`:

- `settings.json`: registered agents with their model and effort, limit, until, timeout, auto mode (on, levels, plays)
- `jobs.jsonl`: append-only events (add, remove, move, start, attempt, requeue, retry), so the CLI, the factory and the page never overwrite each other
- `candidates.json`: the cached `workwork --all --json`, which takes minutes; refreshed from the page, or by auto mode when older than 6 hours
- `runs/<run>/<job>-<attempt>/`: `prompt.md` and `agent.log`
- `worktrees/<agent>/<repo>/`
- `status.json`, `factory.pid`, `factory.log`: the current run

## Why not an LLM loop

This replaces an assistant that ran the night from inside chat turns. It stopped whenever a turn ended, built its own queue, guards and "authorization" out of prompts, then got blocked by them, and rewrote its own instructions after every failure. The tasks themselves went fine. So here the loop is plain code, and a model only ever does one task, as a child process that exits. Nothing a model says decides what runs next, who gets it, or whether to keep going.

## Development

```sh
pnpm install
pn dev
vp check && vp test run && kit check
```

The page is built on the [kit](https://github.com/Soleone/kit) web stack: Vite+, React, shadcn base-nova and the @soleone theme. `src/backend/` holds the CLI, the factory and the server; `src/` the page. `pn dev` runs Vite with hot reload at http://localhost:7040 in front of `factory serve` on 7041, which restarts when `src/backend/` changes. It uses your real state folder, so Turn on starts real agents. `pn build` bundles the CLI to `dist/cli.mjs` and the page to `dist/web/`.

### Release

From `main` with a clean working tree, authenticated Git push access, and pnpm logged in to npm (`pn whoami`):

```sh
pn release             # choose patch, minor or major, then confirm each step
pn release --dry-run   # preview without changing files, publishing or pushing
```

With Vite+, `pn` is shorthand for `pnpm`. The release command asks for the version, updates `CHANGELOG.md` from conventional commits, commits and tags `vX.Y.Z`, and pushes. Factory publishes `@soleone/factory` to npm locally rather than building native apps in Actions. Checks and tests run before releasing; `prepublishOnly` builds the CLI before publishing. Dry runs skip these hooks, so run the development checks above separately.

## License

MIT

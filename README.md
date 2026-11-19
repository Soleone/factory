# factory

Works a queue of coding tasks with headless `claude` and `pi`, until their usage limits run out. You pick tasks from what [workwork](https://github.com/Soleone/workwork) finds across your repos, or let auto mode keep the queue topped up. In the morning, the results list what each agent did, with the PR or issue it opened.

```sh
npm install -g @soleone/factory
factory serve    # http://127.0.0.1:7040
```

Needs node 22+, git, [workwork](https://github.com/Soleone/workwork) with `--json` support, and whichever of `claude` and `pi` you use, logged in.

## How it works

- **Repos** are yours on GitHub, cloned under `$SRC`, which is where workwork looks. In the Candidates tab, choose **Clone project...** from the repo dropdown to see the ones you haven't cloned yet, newest first, and clone one directly into `$SRC`.
- **Jobs** are workwork candidates in the queue. Your picks always go first, in the order you give them; auto jobs follow. A job can name its agent, model and effort. Once an agent has started a job, the job stays with that agent.
- **Auto mode** only fills the queue: while the factory is on, it keeps up to 5 of its jobs per agent queued, cheapest attention first, with repos taking turns. It never re-queues a candidate that already had a job. You can limit it to some levels and plays.
- **The factory** is what works the queue, one worker per agent. With nothing to do it waits, and it picks up new jobs within seconds. Turning it on starts a **run** with its own agents, models, efforts, limit and end time, defaulting to the settings.
- **Limits:** a limit of 1 (the default) stops an agent at its first usage-limit hit, so only the current allowance gets used. A limit of 2 waits for one reset and stops at the second hit. "None" always waits for the reset, which it logs. Once every agent has stopped, the factory turns itself off. Three quick failures in a row also count as a limit hit, so a broken login can't burn through the queue.
- **Failures:** a failed or timed-out job gets one more try by the same agent. After that it waits for you to retry it.
- **Agents report back** through the CLI, which factory names in each prompt: `note` for what's worth knowing later, `result` for a summary with a confidence, follow-up tasks and the PR link, and `ask` for the rare decision only you can make; the prompt tells agents to decide everything else themselves and note the call. A job whose agent asked waits for your answer, on the page or with `factory answer`. Then it goes back in the queue, and the next attempt gets the earlier notes, your answer and the branch with the earlier work. Retries get the same.
- **Jobs can wait on each other:** `--after <job>` holds one until the other is done, and drops it if the other fails or is removed (a retry brings it back). **Review with** queues a review of a job's PR by another agent, which posts its findings as a PR comment.

## Reviewing results

Results waiting for your answer come first under **Waiting for you**; a dot marks those that ended since you last looked. **Activity** lists everything that happened, newest first, with what the agents said. The tab, filter and an opened job stay in the URL, so a link opens the same view.

Each result links the PR or issue the agent opened. From the page you can read a PR's description and diff, merge it, rebase it onto its base when GitHub reports conflicts, or close it. Rebasing never guesses: if git stops on a conflict, nothing is pushed and the page lists the files.

**Merge train:** select several results and merge them in one go. PRs merge one after another per repo, since each merge moves the base under the next one; repos go in parallel. The train waits for checks, rebases a PR that conflicts, and skips one it can't merge, with the reason. What it did with each PR shows on the job and in Activity. When a rebase stops on real conflicts, a job to resolve them goes to the front of the queue, so an agent picks it up on the next run.

## Live Agent

Live Agent, the robot button right of the tabs, is a chat with an agent about what to queue. It reads the candidates, the queue and past results, proposes a few jobs that won't step on each other, and adds them through the CLI once you agree. It never turns the factory on, merges or closes PRs, or changes your repos. That is an instruction to the agent, not a sandbox: it has a shell, like the agents doing jobs. Results that failed, or that the train skipped, have an **Ask** button that starts the chat with the question already written.

Settings > Live Agent picks the agent (Claude Code or Pi), its model and effort. The same model and effort pickers serve runs. Model choices are short lists: Pi's scoped models (`enabledModels` in Pi's settings, the ones Ctrl+P cycles through), and Claude Code's current models (opus, sonnet, fable, haiku). The efforts on offer are the chosen model's. When one of Pi's extensions asks something mid-chat, the page shows the question. The chat survives a restart of `factory serve`: the page shows it again and the agent resumes its own session, so it still knows what was said. New chat starts over.

## Commands

The page and the CLI do the same things on the same state; `serve` is only an interface, and the factory runs without it.

```sh
factory start [run options]   # turn on, in the background (factory run: in the foreground)
factory stop                  # turn off; jobs in progress go back to the queue
factory status                # on or off, what each agent does, the queue
factory add <id>... [--repo DIR] [--agent NAME] [--model M] [--effort E] [--after JOB]
factory remove <job> | retry <job> | answer <job> "<text>"
factory review <job> --agent pi   # another agent reviews the job's PR once it's done
factory wait <job> [--timeout MIN] # block until it's done, failed or waiting for you
factory tail                      # follow every job event, one line each
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

- `settings.json`: registered agents with their model and effort, the agent Live Agent uses, limit, until, timeout, auto mode (on, levels, plays, repos)
- `jobs.jsonl`: append-only events (add, remove, move, start, attempt, requeue, retry), so the CLI, the factory and the page never overwrite each other
- `candidates.json`: the cached `workwork --all --json`, which takes minutes; refreshed from the page, or by auto mode when older than 6 hours
- `runs/<run>/<job>-<attempt>/`: `prompt.md` and `agent.log`
- `chat.json`, `chat.jsonl`, `chat-sessions/`: the Live Agent session, what the page shows, and Pi's session files (Claude Code keeps its own)
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

### Try the UI with dummy data

Run `pnpm dev:demo` and open [factory (demo)](http://localhost:7042). Browse sample candidates, reorder the queue, retry a failed job, review sample PRs, or try the run and settings controls. Turn on shows simulated workers without executing any jobs.

The demo does not start `factory serve`, call `workwork` or GitHub, or read or write your real Factory state. Changes are shared across tabs and reset when you restart the demo server.

### Release

From `main` with a clean working tree, authenticated Git push access, and pnpm logged in to npm (`pn whoami`):

```sh
pn release             # choose patch, minor or major, then confirm each step
pn release --dry-run   # preview without changing files, publishing or pushing
```

With Vite+, `pn` is shorthand for `pnpm`. The release command asks for the version, updates `CHANGELOG.md` from conventional commits, commits and tags `vX.Y.Z`, and pushes. Factory publishes `@soleone/factory` to npm locally rather than building native apps in Actions. Checks and tests run before releasing; `prepublishOnly` builds the CLI before publishing. Dry runs skip these hooks, so run the development checks above separately.

## License

MIT

# factory

Runs your coding agents overnight. Say `factory start` before bed: it takes the candidates [workwork](https://github.com/Soleone/workwork) finds across your repos, cheapest human attention first, and hands them one at a time to headless `claude` and `pi`, each in a fresh git worktree, until their usage limits run out or the clock says stop. In the morning `factory report` lists what each agent did, with the PR or issue it opened.

```sh
npm install -g @soleone/factory
```

Needs node 22+, git, [workwork](https://github.com/Soleone/workwork) 0.2+ (for `--json`), and whichever of `claude` and `pi` you use, logged in.

```sh
factory start [--until 08:00] [--windows 2] [--agents claude,pi] [--levels auto,skim,decide] [--max-items N]
factory run   [same flags]   # the same loop in the foreground; start = run, detached
factory status               # running or not, what each worker is doing, counts
factory stop                 # stops the loop and its agents; unfinished items go back in the queue
factory report [--all]       # the last run (or every run): outcome, agent, item, PR/issue link or log
```

Also `--timeout MIN` (default 60) per item, and `--claude-model` / `--pi-model`, passed through as `--model`. There is no config file.

## How a night goes

One worker per agent, all taking from one queue that a single process hands out, so two agents never get the same item. The queue is `workwork --all --json`, minus what the ledger says is done, auto before skim before decide, taking turns between repos so one repo doesn't take the night. When it runs dry it asks workwork again; when workwork has nothing new, the run ends.

For each item: `git fetch`, `git worktree add --detach` at `origin/HEAD` (your checkout is never touched), `workwork prompt <id>` on the agent's stdin, output to `agent.log`. The agent runs in its own process group and is killed with everything it started after `--timeout`. A worktree with commits that aren't on a remote, or with uncommitted changes, is kept and the report says where; otherwise it's removed.

A failed or timed-out item gets one more try, by the other agent. After two failures it's skipped for good.

## Limits and windows

When an agent hits its usage limit, the item goes back to the front of the queue and that worker sleeps until the reset time in the message, plus 2 minutes (30 minutes when the message doesn't say). After its `--windows`th limit (default 2: the current 5-hour window and the next one) the worker stops. The run ends when every worker has stopped, `--until` has passed (nothing new starts after it), or `--max-items` have started.

The limit messages are the ones the tools really print: Claude Code's `You've hit your session limit · resets 3pm (Europe/Berlin)` (and weekly, Opus, Sonnet, spend limits, with or without a date) and the older `Claude AI usage limit reached|<epoch>`; pi's `You have hit your ChatGPT usage limit (plus plan). Try again in ~42 min.` and the raw `usage_limit_reached` / `resets_in_seconds`. Three failures in a row that each took under a minute count as a limit too, so a broken login or a message nobody has seen yet can't burn through the queue.

`--until` and resets without a time zone use the machine's local time; set `TZ` if that isn't yours.

## State

In `$DATA/apps/factory/` when `DATA` is set, otherwise `~/.local/share/factory/`:

- `ledger.jsonl`: one line per finished attempt, `{run, id, repo, play, level, agent, start, end, outcome, url?, log, worktree?, error?}`; outcome is `done`, `failed`, `limited` or `timeout`
- `runs/<run>/<item>/`: `prompt.md` and `agent.log`
- `worktrees/<run>/<item>/`: kept worktrees
- `factory.pid`, `factory.log`: the running loop and its output
- `status.json`: rewritten on every change, read by `factory status`

An item that was running when the loop stopped has no ledger line, so the next run takes it again.

## Why not an LLM loop

This replaces an assistant that ran the night from inside chat turns. It stopped whenever a turn ended, built its own queue, guards and "authorization" out of prompts, then got blocked by them, and rewrote its own instructions after every failure. The tasks themselves went fine. So here the loop is plain code, and a model only ever does one task, as a child process that exits. Nothing a model says decides what runs next, who gets it, or whether to keep going.

## Development

```sh
pnpm install
vp check && vp test run && pnpm exec knip
pnpm release   # tag, changelog, npm publish
```

## License

MIT

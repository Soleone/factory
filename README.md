# factory

Works coding tasks with headless `claude` and `pi`, until their usage limits run out. Two modes share one queue:

- **Maintenance:** small independent jobs from what [workwork](https://github.com/Soleone/workwork) finds across your repos. You pick them, or auto mode keeps the queue topped up overnight. In the morning, the results list what each agent did, with the PR it opened.
- **Goals:** one large task, split into a graph of jobs that run in dependency order, several at once where they don't touch the same files, each building on the last, across usage resets. Every job merges into the goal's own integration branch; the final PR into main is yours to merge.

```sh
npm install -g @soleone/factory
factory serve    # http://127.0.0.1:7040
```

Needs node 22+, git, [workwork](https://github.com/Soleone/workwork) 0.3 or later, `gh`, and whichever of `claude` and `pi` you use, logged in.

## How it works

- **Jobs** are what the agents work. A model only ever does one job, as a child process that exits. Scheduling, checks, merges, limits and retries are plain code.
- **Sessions:** an attempt at a job is one agent session. Factory talks to it as often as it needs: when the agent stops without reporting a result, or one of the job's checks (gates) fails, it sends up to two follow-ups in the same session, quoting how the run ended or what failed. After an answered question, a usage reset or a restart it resumes the session. Only a new attempt starts fresh, with the earlier attempts' notes and kept work.
- **Live:** both runners stream JSON events, so the page shows each worker's current tool call ("editing src/sidebar.rs") and context size without the agent's help, and agents report steps in their own words. An attempt times out only after `idle` minutes (default 10) without a sign of life; a long run that keeps working is never cut off.
- **Tiers:** a job can ask for `communicator` (taste and writing: decomposition, UX, copy), `builder` (architecture, tricky logic, reviews) or `grunt` (well-specified mechanical work). Settings list each tier's presets in order; a job runs on the first one whose usage limit isn't hit and has a free worker. A job that fails twice moves up a tier. Jobs without a tier (picks and auto mode) only run on the agents you start the run with, never on a tier's presets.
- **Pools and workers:** a pool is one account's usage limit (claude, or pi's provider). Each preset can run several workers; a limit hit pauses every worker of the pool until the reset. More workers on one pool spend its allowance sooner; the gain is across pools.
- **Compaction:** each preset compacts its context at `compactAt` tokens (200k, 90k for Haiku, below their price steps). Claude Code gets `--autocompact`; pi reads it from its own settings, so factory checks those at start-up and prints what to add if they don't match.
- **Worktrees:** a pool of worktrees per repo, under the state folder, reused from job to job so installed dependencies survive. A job's worktree stays with it while it waits for an answer. Before a new job it's reset; untracked files go, ignored ones stay. Commits or changes an agent leaves unpushed are saved to `factory/<job>-<attempt>`. Your own checkout is never touched.
- **Touches:** jobs that say which files they change (globs) never run at the same time as another job that may change the same ones.

### Maintenance

- Picks go first, in the order you give them; auto jobs follow. While the factory is on, auto mode keeps up to 5 of its jobs per worker queued, cheapest attention first, with repos taking turns, and never re-queues a candidate that already had a job.
- **Limits:** a limit of 1 (the default) stops a pool at its first usage-limit hit, so only the current allowance gets used. A limit of 2 waits for one reset; "none" always waits. Three quick failures in a row stop a worker, so a broken login can't burn through the queue.
- **Reserves:** `reserves` keeps a percent of a pool's 5-hour window for other apps on the same subscription. Once the window reaches it, the pool starts nothing new until the window resets; jobs already running finish, so leave room for them. Factory reads the window at most once a minute, for `claude` and pi's `anthropic` and `openai-codex`; when a read fails, nothing is held and the usage-limit hits still apply.
- **Failures:** a job that fails gets one more attempt; then it waits for you to retry it, and jobs that wait on it are held until then.
- **Reviewing results:** each result links its PR. From the page you can read its description and diff, merge it, rebase it, or close it, and put several on the **merge train**, which merges them one after another per repo, rebasing as it goes. A rebase that stops on real conflicts queues a job to resolve them.

### Goals

```sh
factory goal new "GPUI client for Tasks" --repo ~/src/tasks --brief brief.md   # or --project NAME
factory goal show gpui-client       # the graph before anything runs: tiers, critical path, estimate
factory goal approve gpui-client
```

- **Starting one:** **New goal** on the Goals tab (the Goal view of **Add work**) takes a title, a repo and a brief, or a plan to import. **New project...** in its repo list creates `$SRC/<name>` and a private GitHub repo of the same name (`goal new --project NAME` on the command line). The Live Agent can work out the brief with you and start the goal too; approving its plan stays with you.
- **Planning:** `goal new` queues a communicator to decompose the goal into a plan, which factory validates and imports, then waits for your approval. `goal import plan.json` takes a plan you wrote, with someone or something else; [spec/plan-format.md](spec/plan-format.md) describes the format (JSON or YAML) and `goal check` validates one.
- **Branches:** the goal gets `goal/<slug>` on origin. Each node works on `node/<slug>/<key>`, started from the integration branch's head; it commits and pushes but never opens a PR. Factory runs its gates, rebases it onto the integration branch, opens the PR and merges it, then runs the goal's own gates. A conflict queues a job to resolve it; a red integration branch pauses the goal and queues a fix.
- **Memory:** `.factory/<slug>.md` on the integration branch holds the goal's summary and the decisions each node leaves for the next. Prompts carry the goal summary, what a node's dependencies delivered, and a pointer to the memory.
- **Checkpoints:** a node can pause the goal for your approval once it's merged, and so does an attempt budget when it runs out (approving adds the same again). At each milestone (a node with children, done) factory rebases the integration branch onto main and queues a replan; a node that fails for good queues one too. A replan may change only what hasn't started, and one that changes more than a quarter of it waits for you.
- **Reviews:** a node can ask for a review by another tier before it merges; findings become a fix on its branch.
- **Needs:** a node that needs something no worker has (`display`, `gpu`, an emulator) still runs, verifies what it can, and lands on the unverified checklist for you.
- **In Tasks:** with `"store": "tasks"` and `"tasks": { "home": "..." }` in settings, goals and their nodes also show in a Tasks home, kept in step every few seconds. Canceling one there, editing a node that hasn't started, or adding a subtask under a goal (tag it #grunt, #builder or #communicator) comes back to factory.

## Agents report back

Through the CLI, which factory names in each prompt (the job is `$FACTORY_JOB`):

```sh
factory step "<what you're doing>" [--done N --of M]   # progress; the page shows the latest
factory note "<text>"                                  # worth knowing later
factory ask "<question>" --assume "<default>"          # carry on with the default; you answer later
factory ask "<question>"                               # the job waits for your answer
factory result "<summary>" --confidence high --url LINK --followup "<task>" --unverified "<what>"
```

The prompt tells agents to decide what a reasonable engineer would and note the call. An assumption you answer with "fine" closes; any other answer queues a job to change it. A plain question pauses the job until you answer, on the page or with `factory answer`, and the same session picks up from there. `factory report` ends with what waits on you: unverified work and assumptions to confirm.

On the page, everything that waits on you collects in the **Inbox**, which the page opens on while anything blocks work. On top, what holds work up until you act: questions, goal checkpoints and plans to approve, and jobs that failed twice. Below, what agents carried on past: PRs to merge, assumptions to confirm and work to verify. **Add work** gathers every way in: a job of your own, a goal, candidates and blueprints. Activity sits next to Results.

## Live Agent

Live Agent, the robot button right of the tabs, is a chat with an agent about what to queue. It reads the candidates, the queue and past results, proposes a few jobs that won't step on each other, and adds them through the CLI once you agree. It never turns the factory on, merges or closes PRs, or changes your repos. That is an instruction to the agent, not a sandbox: it has a shell, like the agents doing jobs. Results that failed, or that the train skipped, have an **Ask** button that starts the chat with the question already written.

Settings > Live Agent picks the agent (Claude Code or Pi), its model and effort. Model choices are short lists: Pi's scoped models (`enabledModels` in Pi's settings) and Claude Code's current models. The chat survives a restart of `factory serve`.

## Commands

The page and the CLI do the same things on the same state; `serve` is only an interface, and the factory runs without it.

```sh
factory start [run options]   # turn on, in the background (factory run: in the foreground)
factory stop [--kill]         # turn off; agents at work finish their turn, the next start records it
factory status                # on or off, each pool and its workers, the queue
factory add <id>... [--repo DIR] [--agent NAME] [--model M] [--effort E] [--after JOB]...
factory add --prompt FILE --tier grunt [--repo DIR]   # a job of your own, without workwork
factory remove <job> | retry <job> | answer <job> "<text>" | verify <job> [NEED]
factory review <job> --agent pi   # another agent reviews the job's PR once it's done
factory wait <job> [--timeout MIN]
factory tail                      # follow every job event, one line each
factory auto on|off
factory report [--all]            # the last run (or every run), then what waits on you
factory goal new|import|check|show|approve|pause|resume|cancel|replan ...
factory serve [--port 7040] [--host 127.0.0.1]
```

Run options: `--agents claude,pi` (a worker each, for jobs without a tier), `--limit N|none` (per pool), `--until HH:MM` (start nothing new after), `--model claude=opus`, `--effort pi=high` (claude's `--effort`, pi's `--thinking`), `--idle MIN`.

`serve` listens on 127.0.0.1. Anyone who can reach it can queue jobs and turn the factory on, and the agents run with full permissions, so it amounts to running commands on your machine. Reach it from a phone through something like `tailscale serve`, not with `--host 0.0.0.0` on a network you don't trust.

## Settings

`settings.json` in the state folder, also edited from the page:

```json
{
  "agents": { "claude": {}, "pi": {} },
  "presets": [
    { "id": "opus", "agent": "claude", "model": "opus", "effort": "high" },
    {
      "id": "sol",
      "agent": "pi",
      "model": "openai-codex/gpt-6.2-sol",
      "effort": "high",
      "workers": 2
    },
    {
      "id": "luna",
      "agent": "pi",
      "model": "openai-codex/gpt-6-luna",
      "effort": "max",
      "workers": 3
    },
    { "id": "haiku", "agent": "claude", "model": "haiku", "workers": 2 }
  ],
  "tiers": { "communicator": ["opus"], "builder": ["sol", "opus"], "grunt": ["luna", "haiku"] },
  "limit": 1,
  "reserves": { "openai-codex": 5 },
  "idle": 10,
  "capabilities": ["display"],
  "env": {
    "/home/me/src/tasks": { "RUSTC_WRAPPER": "sccache", "CARGO_TARGET_DIR": "{worktree}/target" }
  },
  "store": "local"
}
```

A preset may also set `pool` (default: claude, or pi's provider), `compactAt` and `followups` (default 2). `env` applies per repo to agents and gates; `{worktree}` becomes the worktree's path. A tier without presets runs on the run's agents.

## State

In `$DATA/apps/factory/` when `DATA` is set, otherwise `~/.local/share/factory/`:

- `settings.json`
- `jobs.jsonl`: append-only events, so the CLI, the factory and the page never overwrite each other; the queue, goals and results are what replaying it gives
- `candidates.json`: the cached `workwork --all --json`, refreshed from the page, or by auto mode when older than 6 hours
- `runs/<run>/<job>-<attempt>/`: `prompt.md`, `turn-N.md` for each later turn, and `agent.log` with the runner's event stream
- `running/<job>.json`: an attempt in progress or paused: its session, worktree and turn
- `sessions/`: pi's session files for job attempts (Claude Code keeps its own)
- `chat.json`, `chat.jsonl`, `chat-sessions/`: the Live Agent
- `worktrees/<repo>/<n>/`
- `status.json`, `factory.pid`, `factory.log`: the current run, its pools and workers

## Why not an LLM loop

This replaces an assistant that ran the night from inside chat turns. It stopped whenever a turn ended, built its own queue, guards and "authorization" out of prompts, then got blocked by them, and rewrote its own instructions after every failure. The tasks themselves went fine. So here the loop is plain code, and a model only ever does one task, as a child process that exits. Nothing a model says decides what runs next, except through a plan that code validates.

## Development

```sh
pnpm install
pn dev
vp check && vp test run && kit check
```

The page is built on the [kit](https://github.com/Soleone/kit) web stack: Vite+, React, shadcn base-nova and the @soleone theme. `src/backend/` holds the CLI, the factory and the server; `src/` the page. `pn dev` runs Vite with hot reload at http://localhost:7040 in front of `factory serve` on 7041, which restarts when `src/backend/` changes. It uses your real state folder, so Turn on starts real agents. `pn build` bundles the CLI to `dist/cli.mjs` and the page to `dist/web/`. The Tasks store test runs against Tasks' own checkout (`$SRC/products/tasks/bin/tasks-cli`, or `TASKS_CLI`) and is skipped without it.

### Try the UI with dummy data

Run `pnpm dev:demo` and open [factory (demo)](http://localhost:7042). Browse sample candidates, reorder the queue, retry a failed job, review sample PRs, open the sample goal's graph, or try the run and settings controls. Turn on shows simulated workers without executing any jobs.

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

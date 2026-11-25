# factory

Works coding tasks with headless `claude` and `pi`, until their usage limits run out. Two modes share one queue:

- **Maintenance:** small independent jobs from what [workwork](https://github.com/Soleone/workwork) finds across your repos. You pick them, or auto mode keeps the queue topped up overnight. In the morning, the results list what each agent did, with the PR it opened.
- **Goals:** one large task, split into a graph of jobs that run in dependency order, several at once where they don't touch the same files, each building on the last, across usage resets. Every job merges into the goal's own integration branch; the final PR into main is yours to merge.

```sh
npm install -g @soleone/factory
factory serve    # http://127.0.0.1:7040
```

Needs node 22+, git, [workwork](https://github.com/Soleone/workwork) 0.3 or later, `gh`, and whichever of `claude` and `pi` you use, logged in. Images need `codex`, logged in to ChatGPT.

## How it works

- **Jobs** are what the agents work. A model only ever does one job, as a child process that exits. Scheduling, checks, merges, limits and retries are plain code.
- **Sessions:** an attempt at a job is one agent session. Factory talks to it as often as it needs: when the agent stops without reporting a result, or one of the job's checks (gates) fails, it sends up to two follow-ups in the same session, quoting how the run ended or what failed. After an answered question, a usage reset or a restart it resumes the session; a session that was never saved (a run stopped before the agent got going) starts over from the prompt, in the same worktree. Only a new attempt starts fresh, with the earlier attempts' notes and kept work.
- **Live:** both runners stream JSON events, so the page shows each worker's current tool call ("editing src/sidebar.rs") and context size without the agent's help, and agents report steps in their own words. An attempt times out only after `idle` minutes (default 10) without a sign of life; a long run that keeps working is never cut off.
- **Tiers:** a job can ask for `communicator` (taste and writing: decomposition, UX, copy), `builder` (architecture, tricky logic, reviews) or `grunt` (well-specified mechanical work). Settings list each tier's presets in order; a job runs on the first one whose usage limit isn't hit and has a free worker. A job that fails twice moves up a tier. The page calls tiers roles. A pick can get one from the arrow next to Queue; without one, a job goes to the first free worker in settings order, and so does a job whose tier lists no running worker.
- **Pools and workers:** every worker comes from a preset (the page's Workers tab), one each by default, in the order they take queue work; 0 keeps a preset for pinning jobs to only. A pool is one account's usage limit (claude, or pi's provider). Each preset can run several workers; a limit hit pauses every worker of the pool until the reset. More workers on one pool spend its allowance sooner; the gain is across pools.
- **Compaction:** each preset compacts its context at `compactAt` tokens (200k, 90k for Haiku, below their price steps). Claude Code gets `--autocompact`; pi reads it from its own settings, so factory checks those at start-up and prints what to add if they don't match.
- **Worktrees:** a pool of worktrees per repo, under the state folder, reused from job to job so installed dependencies survive. A job's worktree stays with it while it waits for an answer. Before a new job it's reset; untracked files go, ignored ones stay. Commits or changes an agent leaves unpushed are saved to `factory/<job>-<attempt>`. Your own checkout is never touched.
- **Machine jobs:** a worktree keeps jobs' files apart, not the rest of the computer. Jobs run side by side and are told to change nothing outside their worktree: no global installs, no home config, no services left running, no fixed ports, no git stash. A job that has to is a machine job, and runs while no other job does; while one waits, nothing new starts. Mark one with `--machine` on `factory add`, the switch on the page's New job form, or `"machine": true` on a plan node. An agent that finds out mid-job runs `factory alone "<why>"`, and its session goes on once it's alone.
- **Touches:** jobs that say which files they change (globs) never run at the same time as another job that may change the same ones.

### Maintenance

- Picks go first, in the order you give them; auto jobs follow. While the factory is on, auto mode keeps up to 5 of its jobs per worker queued, cheapest attention first, with repos taking turns, and never re-queues a candidate that already had a job.
- **Triggers:** while the factory is on, it checks GitHub every 5 minutes in the repos it has jobs in, and queues one job per event: CI failing on the default branch queues a fix, an open issue labeled `factory` queues a job for it, and your review or comment on a factory PR queues a job that pushes to the same branch. Remarks made while an agent worked on that PR don't count, since agents post with your account. Settings → GitHub turns each one off or changes the label.
- **Commit identity:** set a name and email in Settings → GitHub to use them for commits in Factory worktrees. **Use GitHub profile** fills the fields from the signed-in `gh` account with its GitHub noreply address; review and save to apply it. Leave both fields blank to use Git's existing configuration. If Git can't provide an identity either, Factory reports a setup error before launching the agent; fix the identity, then retry the job.
- **Limits:** a limit of 1 (the default) stops a pool at its first usage-limit hit, so only the current allowance gets used. A limit of 2 waits for one reset; "none" always waits. Three quick failures in a row stop a worker, so a broken login can't burn through the queue.
- **Reserves:** `reserves` keeps a percent of a pool's 5-hour window for other apps on the same subscription. Once the window reaches it, the pool starts nothing new until the window resets; jobs already running finish, so leave room for them. Factory reads the window at most once a minute, for `claude` and pi's `anthropic` and `openai-codex`; when a read fails, nothing is held and the usage-limit hits still apply.
- **Failures:** a job that fails gets one more attempt; then it waits for you to retry it, and jobs that wait on it are held until then.
- **Reviewing results:** each result links its PR. From the page you can read its description and diff, merge it, rebase it, or close it, and put several on the **merge train**, which merges them one after another per repo, rebasing as it goes. A rebase that stops on real conflicts queues a job to resolve them. **Review** has another role check the PR (a builder, or a communicator for a builder's work); it comments what it found, and the findings queue a fix on the same PR by the author's role.

### Goals

```sh
factory goal new "GPUI client for Tasks" --repo ~/src/tasks --brief brief.md   # or --project NAME
factory goal show gpui-client       # the graph before anything runs: tiers, critical path, estimate
factory goal approve gpui-client
```

- **Starting one:** the Goal view of **Add work** takes a title, a repo and a brief, or a plan to import. **New project...** in its repo list creates `$SRC/<name>` and a private GitHub repo of the same name (`goal new --project NAME` on the command line). The Live Agent can work out the brief with you and start the goal too; approving its plan stays with you.
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

The prompt tells agents to decide what a reasonable engineer would and note the call. An assumption you answer with "fine" closes; any other answer queues a job to change it. A plain question pauses the job until you answer, on the page or with `factory answer`, and the same session picks up from there. Nobody may be awake to answer, so after 15 minutes without one the agent goes with its recommendation and records it as an assumption you can still overrule. `factory report` ends with what waits on you: unverified work and assumptions to confirm.

On the page, everything that waits on you collects in the **Inbox**, which the page opens on while anything blocks work. On top, what holds work up until you act: questions, goal checkpoints and plans to approve, and jobs that failed twice. Below, what agents carried on past: PRs to merge, assumptions to confirm and work to verify. `factory inbox` prints the same two groups with their counts, each row with its job id and PR, from the running `factory serve` so PR states match the page. **Add work** gathers every way in: a job of your own, a goal, candidates and blueprints. Activity sits next to Results. `g` then `i`, `q`, `g` or `r` jumps to Inbox, Queue, Goals or Results.

## Images

Add work → Image queues image jobs: prompts for `codex exec` and its built-in image_gen. They wait in the queue like any job and run on **codex workers** (Settings → Workers, agent Codex), which take image jobs and nothing else, so they run overnight with the rest. A codex worker counts against the `openai-codex` pool, the same ChatGPT account as pi's openai-codex workers: a usage limit puts the job back and the worker sleeps until the reset, and a reserve on `openai-codex` holds it too. Pasting into the prompt adds reference images.

- **Project:** with one picked, codex reads it for context and existing images to match, in a read-only sandbox. The images never go into the repo: each job's images stay in `images/<job id>/` in the state folder. Generate again adds its new images to the ones before.
- **Expand the prompt first** (on by default) has codex write a full brief from a short prompt and generate from that; the page shows the brief. Settings → Images changes how it expands.
- **Variants of each:** a prompt can ask for several images; this many of each come back, to pick from.
- **In Results** an image job is a row like any other, with its latest images small; its pop-up opens on all of them, and Generate again runs it once more. Dismissing it deletes its images. An image opens large, to download, use as a reference for the next prompt, or, in a project, queue a grunt job that copies it in and opens a PR.

## Live Agent

Live Agent, the robot button right of the tabs, is a chat with an agent about what to queue and what to do with the results. It reads the candidates, the queue and past results, proposes a few jobs that won't step on each other, and adds them through the CLI once you agree, candidates or a prompt of its own. Ask it to review results and it reads their PRs and says what it would merge and what it would close; once you agree it puts them on the merge train, rebases, closes, queues follow-ups, retries and cleans up. It can reorder and pin the queue and answer the Inbox as you tell it. It never approves a goal's plan, turns the factory on or off, or changes your repos other than through the CLI. That is an instruction to the agent, not a sandbox: it has a shell, like the agents doing jobs. Results that failed, or that the train skipped, have an **Ask** button that starts the chat with the question already written.

The chat's title in the agent's header opens a searchable list of earlier chats; picking one replays it and the agent resumes that session. Only one agent runs at a time, so opening another chat stops a reply still running. **+** starts a new chat, named after its first message. The model badge under the composer picks the agent, model and effort for the next message, like Settings > Live Agent; another agent starts a new chat, and every chat keeps the agent it started with. Model choices are short lists: Pi's scoped models (`enabledModels` in Pi's settings) and Claude Code's current models. Chats survive a restart of `factory serve`.

## Commands

The page and the CLI do the same things on the same state; `serve` is only an interface, and the factory runs without it. `factory` alone prints the basics, and `factory help <topic>` the rest, one topic at a time.

```sh
factory start [run options]   # turn on, in the background (factory run: in the foreground)
factory stop [--kill]         # turn off; agents at work finish their turn, the next start records it
factory status                # on or off, each pool and its workers, the queue
factory add <id>... [--repo DIR] [--tier T | --preset ID | --agent NAME --model M --effort E] [--after JOB]...
                              # use the candidates the page lists; ask workwork only for missing ids
factory add --prompt FILE --tier grunt [--repo DIR]   # a job of your own, without workwork
factory move <job> <N> | pin <job> [--tier T | --preset ID | --agent NAME]
factory remove <job> | retry <job> | answer <job> "<text>" | verify <job> [NEED]
factory review <job> [--agent pi] # another role (or agent) reviews the PR; findings queue a fix
factory merge <job>...           # put their PRs on the merge train of the running serve
factory rebase <job> | close <job> | followup <job> "<task>"
factory wait <job> [--timeout MIN]
factory tail                      # follow every job event, one line each
factory auto on|off
factory report [--all]            # the last run (or every run), then what waits on you
factory inbox                     # the page's Inbox, read from the running serve
factory goal new|import|check|show|approve|pause|resume|cancel|replan|tier|drop|export ...
factory serve [--port 7040] [--host 127.0.0.1]
```

Run options: `--workers ID=N` (this run's count for a preset, repeat per preset), `--limit N|none` (per pool), `--until HH:MM` (start nothing new after), `--idle MIN`.

`serve` listens on 127.0.0.1. Anyone who can reach it can queue jobs and turn the factory on, and the agents run with full permissions, so it amounts to running commands on your machine. Reach it from a phone through something like `tailscale serve`, not with `--host 0.0.0.0` on a network you don't trust.

## Settings

`settings.json` in the state folder, also edited from the page:

```json
{
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

A preset's `workers` defaults to 1. It may also set `pool` (default: claude, or pi's provider), `compactAt` and `followups` (default 2). `env` applies per repo to agents and gates; `{worktree}` becomes the worktree's path. Settings from before 0.6 had `agents`, a hidden worker each; they become the first presets on the next read.

## State

In `$DATA/apps/factory/` when `DATA` is set, otherwise `~/.local/share/factory/`:

- `settings.json`
- `jobs.jsonl`: append-only events, so the CLI, the factory and the page never overwrite each other; the queue, goals and results are what replaying it gives
- `triggers.json`: the events triggers already queued a job for
- `candidates.json`: what workwork found in each of your repos under $SRC, refreshed from the page (every repo, one project or one blueprint), or by auto mode when older than 6 hours
- `runs/<run>/<job>-<attempt>/`: `prompt.md`, `turn-N.md` for each later turn, and `agent.log` with the runner's event stream
- `running/<job>.json`: an attempt in progress or paused: its session, worktree and turn
- `sessions/`: pi's session files for job attempts (Claude Code keeps its own)
- `chats.json`, `chats/`, `chat-sessions/`: the Live Agent's chats
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

The page is built on the [kit](https://github.com/Soleone/kit) web stack: Vite+, React, shadcn base-nova and the @soleone theme. `src/backend/` holds the CLI, the factory and the server; `src/` the page. `pn dev` runs Vite with hot reload at http://localhost:7040 in front of `factory serve` on 7041, which restarts when `src/backend/` changes. It uses your real state folder, so Turn on starts real agents. `pn build` bundles the CLI to `dist/cli.mjs` and the page to `dist/web/`. The Tasks store test runs against Tasks' own checkout (`$SRC/products/tasks/bin/tasks-cli`, or `TASKS_CLI`) and is skipped without it. The goal export test fakes `zip` and checks what it was given; the real-archive test, `vp test run tests/factory.test.ts -t "real zip"`, needs `zip` and `unzip` on PATH and is skipped without them.

### Try the UI with dummy data

Run `pnpm dev:demo` and open [factory (demo)](http://localhost:7042). Browse sample candidates, reorder the queue, retry a failed job, review sample PRs, open the sample goal's graph, look at a sample image job's variants, or try the run and settings controls. Turn on shows simulated workers without executing any jobs.

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

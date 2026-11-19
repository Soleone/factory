import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { agent as makeAgent, classify, resetTime, type Agent } from "./agents.ts";
import { addJobs, autoPicks, endJob, nextJob, readJobs, requeueJob, startJob } from "./jobs.ts";
import { findPr } from "./review.ts";
import { alive, output, readCandidates, readSettings, refreshCandidates } from "./state.ts";
import type { Attempt, Item, Job, Outcome, Status, Tuning, Worker } from "./types.ts";

export type RunOptions = {
  /** The agents of this run, each with its model and effort. */
  agents: Record<string, Tuning>;
  /** Usage-limit hits per agent before it stops; null: always wait for the reset. */
  limit: number | null;
  /** Epoch ms after which nothing new starts. */
  until?: number;
  timeoutMs: number;
  state: string;
  /** The workwork command; tests swap in a script. */
  workwork: string;
  /** Stops the run like SIGTERM does, or like SIGINT when aborted with the reason "kill". */
  signal?: AbortSignal;
  /** How often an idle worker looks for new jobs. */
  pollMs?: number;
  /** Tests record the waits for a limit reset instead of sleeping through them. */
  sleep?: (ms: number) => Promise<void>;
};

const MINUTE = 60_000;
/** Auto mode keeps this many of its jobs queued per agent, so picks never drown in them. */
const AUTO_PER_AGENT = 5;
const STALE_CANDIDATES = 6 * 60 * MINUTE;
/**
 * An agent at work, kept in running/<job id>.json until its attempt is recorded. A run that stops
 * leaves its agents working, and the next run finishes their attempts from this.
 */
type Live = { begun: Begun; pid: number; worktree: string };
type Begun = Pick<Attempt, "run" | "agent" | "model" | "effort" | "start" | "log">;

const livePath = (state: string, id: string) => join(state, "running", `${id}.json`);

const URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(?:pull|issues)\/\d+/g;

/** Works the queue until every agent is out of limits, until passes, or it's stopped; returns the run id. */
export async function run(options: RunOptions): Promise<string> {
  const { state } = options;
  const id = new Date().toISOString().slice(0, 19).replaceAll(":", "");
  const runDir = join(state, "runs", id);
  mkdirSync(runDir, { recursive: true });
  mkdirSync(join(state, "running"), { recursive: true });
  const agents = new Set<number>();
  const wakers = new Set<() => void>();
  const workers: Worker[] = Object.entries(options.agents).map(([agent, tuning]) => ({
    agent,
    ...tuning,
    state: "idle",
    since: new Date().toISOString(),
    limits: 0,
  }));
  let stopping = false;
  let killing = false;
  let topping: Promise<void> | undefined;

  function writeStatus(): void {
    const until = options.until ? new Date(options.until).toISOString() : undefined;
    const status: Status = { pid: process.pid, run: id, until, limit: options.limit, workers };
    writeFileSync(join(state, "status.json"), `${JSON.stringify(status, null, 2)}\n`);
  }

  function set(worker: Worker, change: Partial<Worker>): void {
    Object.assign(worker, { job: undefined, until: undefined, reason: undefined }, change);
    worker.since = new Date().toISOString();
    writeStatus();
  }

  /** Starts nothing new; agents keep working for the next run to finish, unless killed. */
  function stop(kill: boolean): void {
    stopping = true;
    killing ||= kill;
    if (kill) for (const pid of agents) killGroup(pid);
    for (const wake of wakers) wake();
  }
  const handOff = () => stop(false);
  const kill = () => stop(true);
  const aborted = () => stop(options.signal?.reason === "kill");

  function ended(): string | undefined {
    if (stopping) return "turned off";
    if (options.until && Date.now() >= options.until) return "until passed";
  }

  /** A wait that stopping cuts short. */
  function nap(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        wakers.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, ms);
      wakers.add(wake);
    });
  }

  /** Auto mode's part: keep a few of its jobs queued. Reads settings each time, so the toggle applies at once. */
  function topUp(): void {
    topping ??= fillFromAuto()
      .catch((error: Error) => log(`auto mode could not ask workwork: ${error.message}`))
      .finally(() => (topping = undefined));
  }

  async function fillFromAuto(): Promise<void> {
    const { auto } = readSettings(state);
    if (!auto.on) return;
    const wanted = () =>
      AUTO_PER_AGENT * workers.length -
      readJobs(state).filter((job) => job.source === "auto" && job.state === "queued").length;
    if (wanted() <= 0) return;
    const cached = readCandidates(state);
    if (!cached || Date.now() - Date.parse(cached.at) > STALE_CANDIDATES)
      await refreshCandidates(state, options.workwork);
    const candidates = readCandidates(state);
    if (!candidates) return;
    const added = addJobs(
      state,
      autoPicks(candidates.items, readJobs(state), auto, wanted()),
      "auto",
    );
    if (added.length) log(`auto mode queued ${added.length}`);
  }

  async function work(worker: Worker, handed?: Handed): Promise<void> {
    let quickFailures = 0;
    while (!ended()) {
      topUp();
      let job: Job | undefined;
      let attempt: Attempt | undefined;
      if (handed) {
        ({ job } = handed);
        set(worker, { state: "working", job: job.id });
        log(`${worker.agent} takes over ${job.id} from run ${handed.live.begun.run}`);
        attempt = await finish(job, handed.live);
        handed = undefined;
      } else {
        job = nextJob(readJobs(state), worker.agent);
        if (!job) {
          if (worker.state !== "idle") set(worker, { state: "idle" });
          await nap(options.pollMs ?? 3000);
          continue;
        }
        startJob(state, job.id, worker.agent);
        set(worker, { state: "working", job: job.id });
        log(`${worker.agent} starts ${job.id}: ${job.item.label} ${job.item.id}`);
        attempt = await attemptJob(worker, job);
      }
      if (!attempt) {
        // Without a live agent it stopped before the agent started.
        if (!existsSync(livePath(state, job.id))) requeueJob(state, job.id);
        break;
      }
      endJob(state, job.id, attempt);
      rmSync(livePath(state, job.id), { force: true });
      log(`${worker.agent} ${attempt.outcome} ${job.id} ${attempt.url ?? attempt.error ?? ""}`);
      const seconds = (Date.parse(attempt.end) - Date.parse(attempt.start)) / 1000;
      quickFailures = attempt.outcome === "failed" && seconds < 60 ? quickFailures + 1 : 0;
      if (quickFailures >= 3)
        return set(worker, {
          state: "stopped",
          reason: `3 failures in a row under a minute; last: ${attempt.error?.split("\n")[0] ?? "see its log"}`,
        });
      if (attempt.outcome !== "limited") {
        set(worker, { state: "idle" });
        continue;
      }
      worker.limits++;
      if (options.limit !== null && worker.limits >= options.limit)
        return set(worker, {
          state: "stopped",
          reason: `limit ${worker.limits} of ${options.limit}`,
        });
      const reset = resetTime(readFileSync(attempt.log, "utf8"), Date.now());
      const wake = Math.min(
        reset === undefined ? Date.now() + 30 * MINUTE : reset + 2 * MINUTE,
        options.until ?? Infinity,
      );
      set(worker, { state: "sleeping", until: new Date(wake).toISOString() });
      log(
        `${worker.agent} hit limit ${worker.limits}, sleeps until ${new Date(wake).toISOString()}`,
      );
      await (options.sleep ?? nap)(wake - Date.now());
    }
    set(worker, { state: "stopped", reason: ended() });
  }

  /** One attempt in the agent's worktree for the repo; undefined when the run was stopped meanwhile. */
  async function attemptJob(worker: Worker, job: Job): Promise<Attempt | undefined> {
    const tuning = { model: job.model ?? worker.model, effort: job.effort ?? worker.effort };
    const agent = makeAgent(worker.agent, tuning);
    const slug = `${job.id}-${job.attempts.length + 1}`;
    const dir = join(runDir, slug);
    mkdirSync(dir, { recursive: true });
    const logPath = join(dir, "agent.log");
    const repoKey = createHash("sha256").update(job.item.repo).digest("hex");
    const worktree = join(state, "worktrees", agent.name, repoKey);
    const begun: Begun = {
      run: id,
      agent: agent.name,
      ...tuning,
      start: new Date().toISOString(),
      log: logPath,
    };
    let prompt: string;
    try {
      await checkout(worktree, job.item.repo);
      prompt =
        job.prompt ?? (await output(options.workwork, ["prompt", job.item.id], job.item.repo));
    } catch (error) {
      // The repo or workwork failed, not the agent: record why and move on.
      const message = (error as Error).message.trim();
      writeFileSync(logPath, `${message}\n`);
      return attempt(begun, "failed", { error: message.slice(0, 2000) });
    }
    writeFileSync(join(dir, "prompt.md"), prompt);
    if (stopping) return undefined;
    const live: Live = { begun, pid: startAgent(agent, worktree, dir), worktree };
    writeFileSync(livePath(state, job.id), JSON.stringify(live));
    return finish(job, live);
  }

  /** Waits for the agent, killing it at the timeout, and records what it did; undefined when the run hands it off. */
  async function finish(job: Job, { begun, pid, worktree }: Live): Promise<Attempt | undefined> {
    const dir = dirname(begun.log);
    const exit = join(dir, "exit");
    const deadline = Date.parse(begun.start) + options.timeoutMs;
    let timedOut = false;
    agents.add(pid);
    try {
      // The exit file first: after a long hand-off the pid may be some other process's by now.
      while (!existsSync(exit) && alive(pid)) {
        if (stopping && !killing) return undefined;
        if (!timedOut && Date.now() >= deadline) {
          timedOut = true;
          killGroup(pid);
        }
        await nap(Math.max(0, Math.min(options.pollMs ?? 1000, deadline - Date.now())));
      }
    } finally {
      agents.delete(pid);
    }
    // Whatever the agent left running in its group goes with it.
    killGroup(pid);
    const branch = await keepWork(worktree, `factory/${basename(dir)}`);
    if (killing) return attempt(begun, "stopped", { branch });
    const text = readFileSync(begun.log, "utf8");
    // No exit file: something killed the agent and its shell.
    const code = existsSync(exit) ? Number(readFileSync(exit, "utf8")) : 1;
    const agent = makeAgent(begun.agent, begun);
    const outcome = timedOut ? "timeout" : classify(agent, code, text);
    return attempt(begun, outcome, {
      url: (outcome === "done" && (await delivered(job.item))) || text.match(URL)?.at(-1),
      branch,
    });
  }

  /**
   * Jobs the last run left running: those with a live agent go to this run's worker for that agent;
   * the rest stopped before their agent started, so they go back to the queue.
   */
  const handed = new Map<string, Handed>();
  for (const job of readJobs(state)) {
    if (job.state !== "running") continue;
    if (!existsSync(livePath(state, job.id))) {
      requeueJob(state, job.id);
      continue;
    }
    const live: Live = JSON.parse(readFileSync(livePath(state, job.id), "utf8"));
    // One worker per agent, so each agent has at most one job to take over.
    handed.set(live.begun.agent, { job, live });
  }
  process.on("SIGTERM", handOff);
  process.on("SIGINT", kill);
  options.signal?.addEventListener("abort", aborted);
  writeStatus();
  try {
    await Promise.all(workers.map((worker) => work(worker, handed.get(worker.agent))));
  } catch (error) {
    kill();
    throw error;
  } finally {
    process.off("SIGTERM", handOff);
    process.off("SIGINT", kill);
    options.signal?.removeEventListener("abort", aborted);
    await topping;
    writeStatus();
  }
  return id;
}

type Handed = { job: Job; live: Live };

const attempt = (begun: Begun, outcome: Outcome, rest: Partial<Attempt> = {}): Attempt => ({
  ...begun,
  end: new Date().toISOString(),
  outcome,
  ...rest,
});

/**
 * The agent in its own process group, so a timeout or kill takes down everything it started, and
 * detached, so it outlives a run that hands it off. The shell in between reads the prompt from a file
 * and writes the exit code to one, both of which outlast this process. Returns the group's pid.
 */
function startAgent(agent: Agent, cwd: string, dir: string): number {
  const log = openSync(join(dir, "agent.log"), "w");
  const child = spawn(
    "sh",
    [
      "-c",
      'dir=$1; shift; "$@" <"$dir/prompt.md"; echo $? >"$dir/exit"',
      "sh",
      dir,
      agent.command,
      ...agent.args,
    ],
    { cwd, detached: true, stdio: ["ignore", log, log] },
  );
  closeSync(log);
  child.unref();
  return child.pid!;
}

/** The PR the agent opened, as GitHub knows it; undefined when gh can't tell, and the log's last link stands in. */
async function delivered(item: Item): Promise<string | undefined> {
  try {
    return await findPr(item);
  } catch (error) {
    log(`gh can't find the PR for ${item.id}: ${(error as Error).message.trim().split("\n")[0]}`);
    return undefined;
  }
}

/** The worktree at origin's fresh default branch; reused across jobs so installed dependencies survive. */
async function checkout(worktree: string, repo: string): Promise<void> {
  await output("git", ["fetch", "--quiet", "origin"], repo);
  // Asks origin itself: clones made with `git remote add` have no refs/remotes/origin/HEAD.
  const head = await output("git", ["ls-remote", "--symref", "origin", "HEAD"], repo);
  const branch = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(head)?.[1];
  if (!branch) throw new Error(`origin of ${repo} names no default branch`);
  const base = `origin/${branch}`;
  if (!existsSync(worktree)) {
    await output("git", ["worktree", "prune"], repo);
    await output("git", ["worktree", "add", "--quiet", "--detach", worktree, base], repo);
    return;
  }
  // Whatever a crashed run left here is kept before the reset; work the last attempt kept is already on its branch.
  await keepWork(worktree, `factory/leftover-${Date.now()}`, ["--remotes", "--branches"]);
  await output("git", ["checkout", "--quiet", "--force", "--detach", base], worktree);
  // Untracked files go; ignored ones like node_modules stay.
  await output("git", ["clean", "-fdq"], worktree);
}

/** Saves commits and changes that aren't on `saved` refs to a branch; returns its name, if there was any. */
async function keepWork(
  worktree: string,
  branch: string,
  saved = ["--remotes"],
): Promise<string | undefined> {
  if ((await output("git", ["status", "--porcelain"], worktree)).trim()) {
    await output("git", ["add", "-A"], worktree);
    await output(
      "git",
      ["commit", "--quiet", "--no-verify", "-m", "factory: changes the agent left uncommitted"],
      worktree,
    );
  }
  const unpushed = await output("git", ["log", "--oneline", "HEAD", "--not", ...saved], worktree);
  if (!unpushed.trim()) return undefined;
  await output("git", ["branch", "--force", branch, "HEAD"], worktree);
  return branch;
}

function killGroup(pid: number): void {
  for (const [signal, delay] of [
    ["SIGTERM", 0],
    ["SIGKILL", 10_000],
  ] as const)
    setTimeout(() => {
      try {
        process.kill(-pid, signal);
      } catch (error) {
        // The group is already gone.
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }, delay).unref();
}

function log(message: string): void {
  console.log(`${new Date().toISOString()} ${message}`);
}

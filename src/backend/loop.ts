import { spawn, type ChildProcess } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { agent as makeAgent, classify, resetTime, type Agent } from "./agents.ts";
import { addJobs, autoPicks, endJob, nextJob, readJobs, requeueJob, startJob } from "./jobs.ts";
import { output, readCandidates, readSettings, refreshCandidates } from "./state.ts";
import type { Attempt, Job, Status, Tuning, Worker } from "./types.ts";

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
  /** Stops the run like SIGTERM does. */
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
const URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(?:pull|issues)\/\d+/g;

/** Works the queue until every agent is out of limits, until passes, or it's stopped; returns the run id. */
export async function run(options: RunOptions): Promise<string> {
  const { state } = options;
  const id = new Date().toISOString().slice(0, 19).replaceAll(":", "");
  const runDir = join(state, "runs", id);
  mkdirSync(runDir, { recursive: true });
  const children = new Set<ChildProcess>();
  const wakers = new Set<() => void>();
  const workers: Worker[] = Object.entries(options.agents).map(([agent, tuning]) => ({
    agent,
    ...tuning,
    state: "idle",
    since: new Date().toISOString(),
    limits: 0,
  }));
  let stopping = false;
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

  function stop(): void {
    stopping = true;
    for (const child of children) killGroup(child);
    for (const wake of wakers) wake();
  }

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

  async function work(worker: Worker): Promise<void> {
    let quickFailures = 0;
    while (!ended()) {
      topUp();
      const job = nextJob(readJobs(state), worker.agent);
      if (!job) {
        if (worker.state !== "idle") set(worker, { state: "idle" });
        await nap(options.pollMs ?? 3000);
        continue;
      }
      startJob(state, job.id, worker.agent);
      set(worker, { state: "working", job: job.id });
      log(`${worker.agent} starts ${job.id}: ${job.item.label} ${job.item.id}`);
      const attempt = await attemptJob(worker, job);
      if (!attempt) {
        requeueJob(state, job.id);
        break;
      }
      endJob(state, job.id, attempt);
      log(`${worker.agent} ${attempt.outcome} ${job.id} ${attempt.url ?? attempt.error ?? ""}`);
      const seconds = (Date.parse(attempt.end) - Date.parse(attempt.start)) / 1000;
      quickFailures =
        attempt.outcome === "failed" && !attempt.error && seconds < 60 ? quickFailures + 1 : 0;
      // Three fast failures in a row is a broken login or a limit message we don't know yet.
      if (attempt.outcome !== "limited" && quickFailures < 3) {
        set(worker, { state: "idle" });
        continue;
      }
      quickFailures = 0;
      worker.limits++;
      if (options.limit !== null && worker.limits >= options.limit)
        return set(worker, {
          state: "stopped",
          reason: `limit ${worker.limits} of ${options.limit}`,
        });
      const reset =
        attempt.outcome === "limited"
          ? resetTime(readFileSync(attempt.log, "utf8"), Date.now())
          : undefined;
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
    const worktree = join(state, "worktrees", agent.name, job.item.label.replace(/[^\w.-]+/g, "-"));
    const start = new Date().toISOString();
    const attempt = (outcome: Attempt["outcome"], rest: Partial<Attempt> = {}): Attempt => ({
      run: id,
      agent: agent.name,
      ...tuning,
      start,
      end: new Date().toISOString(),
      outcome,
      log: logPath,
      ...rest,
    });
    let prompt: string;
    try {
      await checkout(worktree, job.item.repo);
      prompt = await output(options.workwork, ["prompt", job.item.id], job.item.repo);
    } catch (error) {
      // The repo or workwork failed, not the agent: record why and move on.
      return attempt("failed", { error: (error as Error).message.trim().slice(0, 2000) });
    }
    writeFileSync(join(dir, "prompt.md"), prompt);
    if (stopping) return undefined;
    const { code, timedOut } = await spawnAgent(agent, prompt, worktree, logPath);
    const branch = await keepWork(worktree, `factory/${slug}`);
    if (stopping) return undefined;
    const text = readFileSync(logPath, "utf8");
    return attempt(timedOut ? "timeout" : classify(agent, code, text), {
      url: text.match(URL)?.at(-1),
      branch,
    });
  }

  function spawnAgent(agent: Agent, prompt: string, cwd: string, logPath: string) {
    return new Promise<{ code: number; timedOut: boolean }>((resolve) => {
      const logFile = openSync(logPath, "w");
      // Its own process group, so a timeout or stop takes down everything the agent started.
      const child = spawn(agent.command, agent.args, {
        cwd,
        detached: true,
        stdio: ["pipe", logFile, logFile],
      });
      closeSync(logFile);
      children.add(child);
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        killGroup(child);
      }, options.timeoutMs);
      const done = (code: number) => {
        clearTimeout(timer);
        children.delete(child);
        resolve({ code, timedOut });
      };
      child.on("error", (error) => {
        appendFileSync(logPath, `factory: could not start ${agent.command}: ${error.message}\n`);
        done(127);
      });
      child.on("close", (code) => {
        killGroup(child);
        done(code ?? 1);
      });
      // The agent may exit before reading its prompt; its log tells why.
      // stdin is a pipe, as asked above; node's types can't tell when the other fds are numbers.
      child.stdin!.on("error", () => {});
      child.stdin!.end(prompt);
    });
  }

  // A run that crashed left its jobs running; they go back to the queue with their agent.
  for (const job of readJobs(state)) if (job.state === "running") requeueJob(state, job.id);
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  options.signal?.addEventListener("abort", stop);
  writeStatus();
  try {
    await Promise.all(workers.map(work));
  } catch (error) {
    stop();
    throw error;
  } finally {
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
    options.signal?.removeEventListener("abort", stop);
    await topping;
    writeStatus();
  }
  return id;
}

/** The worktree at a fresh origin/HEAD; reused across jobs so installed dependencies survive. */
async function checkout(worktree: string, repo: string): Promise<void> {
  await output("git", ["fetch", "--quiet", "origin"], repo);
  const base = (
    await output("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], repo)
  ).trim();
  if (!existsSync(worktree)) {
    await output("git", ["worktree", "prune"], repo);
    await output("git", ["worktree", "add", "--quiet", "--detach", worktree, base], repo);
    return;
  }
  // Whatever a crashed run left here is kept before the reset.
  await keepWork(worktree, `factory/leftover-${Date.now()}`);
  await output("git", ["checkout", "--quiet", "--force", "--detach", base], worktree);
  // Untracked files go; ignored ones like node_modules stay.
  await output("git", ["clean", "-fdq"], worktree);
}

/** Saves commits and changes that aren't on a remote to a branch; returns its name, if there was any. */
async function keepWork(worktree: string, branch: string): Promise<string | undefined> {
  if ((await output("git", ["status", "--porcelain"], worktree)).trim()) {
    await output("git", ["add", "-A"], worktree);
    await output(
      "git",
      ["commit", "--quiet", "--no-verify", "-m", "factory: changes the agent left uncommitted"],
      worktree,
    );
  }
  const unpushed = await output(
    "git",
    ["log", "--oneline", "HEAD", "--not", "--remotes"],
    worktree,
  );
  if (!unpushed.trim()) return undefined;
  await output("git", ["branch", "--force", branch, "HEAD"], worktree);
  return branch;
}

function killGroup(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
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

import { execFile, spawn, type ChildProcess } from "node:child_process";
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
import { promisify } from "node:util";
import { classify, resetTime, type Agent, type Outcome } from "./agents.ts";
import { appendLedger, key, order, readLedger, replay, type Entry, type Item } from "./state.ts";

export type Options = {
  agents: Agent[];
  levels: string[];
  windows: number;
  until?: number;
  maxItems?: number;
  timeoutMs: number;
  state: string;
  /** The workwork command; tests swap in a script. */
  workwork: string;
  /** Tests record the waits instead of sleeping through them. */
  sleep?: (ms: number) => Promise<void>;
};

export type Worker = {
  agent: string;
  state: "idle" | "working" | "sleeping" | "stopped";
  since: string;
  item?: string;
  until?: string;
  reason?: string;
  limits: number;
};

const MINUTE = 60_000;
const URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(?:pull|issues)\/\d+/g;

/** Runs workers until each has stopped; returns the run id. */
export async function run(options: Options): Promise<string> {
  const id = new Date().toISOString().slice(0, 19).replaceAll(":", "");
  const runDir = join(options.state, "runs", id);
  mkdirSync(runDir, { recursive: true });
  const queue: Item[] = [];
  const claimed = new Set<string>();
  const children = new Set<ChildProcess>();
  const wakers = new Set<() => void>();
  const counts: Record<Outcome, number> = { done: 0, failed: 0, limited: 0, timeout: 0 };
  const workers: Worker[] = options.agents.map((agent) => ({
    agent: agent.name,
    state: "idle",
    since: new Date().toISOString(),
    limits: 0,
  }));
  let started = 0;
  let stopping = false;

  function writeStatus(): void {
    const until = options.until && new Date(options.until).toISOString();
    const status = { pid: process.pid, run: id, until, workers, counts, queued: queue.length };
    writeFileSync(join(options.state, "status.json"), `${JSON.stringify(status, null, 2)}\n`);
  }

  function set(worker: Worker, change: Partial<Worker>): void {
    Object.assign(worker, { item: undefined, until: undefined }, change);
    worker.since = new Date().toISOString();
    writeStatus();
  }

  function stop(): void {
    stopping = true;
    for (const child of children) killGroup(child);
    for (const wake of wakers) wake();
  }

  function ended(): string | undefined {
    if (stopping) return "stopped";
    if (options.until && Date.now() >= options.until) return "--until passed";
    if (options.maxItems && started >= options.maxItems) return "--max-items reached";
  }

  function nap(ms: number): Promise<void> {
    if (options.sleep) return options.sleep(ms);
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

  function take(agent: string): Item | undefined {
    const { failedBy } = replay(readLedger(options.state));
    const index = queue.findIndex((item) => !failedBy.get(key(item))?.includes(agent));
    return index < 0 ? undefined : queue.splice(index, 1)[0];
  }

  async function refill(): Promise<void> {
    const candidates: Item[] = JSON.parse(
      await output(options.workwork, ["--all", "--json"], process.cwd()),
    );
    const { finished, failedBy } = replay(readLedger(options.state));
    const agents = workers
      .filter((worker) => worker.state !== "stopped")
      .map((worker) => worker.agent);
    const known = new Set([...queue.map(key), ...claimed]);
    const fresh = candidates.filter(
      (item) =>
        !finished.has(key(item)) &&
        !known.has(key(item)) &&
        agents.some((agent) => !failedBy.get(key(item))?.includes(agent)),
    );
    queue.push(...order(fresh, options.levels));
    writeStatus();
  }

  async function work(agent: Agent, worker: Worker): Promise<void> {
    let quickFailures = 0;
    while (!ended()) {
      const item = take(agent.name) ?? (await refill(), take(agent.name));
      if (!item) return set(worker, { state: "stopped", reason: "nothing left to do" });
      started++;
      claimed.add(key(item));
      set(worker, { state: "working", item: `${item.label} ${item.id}` });
      log(`${agent.name} starts ${item.label} ${item.id}`);
      const entry = await attempt(agent, item);
      claimed.delete(key(item));
      // Stopped mid-item: no ledger line, so the next run picks it up again.
      if (!entry) break;
      appendLedger(options.state, entry);
      counts[entry.outcome]++;
      log(
        `${agent.name} ${entry.outcome} ${item.label} ${item.id} ${entry.url ?? entry.error ?? ""}`,
      );
      const seconds = (Date.parse(entry.end) - Date.parse(entry.start)) / 1000;
      quickFailures =
        entry.outcome === "failed" && !entry.error && seconds < 60 ? quickFailures + 1 : 0;
      if (entry.outcome === "limited") {
        started--;
        queue.unshift(item);
      }
      // Three fast failures in a row is a broken login or a limit message we don't know yet.
      if (entry.outcome !== "limited" && quickFailures < 3) {
        set(worker, { state: "idle" });
        continue;
      }
      quickFailures = 0;
      worker.limits++;
      if (worker.limits >= options.windows)
        return set(worker, {
          state: "stopped",
          reason: `limit ${worker.limits} of ${options.windows}`,
        });
      const reset =
        entry.outcome === "limited"
          ? resetTime(readFileSync(entry.log, "utf8"), Date.now())
          : undefined;
      const wake = Math.min(
        reset === undefined ? Date.now() + 30 * MINUTE : reset + 2 * MINUTE,
        options.until ?? Infinity,
      );
      set(worker, { state: "sleeping", until: new Date(wake).toISOString() });
      log(`${agent.name} sleeps until ${new Date(wake).toISOString()}`);
      await nap(wake - Date.now());
    }
    set(worker, { state: "stopped", reason: ended() });
  }

  /** One attempt at an item in a fresh worktree; undefined when the run was stopped meanwhile. */
  async function attempt(agent: Agent, item: Item): Promise<Entry | undefined> {
    const slug = `${item.label}-${item.id}`.replace(/[^\w.-]+/g, "-");
    const dir = join(runDir, slug);
    mkdirSync(dir, { recursive: true });
    const logPath = join(dir, "agent.log");
    const worktree = join(options.state, "worktrees", id, slug);
    const start = new Date().toISOString();
    const entry = (outcome: Outcome, rest: Partial<Entry> = {}): Entry => ({
      run: id,
      id: item.id,
      repo: item.repo,
      play: item.play,
      level: item.level,
      agent: agent.name,
      start,
      end: new Date().toISOString(),
      outcome,
      log: logPath,
      ...rest,
    });
    let prompt: string;
    try {
      await output("git", ["fetch", "--quiet", "origin"], item.repo);
      const base = await output(
        "git",
        ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
        item.repo,
      );
      await output("git", ["worktree", "add", "--detach", worktree, base.trim()], item.repo);
      prompt = await output(options.workwork, ["prompt", item.id], item.repo);
    } catch (error) {
      // The repo or workwork failed, not the agent: record why and move on.
      const kept = await settle(worktree, item.repo);
      return entry("failed", {
        error: (error as Error).message.trim(),
        worktree: kept ? worktree : undefined,
      });
    }
    writeFileSync(join(dir, "prompt.md"), prompt);
    const { code, timedOut } = await spawnAgent(agent, prompt, worktree, logPath);
    const kept = await settle(worktree, item.repo);
    if (stopping) return undefined;
    const text = readFileSync(logPath, "utf8");
    return entry(timedOut ? "timeout" : classify(agent, code, text), {
      url: text.match(URL)?.at(-1),
      worktree: kept ? worktree : undefined,
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

  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  writeStatus();
  try {
    await Promise.all(options.agents.map((agent, index) => work(agent, workers[index])));
  } catch (error) {
    stop();
    throw error;
  } finally {
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
    writeStatus();
  }
  return id;
}

/** Keeps a worktree holding unpushed commits or changes; removes it otherwise. Returns whether it was kept. */
async function settle(worktree: string, repo: string): Promise<boolean> {
  if (!existsSync(worktree)) return false;
  const unpushed = await output(
    "git",
    ["log", "--oneline", "HEAD", "--not", "--remotes"],
    worktree,
  );
  const changes = await output("git", ["status", "--porcelain"], worktree);
  if (unpushed.trim() || changes.trim()) return true;
  await output("git", ["worktree", "remove", "--force", worktree], repo);
  return false;
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

async function output(command: string, args: string[], cwd: string): Promise<string> {
  const { stdout, stderr } = await promisify(execFile)(command, args, {
    cwd,
    maxBuffer: 64 * 1024 * 1024,
  });
  // workwork reports failed finders here; they belong in the factory log.
  process.stderr.write(stderr);
  return stdout;
}

function log(message: string): void {
  console.log(`${new Date().toISOString()} ${message}`);
}

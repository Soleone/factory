#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { agent } from "./agents.ts";
import { run, type Worker } from "./loop.ts";
import { approve, KINDS, preview, readQueue, stage } from "./stage.ts";
import { readLedger, STATE, type Entry } from "./state.ts";

const USAGE = `factory: works through workwork candidates with headless coding agents until the limits run out

  factory start [options]   the loop in the background; prints where the log is
  factory run [options]     the same loop in the foreground
  factory status            running or not, what each worker is doing, counts
  factory stop              stops the loop and its agents; unfinished items go back in the queue
  factory report [--all]    the last run (or every run): outcome, agent, item, PR/issue link or log

  factory stage --repo NAME [--repo NAME...] [--kinds finding,scan] [--limit N] [--levels ...] [--no-pull]
                            fast-forward those checkouts, then save up to N of their candidates
  factory preview           the staged candidates, numbered, and what's approved
  factory approve 1,3|all   exactly those staged items become the queue
  factory start --queue     runs the approved items and nothing else (run --queue: in the foreground)

Options:
  --queue                   take the approved items instead of every repo's candidates
  --until HH:MM             start nothing new after this local time
  --windows N               usage-limit windows per agent before it stops (default 1)
  --agents claude,pi        one worker per agent (default claude,pi)
  --levels auto,skim,decide which attention levels to take (default all)
  --max-items N             stop after starting N items
  --timeout MIN             minutes before an agent is killed (default 60)
  --claude-model, --pi-model  passed to the agent as --model

Stage options:
  --repo NAME               a repo under $SRC (or a path); repeat for more
  --kinds finding,scan      finding: a tool reported it; scan: an agent searches the repo;
                            rotation: one file in turn (default finding,scan)
  --limit N                 how many to stage (default 10)
  --no-pull                 use the checkouts as they are instead of fast-forwarding them

State: ${STATE}`;

const PID = join(STATE, "factory.pid");
const LOG = join(STATE, "factory.log");

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      until: { type: "string" },
      windows: { type: "string", default: "1" },
      agents: { type: "string", default: "claude,pi" },
      levels: { type: "string", default: "auto,skim,decide" },
      "max-items": { type: "string" },
      timeout: { type: "string", default: "60" },
      "claude-model": { type: "string" },
      "pi-model": { type: "string" },
      all: { type: "boolean" },
      queue: { type: "boolean" },
      repo: { type: "string", multiple: true },
      kinds: { type: "string", default: "finding,scan" },
      limit: { type: "string", default: "10" },
      "no-pull": { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
  const [command] = positionals;
  if (values.help || command === undefined) return console.log(USAGE);
  if (values.version) return console.log(version());
  mkdirSync(STATE, { recursive: true });
  if (command === "status") return status();
  if (command === "stop") return stop();
  if (command === "report") return console.log(report(values.all ?? false));
  if (command === "preview") return console.log(preview(STATE));
  if (command === "approve") {
    const { items } = approve(STATE, positionals.slice(1));
    console.log(`Approved ${items.length}: ${items.map((item) => item.id).join(", ")}`);
    return console.log(`Run them: factory start --queue`);
  }
  const levels = values.levels.split(",");
  for (const level of levels)
    if (!["auto", "skim", "decide"].includes(level)) throw new Error(`unknown level ${level}`);
  if (command === "stage") {
    const kinds = values.kinds.split(",");
    for (const kind of kinds)
      if (!(KINDS as readonly string[]).includes(kind)) throw new Error(`unknown kind ${kind}`);
    if (!values.repo?.length)
      throw new Error("stage which repo? factory stage --repo <name> (repeat for more)");
    await stage({
      repos: values.repo.map(repoPath),
      levels,
      kinds,
      limit: count(values.limit, "--limit"),
      pull: !values["no-pull"],
      state: STATE,
      workwork: "workwork",
    });
    return console.log(preview(STATE));
  }
  if (command !== "start" && command !== "run")
    throw new Error(`unknown command ${command}\n\n${USAGE}`);

  const models: Record<string, string | undefined> = {
    claude: values["claude-model"],
    pi: values["pi-model"],
  };
  // Read now, so approving something else later can't change what this run takes.
  const approved = values.queue ? readQueue(STATE).items : undefined;
  if (approved?.length === 0) throw new Error("the approved queue is empty: factory approve");
  const options = {
    approved,
    agents: values.agents.split(",").map((name) => agent(name, models[name])),
    levels,
    windows: count(values.windows, "--windows"),
    until: values.until === undefined ? undefined : nextTime(values.until),
    maxItems:
      values["max-items"] === undefined ? undefined : count(values["max-items"], "--max-items"),
    timeoutMs: count(values.timeout, "--timeout") * 60_000,
    state: STATE,
    workwork: "workwork",
  };
  const pid = runningPid();
  // start writes the pid of the run it spawns, possibly before that run gets here.
  if (pid && pid !== process.pid)
    throw new Error(`already running (pid ${pid}); factory status, or factory stop`);
  if (command === "start") return start();

  writeFileSync(PID, `${process.pid}\n`);
  try {
    const id = await run(options);
    console.log(report(false, id));
  } finally {
    rmSync(PID, { force: true });
  }
}

/** `factory run` with the same arguments, outliving this shell and whoever started it. */
function start(): void {
  const log = openSync(LOG, "a");
  const child = spawn(
    process.execPath,
    [process.argv[1], "run", ...process.argv.slice(2).filter((arg) => arg !== "start")],
    {
      detached: true,
      stdio: ["ignore", log, log],
    },
  );
  child.unref();
  writeFileSync(PID, `${child.pid}\n`);
  console.log(`factory: started (pid ${child.pid}); log: ${LOG}`);
}

function status(): void {
  const pid = runningPid();
  const path = join(STATE, "status.json");
  if (!existsSync(path))
    return console.log(pid ? `running (pid ${pid}), starting up` : "not running, never ran");
  const state = JSON.parse(readFileSync(path, "utf8"));
  const until = state.until ? `, until ${clock(state.until)}` : "";
  const scope = state.scope ? `, ${state.scope}` : "";
  console.log(`${pid ? `running (pid ${pid})` : "not running"}, run ${state.run}${scope}${until}`);
  for (const worker of state.workers as Worker[]) {
    const what =
      worker.item ?? (worker.until ? `until ${clock(worker.until)}` : (worker.reason ?? ""));
    console.log(
      `  ${worker.agent.padEnd(7)} ${worker.state.padEnd(9)} ${what}  (since ${clock(worker.since)}, limits ${worker.limits})`,
    );
  }
  const { done, failed, limited, timeout } = state.counts;
  console.log(
    `done ${done}, failed ${failed}, timeout ${timeout}, limited ${limited}, queued ${state.queued}`,
  );
}

async function stop(): Promise<void> {
  const pid = runningPid();
  if (!pid) return console.log("not running");
  process.kill(pid, "SIGTERM");
  // Agents get SIGTERM, then SIGKILL after 10 seconds; the loop exits once they're gone.
  for (let waited = 0; alive(pid); waited++) {
    if (waited === 60) throw new Error(`pid ${pid} is still running after 30 seconds`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  rmSync(PID, { force: true });
  console.log(`stopped (pid ${pid})`);
}

function report(all: boolean, run?: string): string {
  const ledger = readLedger(STATE);
  const last = run ?? ledger.at(-1)?.run;
  const entries = all ? ledger : ledger.filter((entry) => entry.run === last);
  if (entries.length === 0) return "nothing done yet";
  const lines: string[] = [];
  for (const [i, entry] of entries.entries()) {
    if (entry.run !== entries[i - 1]?.run) lines.push(`run ${entry.run}`);
    lines.push(
      `  ${entry.outcome.padEnd(7)} ${entry.agent.padEnd(6)} ${basename(entry.repo)} ${entry.id}`,
    );
    lines.push(`          ${detail(entry)}`);
  }
  return lines.join("\n");
}

function detail(entry: Entry): string {
  const parts = [entry.url ?? entry.log];
  if (entry.error) parts.push(entry.error.split("\n")[0]);
  if (entry.worktree) parts.push(`unpushed work kept in ${entry.worktree}`);
  return parts.join("\n          ");
}

function runningPid(): number | undefined {
  if (!existsSync(PID)) return undefined;
  const pid = Number(readFileSync(PID, "utf8"));
  return alive(pid) ? pid : undefined;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

/** The next time the local clock shows HH:MM. */
function nextTime(text: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (!match) throw new Error(`--until wants HH:MM, got ${text}`);
  const time = new Date();
  time.setHours(Number(match[1]), Number(match[2]), 0, 0);
  if (time.getTime() <= Date.now()) time.setDate(time.getDate() + 1);
  return time.getTime();
}

/** A repo named relative to $SRC (or here), or by its path. */
function repoPath(name: string): string {
  const path = resolve(process.env.SRC ?? process.cwd(), name);
  if (!existsSync(join(path, ".git"))) throw new Error(`no git repo at ${path}`);
  return path;
}

function count(text: string, flag: string): number {
  const value = Number(text);
  if (!Number.isInteger(value) || value < 1)
    throw new Error(`${flag} wants a whole number above 0, got ${text}`);
  return value;
}

function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

function version(): string {
  return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
}

main().catch((error: Error) => {
  console.error(`factory: ${error.message}`);
  process.exitCode = 1;
});

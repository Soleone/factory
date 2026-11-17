#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { agent } from "./agents.ts";
import { addJobs, readJobs, removeJob, retryJob } from "./jobs.ts";
import { run, type RunOptions } from "./loop.ts";
import { logPath, turnOff, turnOn } from "./power.ts";
import { output, pidPath, readSettings, runningPid, STATE, writeSettings } from "./state.ts";
import type { Item, Job, Status, Tuning } from "./types.ts";
import { serve } from "./web.ts";
// Bundled into dist, so it works from source and from the package alike.
import packageJson from "../../package.json" with { type: "json" };

const USAGE = `factory: works a queue of workwork candidates with headless coding agents

  factory start [run options]  turn the factory on, in the background
  factory run [run options]    the same, in the foreground
  factory stop                 turn it off; jobs in progress go back to the queue
  factory status               on or off, what each agent is doing, the queue
  factory add <id>... [--repo DIR] [--agent NAME] [--model M] [--effort E]
                               queue workwork candidates from DIR (default: here), ahead of auto jobs
  factory remove <job>         take a job out of the queue or the results, with its kept branches
  factory retry <job>          queue a failed job again, with the same agent
  factory auto on|off          let auto mode keep the queue topped up from workwork, or not
  factory report [--all]       the last run (or every run): outcome, agent, job, PR/issue link or log
  factory serve [--port 7040] [--host 127.0.0.1]
                               a web page to watch, browse candidates, queue them and turn it on or off

Run options (defaults from settings.json):
  --agents claude,pi           which registered agents work this run
  --limit N|none               usage-limit hits per agent before it stops; none: wait for each reset
  --until HH:MM                start nothing new after this local time
  --model NAME=MODEL           e.g. --model claude=opus; repeat per agent
  --effort NAME=LEVEL          e.g. --effort pi=high; repeat per agent
  --timeout MIN                minutes before an agent is killed

State: ${STATE}`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      agents: { type: "string" },
      limit: { type: "string" },
      until: { type: "string" },
      model: { type: "string", multiple: true },
      effort: { type: "string", multiple: true },
      timeout: { type: "string" },
      repo: { type: "string" },
      agent: { type: "string" },
      all: { type: "boolean" },
      port: { type: "string", default: "7040" },
      host: { type: "string", default: "127.0.0.1" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
  const [command, ...args] = positionals;
  if (values.help || command === undefined) return console.log(USAGE);
  if (values.version) return console.log(packageJson.version);
  mkdirSync(STATE, { recursive: true });
  if (command === "status") return status();
  if (command === "report") return console.log(report(values.all ?? false));
  if (command === "remove") {
    for (const id of args) await removeJob(STATE, id);
    return;
  }
  if (command === "retry") return args.forEach((id) => retryJob(STATE, id));
  if (command === "auto") return auto(args[0]);
  if (command === "add") return add(args, values);
  if (command === "serve") return void serve(STATE, count(values.port, "--port"), values.host);
  if (command === "stop") {
    const pid = await turnOff(STATE);
    return console.log(pid ? `turned off (pid ${pid})` : "already off");
  }
  if (command !== "start" && command !== "run")
    throw new Error(`unknown command ${command}\n\n${USAGE}`);

  const options = runOptions(values);
  if (command === "start") {
    const pid = turnOn(STATE, process.argv.slice(3));
    return console.log(`factory: on (pid ${pid}); log: ${logPath(STATE)}`);
  }
  const pid = runningPid(STATE);
  // start writes the pid of the run it spawns, possibly before that run gets here.
  if (pid && pid !== process.pid) throw new Error(`already on (pid ${pid}); factory stop first`);
  writeFileSync(pidPath(STATE), `${process.pid}\n`);
  try {
    const id = await run(options);
    console.log(report(false, id));
  } finally {
    rmSync(pidPath(STATE), { force: true });
  }
}

/** The run's options: flags where given, settings.json for the rest. */
function runOptions(values: {
  agents?: string;
  limit?: string;
  until?: string;
  model?: string[];
  effort?: string[];
  timeout?: string;
}): RunOptions {
  const settings = readSettings(STATE);
  const names = values.agents?.split(",") ?? Object.keys(settings.agents);
  const agents: Record<string, Tuning> = {};
  for (const name of names) {
    agent(name);
    agents[name] = { ...settings.agents[name] };
  }
  for (const field of ["model", "effort"] as const)
    for (const pair of values[field] ?? []) {
      const [name, value] = pair.split("=");
      if (!agents[name] || !value)
        throw new Error(`--${field} wants NAME=VALUE for an agent of this run, got ${pair}`);
      agents[name][field] = value;
    }
  const limit =
    values.limit === undefined
      ? settings.limit
      : values.limit === "none"
        ? null
        : count(values.limit, "--limit");
  const until = values.until ?? settings.until;
  return {
    agents,
    limit,
    until: until === undefined ? undefined : nextTime(until),
    timeoutMs: count(values.timeout ?? String(settings.timeout), "--timeout") * 60_000,
    state: STATE,
    workwork: "workwork",
  };
}

async function add(
  ids: string[],
  values: { repo?: string; agent?: string; model?: string[]; effort?: string[] },
): Promise<void> {
  if (ids.length === 0) throw new Error("factory add wants at least one workwork id");
  const repo = resolve(values.repo ?? ".");
  const candidates: Item[] = JSON.parse(await output("workwork", ["--json"], repo));
  const items = ids.map((id) => {
    const item = candidates.find((candidate) => candidate.id === id);
    if (!item) throw new Error(`workwork has no candidate ${id} in ${repo}`);
    return item;
  });
  if (values.agent) agent(values.agent);
  const pin = { agent: values.agent, model: values.model?.[0], effort: values.effort?.[0] };
  for (const job of addJobs(STATE, items, "pick", pin))
    console.log(`queued ${job.id}: ${job.item.label} ${job.item.id}`);
}

function auto(onOrOff: string | undefined): void {
  if (onOrOff !== "on" && onOrOff !== "off") throw new Error("factory auto wants on or off");
  const settings = readSettings(STATE);
  writeSettings(STATE, { ...settings, auto: { ...settings.auto, on: onOrOff === "on" } });
  console.log(`auto mode ${onOrOff}`);
}

function status(): void {
  const pid = runningPid(STATE);
  const path = join(STATE, "status.json");
  const settings = readSettings(STATE);
  console.log(`${pid ? `on (pid ${pid})` : "off"}, auto mode ${settings.auto.on ? "on" : "off"}`);
  if (pid && existsSync(path)) {
    const status: Status = JSON.parse(readFileSync(path, "utf8"));
    const until = status.until ? `, until ${clock(status.until)}` : "";
    console.log(`run ${status.run}, limit ${status.limit ?? "none"}${until}`);
    for (const worker of status.workers) {
      const what =
        worker.job ?? (worker.until ? `until ${clock(worker.until)}` : (worker.reason ?? ""));
      console.log(
        `  ${worker.agent.padEnd(7)} ${worker.state.padEnd(9)} ${what}  (since ${clock(worker.since)}, limits hit ${worker.limits})`,
      );
    }
  }
  const queued = readJobs(STATE).filter((job) => job.state === "queued");
  console.log(`queue: ${queued.length}`);
  for (const job of queued.slice(0, 10)) console.log(`  ${line(job)}`);
  if (queued.length > 10) console.log(`  … ${queued.length - 10} more`);
}

function line(job: Job): string {
  const agent = job.agent ? ` [${job.agent}]` : "";
  return `${job.id} ${job.source.padEnd(4)} ${basename(job.item.repo)} ${job.item.id}${agent}`;
}

function report(all: boolean, run?: string): string {
  const attempts = readJobs(STATE)
    .flatMap((job) => job.attempts.map((attempt) => ({ job, attempt })))
    .sort((a, b) => a.attempt.start.localeCompare(b.attempt.start));
  const last = run ?? attempts.at(-1)?.attempt.run;
  const shown = all ? attempts : attempts.filter(({ attempt }) => attempt.run === last);
  if (shown.length === 0) return "nothing done yet";
  const lines: string[] = [];
  for (const [i, { job, attempt }] of shown.entries()) {
    if (attempt.run !== shown[i - 1]?.attempt.run) lines.push(`run ${attempt.run}`);
    lines.push(`  ${attempt.outcome.padEnd(7)} ${attempt.agent.padEnd(6)} ${line(job)}`);
    const details = [attempt.url ?? attempt.log];
    if (attempt.error) details.push(attempt.error.split("\n")[0]);
    if (attempt.branch) details.push(`unpushed work kept on branch ${attempt.branch}`);
    lines.push(...details.map((detail) => `          ${detail}`));
  }
  return lines.join("\n");
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

function count(text: string, flag: string): number {
  const value = Number(text);
  if (!Number.isInteger(value) || value < 1)
    throw new Error(`${flag} wants a whole number above 0, got ${text}`);
  return value;
}

function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

main().catch((error: Error) => {
  console.error(`factory: ${error.message}`);
  process.exitCode = 1;
});

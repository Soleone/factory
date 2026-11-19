#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { agent } from "./agents.ts";
import {
  addJobs,
  addNote,
  queueReview,
  readJobs,
  removeJob,
  retryJob,
  type Event,
} from "./jobs.ts";
import { run, type RunOptions } from "./loop.ts";
import { logPath, turnOff, turnOn } from "./power.ts";
import { output, pidPath, readSettings, runningPid, STATE, writeSettings } from "./state.ts";
import { prUrl, type Confidence, type Item, type Job, type Status, type Tuning } from "./types.ts";
import { serve } from "./web.ts";
// Bundled into dist, so it works from source and from the package alike.
import packageJson from "../../package.json" with { type: "json" };

const USAGE = `factory: works a queue of workwork candidates with headless coding agents

  factory start [run options]  turn the factory on, in the background
  factory run [run options]    the same, in the foreground
  factory stop [--kill]        turn it off; agents at work finish, and the next start records them;
                               --kill stops them too and puts their jobs back in the queue
  factory status               on or off, what each agent is doing, the queue
  factory add <id>... [--repo DIR] [--agent NAME] [--model M] [--effort E] [--after JOB]
                               queue workwork candidates from DIR (default: here), ahead of auto jobs;
                               --after: start once that job is done
  factory review <job> --agent NAME
                               queue a review of the job's PR by another agent, once the job is done
  factory wait <job> [--timeout MIN]
                               block until the job is done, failed or blocked; exits 1 at the timeout
  factory tail                 follow what happens to every job, one line each
  factory remove <job>         take a job out of the queue or the results, with its kept branches
  factory retry <job>          queue a failed job again, with the same agent
  factory answer <job> "<text>" answer the question a blocked job asked, and queue it again
  factory auto on|off          let auto mode keep the queue topped up from workwork, or not
  factory report [--all]       the last run (or every run): outcome, agent, job, PR/issue link or log
  factory serve [--port 7040] [--host 127.0.0.1]
                               a web page to watch, browse candidates, queue them and turn it on or off

For the agent working a job (the job is $FACTORY_JOB, or --job ID):
  factory note "<text>"        something worth knowing later
  factory ask "<question>"     a decision for the user; the job waits for the answer once the agent ends
  factory result "<summary>" [--confidence low|medium|high] [--url LINK] [--followup "<task>"]...
                               what the job delivered, and tasks that deserve their own job

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
      kill: { type: "boolean" },
      job: { type: "string" },
      after: { type: "string" },
      confidence: { type: "string" },
      url: { type: "string" },
      followup: { type: "string", multiple: true },
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
  if (command === "answer") return addNote(STATE, args[0], { kind: "answer", text: text(args[1]) });
  if (command === "note" || command === "ask")
    return addNote(STATE, ownJob(values.job), { kind: command, text: text(args[0]) });
  if (command === "result") return result(args[0], values);
  if (command === "review") return review(args[0], values.agent);
  if (command === "wait") return wait(args[0], values.timeout);
  if (command === "tail") return tail();
  if (command === "add") return add(args, values);
  if (command === "serve") return void serve(STATE, count(values.port, "--port"), values.host);
  if (command === "stop") {
    const pid = await turnOff(STATE, values.kill);
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
  values: { repo?: string; agent?: string; model?: string[]; effort?: string[]; after?: string },
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
  if (values.after && !readJobs(STATE).some((job) => job.id === values.after))
    throw new Error(`--after names no job ${values.after}; factory status lists them`);
  const pin = {
    agent: values.agent,
    model: values.model?.[0],
    effort: values.effort?.[0],
    after: values.after,
  };
  const added = addJobs(STATE, items, "pick", pin);
  for (const job of added) console.log(`queued ${job.id}: ${job.item.label} ${job.item.id}`);
  for (const item of items.filter((item) => !added.some((job) => job.item === item)))
    console.log(`already queued: ${item.label} ${item.id}`);
}

function review(id: string | undefined, name: string | undefined): void {
  if (!id || !name) throw new Error("factory review wants a job and --agent NAME");
  agent(name);
  const job = queueReview(STATE, id, name);
  console.log(job ? `queued ${job.id}: ${job.item.title}` : `a review of ${id} is already queued`);
}

const SETTLED: Job["state"][] = ["done", "failed", "blocked", "removed"];

async function wait(id: string | undefined, timeout?: string): Promise<void> {
  if (!id) throw new Error("factory wait wants a job");
  const deadline = timeout ? Date.now() + count(timeout, "--timeout") * 60_000 : Infinity;
  for (;;) {
    const job = readJobs(STATE).find((job) => job.id === id);
    if (!job) throw new Error(`no job ${id}; factory status lists them`);
    if (SETTLED.includes(job.state)) {
      const said = job.notes.findLast((note) => note.kind === "result" || note.kind === "ask");
      return console.log([job.state, prUrl(job), said?.text].filter(Boolean).join("  "));
    }
    if (Date.now() >= deadline) {
      console.log(`still ${job.state}`);
      process.exitCode = 1;
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

/** Prints each new event in jobs.jsonl as a line, until interrupted. */
async function tail(): Promise<void> {
  const path = join(STATE, "jobs.jsonl");
  let read = existsSync(path) ? statSync(path).size : 0;
  for (;;) {
    const size = existsSync(path) ? statSync(path).size : 0;
    if (size > read) {
      const text = readFileSync(path).subarray(read, size).toString("utf8");
      // A line still being written waits for the next look.
      const end = text.lastIndexOf("\n") + 1;
      read += Buffer.byteLength(text.slice(0, end));
      const jobs = new Map(readJobs(STATE).map((job) => [job.id, job]));
      for (const line of text.slice(0, end).split("\n").filter(Boolean))
        console.log(eventLine(JSON.parse(line), jobs));
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

const PAST = { remove: "removed", requeue: "back in the queue", retry: "queued for a retry" };

function eventLine(event: Event, jobs: Map<string, Job>): string {
  const id = event.type === "add" ? event.job.id : event.id;
  const job = jobs.get(id);
  const what =
    event.type === "add"
      ? `queued ${event.job.item.title}${event.job.agent ? ` for ${event.job.agent}` : ""}`
      : event.type === "start"
        ? `started by ${event.agent}`
        : event.type === "attempt"
          ? `${event.attempt.agent} ${event.attempt.outcome} ${event.attempt.url ?? ""}`
          : event.type === "note"
            ? `${event.note.kind}: ${event.note.text}`
            : event.type === "move"
              ? `moved to ${event.index + 1}`
              : PAST[event.type];
  return `${clock(event.at)} ${id} ${job ? basename(job.item.repo) : ""} ${what}`.trimEnd();
}

/** The job an agent works, which factory hands it in the environment. */
function ownJob(job = process.env.FACTORY_JOB): string {
  if (!job) throw new Error("runs inside a job, which sets FACTORY_JOB; elsewhere pass --job ID");
  return job;
}

function text(value: string | undefined): string {
  if (!value?.trim()) throw new Error('wants the text as one argument, in quotes: "…"');
  return value;
}

const CONFIDENCES = ["low", "medium", "high"];

function result(
  summary: string | undefined,
  values: { job?: string; confidence?: string; url?: string; followup?: string[] },
): void {
  const { confidence, url, followup = [] } = values;
  if (confidence !== undefined && !CONFIDENCES.includes(confidence))
    throw new Error(`--confidence wants ${CONFIDENCES.join(", ")}, got ${confidence}`);
  addNote(STATE, ownJob(values.job), {
    kind: "result",
    text: text(summary),
    confidence: confidence as Confidence | undefined,
    url,
    followups: followup,
  });
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
  const jobs = readJobs(STATE);
  const blocked = jobs.filter((job) => job.state === "blocked");
  if (blocked.length) console.log(`waiting for your answer: ${blocked.length}`);
  for (const job of blocked)
    console.log(`  ${line(job)}\n    ${job.notes.findLast((note) => note.kind === "ask")!.text}`);
  const queued = jobs.filter((job) => job.state === "queued");
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
    const number = job.attempts.indexOf(attempt) + 1;
    for (const note of job.notes)
      if (note.attempt === number && (note.kind === "result" || note.kind === "ask"))
        details.push(`${note.kind === "ask" ? "asks" : "result"}: ${note.text}`);
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

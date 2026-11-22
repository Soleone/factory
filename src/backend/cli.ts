#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { agent } from "./agents.ts";
import {
  addJobs,
  addOwnJob,
  addNote,
  answer,
  openAssumptions,
  queueReview,
  readJobs,
  record,
  removeJob,
  retryJob,
  type Event,
} from "./jobs.ts";
import {
  approveGoal,
  cancelGoal,
  checkPlan,
  findGoal,
  importPlan,
  newGoal,
  pauseGoal,
  queueReplan,
  readPlan,
  resumeGoal,
  showGoal,
  type Plan,
} from "./goals.ts";
import { run, type RunOptions } from "./loop.ts";
import { createRepo } from "./repos.ts";
import { logPath, turnOff, turnOn } from "./power.ts";
import { output, pidPath, readSettings, runningPid, STATE, writeSettings } from "./state.ts";
import {
  prUrl,
  type Confidence,
  type Item,
  type Job,
  type Status,
  type Tier,
  type Tuning,
} from "./types.ts";
import { serve } from "./web.ts";
// Bundled into dist, so it works from source and from the package alike.
import packageJson from "../../package.json" with { type: "json" };

const USAGE = `factory: works workwork candidates and long goals with headless coding agents

  factory start [run options]  turn the factory on, in the background
  factory run [run options]    the same, in the foreground
  factory stop [--kill]        turn it off; agents at work finish, and the next start records them;
                               --kill stops them too and puts their jobs back in the queue
  factory status               on or off, what each agent is doing, the queue
  factory add <id>... [--repo DIR] [--agent NAME] [--model M] [--effort E] [--after JOB]...
                               queue workwork candidates from DIR (default: here), ahead of auto jobs;
                               --after: start once that job is done
  factory add --blueprint NAME [--repo DIR] [<id>...]
                               queue what a blueprint finds in DIR, on-request ones too; ids pick some
  factory add --prompt FILE --tier T [--repo DIR] [--title TEXT]
                               one job of your own, without workwork, for a tier
  factory review <job> --agent NAME
                               queue a review of the job's PR by another agent, once the job is done
  factory wait <job> [--timeout MIN]
                               block until the job is done, failed or blocked; exits 1 at the timeout
  factory tail                 follow what happens to every job, one line each
  factory remove <job>         take a job out of the queue or the results, with its kept branches
  factory retry <job>          queue a failed job again, with the same agent
  factory answer <job> "<text>" answer the question a blocked job asked, and queue it again; or
                               the oldest assumption it made: anything but "fine" queues a change
  factory verify <job> [NEED]  you checked what the job couldn't (all of it, or one need)
  factory auto on|off          let auto mode keep the queue topped up from workwork, or not
  factory report [--all]       the last run (or every run): outcome, agent, job, PR/issue link or log
  factory serve [--port 7040] [--host 127.0.0.1]
                               a web page to watch, browse candidates, queue them and turn it on or off

Goals: one large task as a graph of jobs on its own integration branch
  factory goal new "<title>" --repo DIR|--project NAME [--brief FILE]
                               queue a decomposer; the goal waits for approval once its plan is in;
                               --project creates $SRC/NAME and a private GitHub repo for it
  factory goal import PLAN     validate and import a plan (JSON or YAML); waits for approval
  factory goal check PLAN      validate only, listing every problem
  factory goal show [GOAL] [--json]
                               the graph: layers, states, tiers, the critical path, unverified work
  factory goal approve|pause|resume|cancel GOAL
  factory goal replan GOAL "<why>"

For the agent working a job (the job is $FACTORY_JOB, or --job ID):
  factory step "<what>" [--done N --of M]
                               progress in your own words; the job shows the latest
  factory note "<text>"        something worth knowing later
  factory ask "<question>" [--assume "<default>"]
                               a decision for the user; with --assume you carry on with the default,
                               without it the job waits for the answer once you end
  factory result "<summary>" [--confidence low|medium|high] [--url LINK] [--followup "<task>"]...
                 [--unverified "<what>"]...
                               what the job delivered, tasks that deserve their own job, and what
                               you couldn't check

Run options (defaults from settings.json):
  --agents claude,pi           which registered agents work this run
  --limit N|none               usage-limit hits per agent before it stops; none: wait for each reset
  --until HH:MM                start nothing new after this local time
  --model NAME=MODEL           e.g. --model claude=opus; repeat per agent
  --effort NAME=LEVEL          e.g. --effort pi=high; repeat per agent
  --idle MIN                   minutes without a sign of life before an attempt times out

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
      idle: { type: "string" },
      repo: { type: "string" },
      project: { type: "string" },
      prompt: { type: "string" },
      blueprint: { type: "string" },
      tier: { type: "string" },
      title: { type: "string" },
      brief: { type: "string" },
      json: { type: "boolean" },
      assume: { type: "string" },
      done: { type: "string" },
      of: { type: "string" },
      unverified: { type: "string", multiple: true },
      agent: { type: "string" },
      all: { type: "boolean" },
      kill: { type: "boolean" },
      job: { type: "string" },
      after: { type: "string", multiple: true },
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
  if (command === "answer") {
    const change = answer(STATE, args[0], text(args[1]));
    return change && console.log(`queued ${change.id} to change it: ${change.item.title}`);
  }
  if (command === "verify") return record(STATE, { type: "verify", id: args[0], need: args[1] });
  if (command === "note")
    return addNote(STATE, ownJob(values.job), { kind: "note", text: text(args[0]) });
  if (command === "ask")
    return addNote(
      STATE,
      ownJob(values.job),
      values.assume === undefined
        ? { kind: "ask", text: text(args[0]) }
        : { kind: "assume", text: text(args[0]), assumed: text(values.assume) },
    );
  if (command === "step") return step(args[0], values);
  if (command === "goal") return goal(args, values);
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
  idle?: string;
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
    idleMs: count(values.idle ?? String(settings.idle), "--idle") * 60_000,
    state: STATE,
    workwork: "workwork",
  };
}

async function add(
  ids: string[],
  values: {
    repo?: string;
    blueprint?: string;
    agent?: string;
    model?: string[];
    effort?: string[];
    after?: string[];
    prompt?: string;
    tier?: string;
    title?: string;
  },
): Promise<void> {
  if (values.prompt) return addOwn(values);
  if (ids.length === 0 && !values.blueprint)
    throw new Error("factory add wants workwork ids, --blueprint NAME or --prompt FILE");
  const repo = resolve(values.repo ?? ".");
  const listing = values.blueprint ? ["--blueprint", values.blueprint, "--json"] : ["--json"];
  const candidates: Item[] = JSON.parse(await output("workwork", listing, repo));
  if (values.blueprint && candidates.length === 0)
    throw new Error(`${values.blueprint} finds nothing to do in ${repo}`);
  const items = (ids.length ? ids : candidates.map((each) => each.id)).map((id) => {
    const item = candidates.find((candidate) => candidate.id === id);
    if (!item) throw new Error(`workwork has no candidate ${id} in ${repo}`);
    return item;
  });
  if (values.agent) agent(values.agent);
  for (const after of values.after ?? [])
    if (!readJobs(STATE).some((job) => job.id === after))
      throw new Error(`--after names no job ${after}; factory status lists them`);
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

/** A job from a prompt file, for a tier, without workwork. */
function addOwn(values: {
  repo?: string;
  prompt?: string;
  tier?: string;
  title?: string;
  after?: string[];
}): void {
  const job = addOwnJob(STATE, {
    repo: resolve(values.repo ?? "."),
    prompt: readFileSync(values.prompt!, "utf8"),
    tier: values.tier as Tier,
    title: values.title,
    after: values.after,
  });
  console.log(`queued ${job.id}: ${job.item.title} (${job.tier})`);
}

function step(
  what: string | undefined,
  values: { job?: string; done?: string; of?: string },
): void {
  const done = values.done === undefined ? undefined : Number(values.done);
  const of = values.of === undefined ? undefined : Number(values.of);
  if (
    (done !== undefined && !Number.isInteger(done)) ||
    (of !== undefined && !Number.isInteger(of))
  )
    throw new Error("--done and --of want whole numbers");
  addNote(STATE, ownJob(values.job), { kind: "step", text: text(what), done, of });
}

async function goal(
  args: string[],
  values: { repo?: string; project?: string; brief?: string; json?: boolean },
): Promise<void> {
  const [sub, target, why] = args;
  if (sub === "new") {
    if (!target || !(values.repo || values.project))
      throw new Error('factory goal new wants "<title>" --repo DIR or --project NAME');
    const brief = values.brief ? readFileSync(values.brief, "utf8") : "";
    const repo = values.project ? await createRepo(values.project) : resolve(values.repo!);
    const job = await newGoal(STATE, target, repo, brief);
    return console.log(
      `goal ${job.goal!.slug} (${job.id}): the decomposer is queued; approve its plan with factory goal approve ${job.goal!.slug}`,
    );
  }
  if (sub === "check" || sub === "import") {
    if (!target) throw new Error(`factory goal ${sub} wants a plan file`);
    const plan = readPlan(target);
    const problems = checkPlan(plan);
    if (problems.length) {
      process.exitCode = 1;
      return console.log(
        `${target} has ${problems.length} problem${problems.length === 1 ? "" : "s"}:\n${problems.map((each) => `- ${each}`).join("\n")}`,
      );
    }
    if (sub === "check") return console.log(`${target} is a valid plan`);
    const job = await importPlan(STATE, plan as Plan);
    return console.log(
      `goal ${job.goal!.slug} (${job.id}) imported; it waits for factory goal approve ${job.goal!.slug}`,
    );
  }
  if (sub === "show" || sub === undefined) {
    const jobs = readJobs(STATE);
    const goals = target
      ? [findGoal(STATE, target)]
      : jobs.filter((job) => job.goal && job.state !== "removed");
    if (values.json)
      return console.log(
        JSON.stringify(
          goals.map((each) => ({ goal: each, nodes: jobs.filter((job) => job.of === each.id) })),
          null,
          2,
        ),
      );
    if (goals.length === 0)
      return console.log("no goals; factory goal new or factory goal import starts one");
    return console.log(goals.map((each) => showGoal(jobs, each)).join("\n\n"));
  }
  if (!target) throw new Error(`factory goal ${sub} wants a goal`);
  const id = findGoal(STATE, target).id;
  if (sub === "approve") return approveGoal(STATE, id);
  if (sub === "pause") return pauseGoal(STATE, id);
  if (sub === "resume") return resumeGoal(STATE, id);
  if (sub === "cancel") return cancelGoal(STATE, id);
  if (sub === "replan") {
    const job = queueReplan(STATE, findGoal(STATE, id), text(why));
    return console.log(job ? `queued replan ${job.id}` : "a replan is already waiting");
  }
  throw new Error(`unknown goal command ${sub}\n\n${USAGE}`);
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

const PAST: Record<string, string> = {
  remove: "removed",
  requeue: "back in the queue",
  retry: "queued for a retry",
  merged: "merged",
  unblock: "goes on",
  update: "changed by a replan",
  verify: "verified",
};

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
              : event.type === "pause"
                ? `waits: ${event.reason}`
                : event.type === "block"
                  ? `blocked: ${event.reason}`
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
  values: {
    job?: string;
    confidence?: string;
    url?: string;
    followup?: string[];
    unverified?: string[];
  },
): void {
  const { confidence, url, followup = [], unverified } = values;
  if (confidence !== undefined && !CONFIDENCES.includes(confidence))
    throw new Error(`--confidence wants ${CONFIDENCES.join(", ")}, got ${confidence}`);
  addNote(STATE, ownJob(values.job), {
    kind: "result",
    text: text(summary),
    confidence: confidence as Confidence | undefined,
    url,
    followups: followup,
    unverified,
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
    for (const pool of status.pools) {
      const pause =
        pool.stopped ??
        (pool.until
          ? `${pool.reserved ? "keeps its reserve" : "sleeps"} until ${clock(pool.until)}`
          : "");
      const used = pool.used === undefined ? "" : `, ${pool.used}% of 5h used`;
      console.log(
        `  pool ${pool.name}: limits hit ${pool.limits}${used}${pause ? `, ${pause}` : ""}`,
      );
      for (const worker of status.workers.filter((each) => each.pool === pool.name)) {
        const what =
          worker.job ?? (worker.until ? `until ${clock(worker.until)}` : (worker.reason ?? ""));
        const doing = worker.activity ? `  ${worker.activity}` : "";
        console.log(
          `    ${worker.id.padEnd(20)} ${worker.state.padEnd(9)} ${what}${doing}  (since ${clock(worker.since)})`,
        );
      }
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
  const jobs = readJobs(STATE);
  return [attemptReport(jobs, all, run), checklist(jobs)].filter(Boolean).join("\n\n");
}

/** What waits on the user besides questions: work nobody could verify here, and assumptions to confirm. */
function checklist(jobs: Job[]): string {
  const lines: string[] = [];
  for (const job of jobs.filter((each) => each.state !== "removed"))
    for (const need of job.unverified)
      lines.push(
        `  [ ] ${job.id} ${job.item.title}: ${need}  (factory verify ${job.id} "${need}")`,
      );
  const unverified = lines.length ? ["unverified, for you to check:", ...lines] : [];
  const assumed = jobs.flatMap((job) =>
    openAssumptions(job).map(
      (note) =>
        `  ${job.id} ${job.item.title}: assumed ${note.assumed}, asked ${note.text}  (factory answer ${job.id} "fine")`,
    ),
  );
  return [...unverified, ...(assumed.length ? ["assumptions to confirm:", ...assumed] : [])].join(
    "\n",
  );
}

function attemptReport(jobs: Job[], all: boolean, run?: string): string {
  const attempts = jobs
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
    const numbers = attemptNumbers(attempt);
    if (numbers) details.push(numbers);
    lines.push(...details.map((detail) => `          ${detail}`));
  }
  return lines.join("\n");
}

/** Turns, follow-ups, peak context and compactions, when the runner reported them. */
function attemptNumbers(attempt: Job["attempts"][number]): string {
  if (!attempt.turns) return "";
  const parts = [`${attempt.turns} turn${attempt.turns === 1 ? "" : "s"}`];
  if (attempt.followups)
    parts.push(`${attempt.followups} follow-up${attempt.followups === 1 ? "" : "s"}`);
  if (attempt.peak) parts.push(`peak ${Math.round(attempt.peak / 1000)}k context`);
  if (attempt.compactions)
    parts.push(`${attempt.compactions} compaction${attempt.compactions === 1 ? "" : "s"}`);
  return parts.join(", ");
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

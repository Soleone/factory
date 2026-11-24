import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { cancelGoal } from "./goals.ts";
import { addJob, newId, readJobs, record } from "./jobs.ts";
import { alive } from "./state.ts";
import { TIERS, type Job, type Settings, type Tier } from "./types.ts";

/**
 * With `store: "tasks"`, goals and everything under them also live in Tasks, so the Tasks app shows
 * the whole picture. Factory's log stays the source of truth (its CLI, run, page and agents all read
 * it at once); this mirrors it into Tasks every few seconds through `tasks-cli --stdio`, and takes back
 * what the user does there: canceling, editing a node that hasn't started, adding a subtask.
 */

type Task = {
  id: string;
  title: string;
  description: string;
  status: "open" | "in_progress" | "paused" | "done" | "canceled";
  category: string | null;
  tags: string[];
  parentId: string | null;
  dependencyIds: string[];
  version: number;
  meta: { factory?: Mirrored };
};

/** What factory keeps on a task: the job it mirrors, a summary of it, and what it last wrote. */
type Mirrored = {
  id: string;
  kind: "goal" | "node";
  key?: string;
  tier?: Tier;
  state: Job["state"];
  blocked?: Job["blocked"];
  gates: string[];
  touches?: string[];
  needs: string[];
  unverified: string[];
  attempts: {
    outcome: string;
    preset?: string;
    turns?: number;
    peak?: number;
    compactions?: number;
    url?: string;
  }[];
  notes: { at: string; kind: string; text: string }[];
  /** What factory wrote last, so a different value is the user's edit. */
  pushed: { title: string; description: string; status: Task["status"] };
};

const STATUS: Record<Job["state"], Task["status"]> = {
  queued: "open",
  running: "in_progress",
  blocked: "paused",
  done: "done",
  failed: "open",
  removed: "canceled",
};

/** One long-lived `tasks-cli --stdio`, answering requests by id. */
export class TasksClient {
  private child: ChildProcessWithoutNullStreams;
  private waiting = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private context?: string;
  /** Each waiting request's command, for errors; never its text. */
  private sent = new Map<string, string>();

  constructor(cli: string, home: string) {
    this.child = spawn(cli, ["--stdio", "--home", home, "--client", "cli"]);
    this.child.stderr.resume();
    this.child.on("exit", (code) => {
      for (const { reject } of this.waiting.values())
        reject(new Error(`tasks-cli exited with code ${code}`));
      this.waiting.clear();
    });
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      const reply = JSON.parse(line) as {
        requestId: string;
        ok: boolean;
        result?: unknown;
        writeContext?: string;
        error?: { code: string; message: string };
      };
      if (reply.writeContext) this.context = reply.writeContext;
      const waiter = this.waiting.get(reply.requestId);
      if (!waiter) return;
      this.waiting.delete(reply.requestId);
      this.sent.delete(reply.requestId);
      if (reply.ok) waiter.resolve(reply.result);
      else
        waiter.reject(
          Object.assign(
            new Error(
              `${reply.error!.code}: ${reply.error!.message} (${this.sent.get(reply.requestId)})`,
            ),
            {
              code: reply.error!.code,
            },
          ),
        );
    });
  }

  send(command: string, args: object = {}, write = false): Promise<unknown> {
    const requestId = randomUUID();
    const envelope = {
      version: 2,
      requestId,
      command,
      args,
      ...(write
        ? {
            writeContext: this.context,
            idempotencyKey: randomUUID(),
            actor: { kind: "agent", label: "factory" },
          }
        : {}),
    };
    return new Promise((resolve, reject) => {
      this.waiting.set(requestId, { resolve, reject });
      this.sent.set(requestId, command);
      this.child.stdin.write(`${JSON.stringify(envelope)}\n`);
    });
  }

  async write(command: string, args: object): Promise<{ task: Task }> {
    // Every reply carries the write context; the first write asks for one.
    if (!this.context) await this.send("workspace.info");
    return (await this.send(command, args, true)) as { task: Task };
  }

  close(): void {
    this.child.stdin.end();
  }
}

async function allTasks(client: TasksClient): Promise<Task[]> {
  const tasks: Task[] = [];
  for (let offset = 0; ; offset += 500) {
    const page = (await client.send("task.list", {
      status: ["open", "in_progress", "paused", "done", "canceled"],
      limit: 500,
      offset,
    })) as { tasks: Task[]; total: number };
    tasks.push(...page.tasks);
    if (tasks.length >= page.total || page.tasks.length === 0) return tasks;
  }
}

const started = (job: Job) =>
  job.state !== "queued" && !(job.state === "blocked" && job.blocked === "held");

/** One pass: take back the user's changes in Tasks, then write factory's state there. */
export async function syncTasks(
  state: string,
  client: TasksClient,
  settings: Settings,
): Promise<void> {
  const category = settings.tasks?.category ?? "factory";
  let tasks = await allTasks(client);
  const adopted = pull(state, tasks);
  tasks = adopted.size ? await allTasks(client) : tasks;
  await push(state, client, tasks, adopted, category);
}

/** The user's side: cancels, edits of nodes that haven't started, new subtasks. Returns new jobs by task id. */
function pull(state: string, tasks: Task[]): Map<string, string> {
  const jobs = readJobs(state);
  const byId = new Map(jobs.map((job) => [job.id, job]));
  const mirrored = new Map(
    tasks.flatMap((task) => (task.meta.factory ? [[task.id, task.meta.factory.id] as const] : [])),
  );
  for (const task of tasks) {
    const mirror = task.meta.factory;
    const job = mirror && byId.get(mirror.id);
    if (!mirror || !job || job.state === "removed") continue;
    const { pushed } = mirror;
    if (task.status === "canceled" && pushed.status !== "canceled") {
      if (job.goal) cancelGoal(state, job.id);
      else if (job.state !== "running") record(state, { type: "remove", id: job.id });
      continue;
    }
    if (!job.of || started(job)) continue;
    if (task.description !== pushed.description)
      record(state, { type: "update", id: job.id, change: { prompt: task.description } });
    if (task.title !== pushed.title)
      record(state, {
        type: "update",
        id: job.id,
        change: { item: { ...job.item, title: task.title } },
      });
  }
  const adopted = new Map<string, string>();
  for (const task of tasks) {
    if (
      task.meta.factory ||
      task.status === "canceled" ||
      !task.parentId ||
      !mirrored.has(task.parentId)
    )
      continue;
    const above = byId.get(mirrored.get(task.parentId)!);
    if (!above || above.state === "removed") continue;
    const goal = above.goal ? above : byId.get(above.of!);
    if (!goal?.goal) continue;
    const tier = TIERS.find((each) => task.tags.includes(each)) ?? "builder";
    const key = `${
      task.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 30) || "task"
    }-${task.id.slice(0, 4)}`;
    const job = addJob(state, {
      id: newId(),
      item: {
        repo: goal.goal.repo,
        label: goal.item.label,
        id: key,
        blueprint: "goal",
        attention: "decide",
        title: task.title,
      },
      source: "goal",
      of: goal.id,
      parent: above.goal ? undefined : above.id,
      key,
      tier,
      prompt: task.description.trim() || task.title,
      gates: [],
      touches: [],
    });
    adopted.set(task.id, job.id);
  }
  return adopted;
}

/** Factory's side: every goal job as a task under its goal or milestone, with its state and links. */
async function push(
  state: string,
  client: TasksClient,
  tasks: Task[],
  adopted: Map<string, string>,
  category: string,
): Promise<void> {
  const jobs = readJobs(state).filter((job) => job.goal || job.of);
  const taskOf = new Map<string, Task>();
  for (const task of tasks) if (task.meta.factory) taskOf.set(task.meta.factory.id, task);
  for (const [taskId, jobId] of adopted)
    taskOf.set(
      jobId,
      tasks.find((task) => task.id === taskId)!,
    );
  const byId = new Map(jobs.map((job) => [job.id, job]));
  const depth = (job: Job): number => (job.goal ? 0 : 1 + depth(byId.get(job.parent ?? job.of!)!));
  for (const job of [...jobs].sort((a, b) => depth(a) - depth(b))) {
    const above = job.goal ? undefined : taskOf.get(job.parent ?? job.of!);
    const title = job.item.title;
    const description = job.goal ? job.goal.summary : (job.prompt ?? "");
    const status = STATUS[job.state];
    const meta: Mirrored = {
      id: job.id,
      kind: job.goal ? "goal" : "node",
      key: job.key,
      tier: job.tier,
      state: job.state,
      blocked: job.blocked,
      gates: job.goal ? job.goal.gates : job.gates,
      touches: job.touches,
      needs: job.needs,
      unverified: job.unverified,
      attempts: job.attempts.map(({ outcome, preset, turns, peak, compactions, url }) => ({
        outcome,
        preset,
        turns,
        peak,
        compactions,
        url,
      })),
      notes: job.notes
        .slice(-20)
        .map(({ at, kind, text }) => ({ at, kind, text: text.slice(0, 500) })),
      pushed: { title, description, status },
    };
    const tags = job.state === "failed" ? ["failed"] : [];
    let task = taskOf.get(job.id);
    if (!task) {
      if (job.state === "removed") continue;
      ({ task } = await client.write("task.create", {
        title,
        description,
        category,
        tags,
        parentId: above?.id ?? null,
        meta: { factory: meta },
      }));
    } else {
      const changed =
        task.title !== title ||
        task.description !== description ||
        JSON.stringify(task.tags) !== JSON.stringify(tags) ||
        JSON.stringify(task.meta.factory) !== JSON.stringify(meta);
      if (changed)
        ({ task } = await client.write("task.update", {
          id: task.id,
          expectedVersion: task.version,
          title,
          description,
          tags,
          meta: { factory: meta },
        }));
      if (
        (above?.id ?? null) !== task.parentId &&
        task.status !== "canceled" &&
        above?.status !== "canceled"
      )
        ({ task } = await client.write("task.move", {
          id: task.id,
          expectedVersion: task.version,
          parentId: above?.id ?? null,
        }));
    }
    task = await transition(client, task, status);
    taskOf.set(job.id, task);
  }
  // Writes above can move other tasks' versions, so the links work from a fresh read.
  for (const task of await allTasks(client))
    if (task.meta.factory) taskOf.set(task.meta.factory.id, task);
  for (const job of jobs) {
    const task = taskOf.get(job.id);
    if (!task || task.status === "canceled") continue;
    const wanted = job.after.flatMap((id) => {
      const other = taskOf.get(id);
      return other && other.status !== "canceled" ? [other.id] : [];
    });
    let current = task;
    for (const id of wanted.filter((id) => !current.dependencyIds.includes(id)))
      ({ task: current } = await client.write("task.dependency.add", {
        id: current.id,
        expectedVersion: current.version,
        dependsOnId: id,
      }));
    for (const id of current.dependencyIds.filter((id) => !wanted.includes(id)))
      ({ task: current } = await client.write("task.dependency.remove", {
        id: current.id,
        expectedVersion: current.version,
        dependsOnId: id,
      }));
  }
}

/** Moves a task to a status, through open when Tasks doesn't allow the direct move. */
async function transition(client: TasksClient, task: Task, status: Task["status"]): Promise<Task> {
  if (task.status === status) return task;
  const command = {
    open: "task.reopen",
    in_progress: "task.start",
    paused: "task.pause",
    done: "task.complete",
    canceled: "task.cancel",
  }[status];
  const direct: Record<string, Task["status"][]> = {
    "task.start": ["open", "in_progress", "paused", "done"],
    "task.pause": ["open", "in_progress", "paused"],
    "task.complete": ["open", "in_progress", "paused", "done"],
    "task.cancel": ["open", "in_progress", "paused", "canceled"],
    "task.reopen": ["open", "in_progress", "paused", "done", "canceled"],
  };
  let current = task;
  if (!direct[command].includes(current.status))
    ({ task: current } = await client.write("task.reopen", {
      id: current.id,
      expectedVersion: current.version,
    }));
  return (await client.write(command, { id: current.id, expectedVersion: current.version })).task;
}

const lockPath = (state: string) => join(state, "tasks-sync.lock");

/**
 * Keeps Tasks in step every few seconds while this process runs, unless another factory process
 * (the run or serve) already does. Returns a stop function.
 */
export function mirrorTasks(
  state: string,
  settings: Settings,
  log: (message: string) => void,
  everyMs = 5000,
): () => void {
  if (settings.store !== "tasks" || !settings.tasks) return () => undefined;
  const lock = lockPath(state);
  if (existsSync(lock) && alive(Number(readFileSync(lock, "utf8")))) return () => undefined;
  rmSync(lock, { force: true });
  try {
    closeSync(openSync(lock, "wx"));
  } catch {
    // Another process took it between the check and here.
    return () => undefined;
  }
  writeFileSync(lock, `${process.pid}\n`);
  const client = new TasksClient(settings.tasks.cli ?? "tasks-cli", settings.tasks.home);
  let stopped = false;
  let running: Promise<void> | undefined;
  const tick = () => {
    running ??= syncTasks(state, client, settings)
      .catch((error: Error) => log(`can't sync with Tasks: ${error.message.split("\n")[0]}`))
      .finally(() => (running = undefined));
  };
  tick();
  const timer = setInterval(() => !stopped && tick(), everyMs);
  return () => {
    stopped = true;
    clearInterval(timer);
    void (running ?? Promise.resolve()).finally(() => {
      client.close();
      rmSync(lock, { force: true });
    });
  };
}

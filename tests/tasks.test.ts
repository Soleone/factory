import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vite-plus/test";
import { addJob, endJob, readJobs, startJob, type NewJob } from "../src/backend/jobs.ts";
import { readSettings } from "../src/backend/state.ts";
import { syncTasks, TasksClient } from "../src/backend/tasksStore.ts";

// Tasks' own CLI from its checkout; the mirror needs a build with `meta`.
const cli =
  process.env.TASKS_CLI ?? join(process.env.SRC ?? "", "products", "tasks", "bin", "tasks-cli");
const scratch = mkdtempSync(join(tmpdir(), "factory-tasks-"));
let client: TasksClient | undefined;
afterEach(() => client?.close());

type Listed = {
  id: string;
  title: string;
  description: string;
  status: string;
  category: string;
  tags: string[];
  parentId: string | null;
  dependencyIds: string[];
  version: number;
  meta: { factory?: { id: string; state: string } };
};

test.skipIf(!existsSync(cli))(
  "the tasks store mirrors goals into Tasks and takes back what the user does there",
  async () => {
    const home = join(mkdtempSync(join(scratch, "home-")), "tasks");
    execFileSync(cli, ["init", "--home", home]);
    const state = mkdtempSync(join(scratch, "state-"));
    const settings = { ...readSettings(state), store: "tasks" as const, tasks: { home, cli } };
    const item = (id: string) => ({
      repo: "/r",
      label: "r",
      id,
      play: "goal",
      level: "decide",
      title: `Node ${id}`,
    });
    const node = (id: string, rest: Partial<NewJob> = {}) =>
      addJob(state, {
        id,
        item: item(id),
        source: "goal",
        of: "g",
        key: id,
        tier: "builder",
        prompt: `Do ${id}.`,
        ...rest,
      });
    addJob(state, {
      id: "g",
      item: { ...item("g"), title: "Demo goal" },
      source: "goal",
      goal: { repo: "/r", slug: "demo", summary: "Make a demo.", gates: [], allowUp: false },
    });
    node("a", { tier: "communicator" });
    node("b", { after: ["a"] });
    node("c", { tier: "grunt" });
    addJob(state, { id: "w", item: { ...item("w"), play: "simplify" }, source: "pick" });

    client = new TasksClient(cli, home);
    const tasks = async () =>
      (
        (await client!.send("task.list", {
          status: ["open", "in_progress", "paused", "done", "canceled"],
          limit: 500,
        })) as { tasks: Listed[] }
      ).tasks;
    const of = async (id: string) => (await tasks()).find((task) => task.meta.factory?.id === id)!;

    startJob(state, "a", "claude");
    await syncTasks(state, client, settings);
    const goal = await of("g");
    expect(goal).toMatchObject({
      title: "Demo goal",
      description: "Make a demo.",
      category: "factory",
      parentId: null,
    });
    expect(await of("a")).toMatchObject({
      status: "in_progress",
      parentId: goal.id,
      description: "Do a.",
    });
    expect((await of("b")).dependencyIds).toEqual([(await of("a")).id]);
    expect(await of("w")).toBeUndefined();

    // Failing for good shows as open with #failed; what waits on it is held, so paused.
    endJob(state, "a", {
      run: "r",
      agent: "claude",
      start: "",
      end: "",
      outcome: "failed",
      log: "",
    });
    startJob(state, "a", "claude");
    endJob(state, "a", {
      run: "r",
      agent: "claude",
      start: "",
      end: "",
      outcome: "failed",
      log: "",
    });
    await syncTasks(state, client, settings);
    expect(await of("a")).toMatchObject({ status: "open", tags: ["failed"] });
    expect((await of("b")).status).toBe("paused");

    // The user cancels one node, rewrites another, and adds a subtask.
    const write = async (command: string, args: object) => client!.write(command, args);
    const c = await of("c");
    await write("task.cancel", { id: c.id, expectedVersion: c.version });
    const b = await of("b");
    await write("task.update", {
      id: b.id,
      expectedVersion: b.version,
      description: "Do b, but smaller.",
    });
    await write("task.create", {
      title: "Polish the demo",
      description: "Make it shine.",
      tags: ["grunt"],
      parentId: goal.id,
    });
    await syncTasks(state, client, settings);
    const jobs = readJobs(state);
    expect(jobs.find((job) => job.id === "c")!.state).toBe("removed");
    expect(jobs.find((job) => job.id === "b")!.prompt).toBe("Do b, but smaller.");
    const added = jobs.find((job) => job.item.title === "Polish the demo")!;
    expect(added).toMatchObject({
      of: "g",
      tier: "grunt",
      prompt: "Make it shine.",
      state: "queued",
    });
    const adopted = (await tasks()).filter((task) => task.title === "Polish the demo");
    expect(adopted).toHaveLength(1);
    expect(adopted[0].meta.factory?.id).toBe(added.id);

    // A second pass with nothing new writes nothing.
    const before = JSON.stringify(await tasks());
    await syncTasks(state, client, settings);
    expect(JSON.stringify(await tasks())).toBe(before);
  },
);

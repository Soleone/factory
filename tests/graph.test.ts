import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { checkPlan, showGoal } from "../src/backend/goals.ts";
import {
  addJob,
  addNote,
  answer,
  endJob,
  overlap,
  readJobs,
  ready,
  record,
  replay,
  retryJob,
  startJob,
  type Event,
  type NewJob,
} from "../src/backend/jobs.ts";
import type { Attempt, Item, Job } from "../src/backend/types.ts";

const scratch = mkdtempSync(join(tmpdir(), "factory-graph-"));
const item = (id: string, repo = "/r"): Item => ({
  repo,
  label: "r",
  id,
  play: "p",
  level: "skim",
  title: id,
});
const attempt = (outcome: Attempt["outcome"]): Attempt => ({
  run: "r",
  agent: "claude",
  start: "",
  end: "",
  outcome,
  log: "",
});
const at = "2026-11-10T00:00:00.000Z";

function graph() {
  const state = mkdtempSync(join(scratch, "state-"));
  const add = (id: string, rest: Partial<NewJob> = {}) =>
    addJob(state, { id, item: item(id), source: "goal", of: "g", ...rest });
  addJob(state, {
    id: "g",
    item: item("g"),
    source: "goal",
    goal: { repo: "/r", slug: "g", summary: "s", gates: [], allowUp: false },
  });
  const jobs = () => readJobs(state);
  const byId = (id: string) => jobs().find((job) => job.id === id)!;
  const isReady = (id: string) => ready(byId(id), jobs());
  const fail = (id: string) => {
    startJob(state, id, "claude");
    endJob(state, id, attempt("failed"));
  };
  return { state, add, jobs, byId, isReady, fail };
}

describe("the job log", () => {
  test("a log from before goals replays unchanged", () => {
    // What factory 0.2 wrote: `after` as one id, asks that ended the attempt, limits that ended one.
    const events = [
      { at, type: "add", job: { id: "a", item: item("a"), source: "pick", agent: "claude" } },
      { at, type: "add", job: { id: "b", item: item("b"), source: "auto" } },
      { at, type: "add", job: { id: "c", item: item("c"), source: "pick", after: "a" } },
      { at, type: "start", id: "a", agent: "claude" },
      { at, type: "note", id: "a", note: { kind: "ask", text: "A or B?" } },
      { at, type: "attempt", id: "a", attempt: attempt("done") },
      { at, type: "note", id: "a", note: { kind: "answer", text: "A" } },
      { at, type: "start", id: "b", agent: "pi" },
      { at, type: "attempt", id: "b", attempt: attempt("limited") },
      { at, type: "start", id: "b", agent: "pi" },
      { at, type: "attempt", id: "b", attempt: attempt("failed") },
      { at, type: "start", id: "b", agent: "pi" },
      { at, type: "attempt", id: "b", attempt: attempt("failed") },
    ] as unknown as Event[];
    const jobs = replay(events);
    expect(jobs.map((job) => [job.id, job.state, job.after, job.open])).toEqual([
      ["a", "queued", [], false],
      ["c", "queued", ["a"], false],
      ["b", "failed", [], false],
    ]);
    expect(jobs[0].notes.map((note) => [note.attempt, note.kind])).toEqual([
      [1, "ask"],
      [1, "answer"],
    ]);
    const blocked = replay(events.slice(0, 6));
    expect(blocked[0]).toMatchObject({ state: "blocked", blocked: "asked" });
  });
});

describe("the graph", () => {
  test("a job is ready once everything it comes after is done", () => {
    const { state, add, isReady } = graph();
    add("x");
    add("y", { after: ["x"] });
    expect([isReady("x"), isReady("y")]).toEqual([true, false]);
    startJob(state, "x", "claude");
    endJob(state, "x", attempt("done"));
    // A goal node is done once it merged.
    expect(isReady("y")).toBe(false);
    record(state, { type: "merged", id: "x" });
    expect(isReady("y")).toBe(true);
  });

  test("a goal at a checkpoint or paused holds its nodes, but not factory's own at a checkpoint", () => {
    const { state, add, isReady } = graph();
    add("x");
    add("fix", { front: true });
    record(state, { type: "block", id: "g", reason: "checkpoint" });
    expect([isReady("x"), isReady("fix")]).toEqual([false, true]);
    record(state, { type: "block", id: "g", reason: "paused" });
    expect([isReady("x"), isReady("fix")]).toEqual([false, false]);
    record(state, { type: "unblock", id: "g" });
    expect([isReady("x"), isReady("fix")]).toEqual([true, true]);
  });

  test("a checkpoint says why it waits, until it's approved", () => {
    const { state, byId } = graph();
    record(state, { type: "block", id: "g", reason: "checkpoint", why: "checkpoint after core" });
    expect(byId("g")).toMatchObject({ blocked: "checkpoint", why: "checkpoint after core" });
    record(state, { type: "unblock", id: "g" });
    expect(byId("g").why).toBeUndefined();
  });

  test("what a plan writer couldn't check stays in its result; a node's goes on the checklist", () => {
    const { state, add, byId } = graph();
    add("plan", { item: { ...item("plan"), play: "replan" }, front: true });
    add("node");
    for (const id of ["plan", "node"]) {
      startJob(state, id, "claude");
      addNote(state, id, { kind: "result", text: "done", unverified: ["the gate"] });
      endJob(state, id, attempt("done"));
    }
    expect([byId("plan").unverified, byId("node").unverified]).toEqual([[], ["the gate"]]);
  });

  test("a group is done when its children are, waits for what it comes after, and so do they", () => {
    const { state, add, byId, isReady } = graph();
    add("first");
    add("m", { after: ["first"] });
    add("m1", { parent: "m" });
    add("m2", { parent: "m" });
    add("next", { after: ["m"] });
    expect([isReady("m1"), isReady("next")]).toEqual([false, false]);
    record(state, { type: "merged", id: "first" });
    expect([isReady("m"), isReady("m1"), isReady("next")]).toEqual([false, true, false]);
    for (const id of ["m1", "m2"]) record(state, { type: "merged", id });
    expect(byId("m").state).toBe("done");
    expect(isReady("next")).toBe(true);
  });

  test("a failure holds what depends on it, down the chain; other branches go on; a retry releases them", () => {
    const { state, add, byId, fail, isReady } = graph();
    add("x", { tier: "communicator" });
    add("y", { after: ["x"] });
    add("z", { after: ["y"] });
    add("other");
    fail("x");
    fail("x");
    expect(["x", "y", "z", "other"].map((id) => [byId(id).state, byId(id).blocked])).toEqual([
      ["failed", undefined],
      ["blocked", "held"],
      ["blocked", "held"],
      ["queued", undefined],
    ]);
    expect(isReady("other")).toBe(true);
    retryJob(state, "x");
    expect(["x", "y", "z"].map((id) => byId(id).state)).toEqual(["queued", "queued", "queued"]);
  });

  test("failing twice moves a node up a tier, once per tier, with a note; at the top it fails", () => {
    const { add, byId, fail } = graph();
    add("x", { tier: "grunt" });
    fail("x");
    expect(byId("x")).toMatchObject({ state: "queued", tier: "grunt" });
    fail("x");
    expect(byId("x")).toMatchObject({ state: "queued", tier: "builder", escalations: 1 });
    expect(byId("x").notes.at(-1)).toMatchObject({
      kind: "factory",
      text: "failed twice on grunt; moves up to builder",
    });
    fail("x");
    fail("x");
    expect(byId("x").tier).toBe("communicator");
    fail("x");
    fail("x");
    expect(byId("x").state).toBe("failed");
  });

  test("goal nodes go by goal, factory's own first, then the longest chain after them", () => {
    const { add, jobs } = graph();
    add("short");
    add("long1");
    add("long2", { after: ["long1"] });
    add("long3", { after: ["long2"] });
    add("conflict", { front: true });
    const order = jobs()
      .filter((job) => job.of)
      .map((job) => job.id);
    expect(order).toEqual(["conflict", "long1", "long2", "short", "long3"]);
  });

  test("touches: overlapping globs never run at once; an empty list means anything; untracked never blocks", () => {
    const job = (touches?: string[]) => ({ touches }) as Job;
    expect(overlap(job(["gpui/src/**"]), job(["gpui/**"]))).toBe(true);
    expect(overlap(job(["gpui/**"]), job(["src/**"]))).toBe(false);
    expect(overlap(job([]), job(["src/**"]))).toBe(true);
    expect(overlap(job(undefined), job([]))).toBe(false);
    const { state, add, isReady } = graph();
    add("a", { touches: ["src/a/**"] });
    add("b", { touches: ["src/**"] });
    add("c", { touches: ["docs/**"] });
    startJob(state, "a", "claude");
    expect([isReady("b"), isReady("c")]).toEqual([false, true]);
  });
});

describe("assumptions", () => {
  test("ask --assume doesn't block; a different answer queues a change after the job, in its tier", () => {
    const { state, add, byId, jobs } = graph();
    add("x", { tier: "grunt", gates: ["make test"], touches: ["src/**"] });
    startJob(state, "x", "claude");
    addNote(state, "x", { kind: "assume", text: "tabs or spaces?", assumed: "spaces" });
    addNote(state, "x", { kind: "assume", text: "dark mode too?", assumed: "no" });
    expect(byId("x").state).toBe("running");
    expect(answer(state, "x", "fine")).toBeUndefined();
    const change = answer(state, "x", "yes, dark mode too")!;
    expect(change).toMatchObject({
      after: ["x"],
      tier: "grunt",
      of: "g",
      gates: ["make test"],
      touches: ["src/**"],
    });
    expect(change.prompt).toContain("assuming: no");
    expect(change.prompt).toContain("The user answered: yes, dark mode too");
    expect(() => answer(state, "x", "more")).toThrow("no question or assumption");
    expect(
      jobs()
        .filter((job) => job.of)
        .map((job) => job.id),
    ).toContain(change.id);
  });
});

test("a plain old fixture file still parses", () => {
  const state = mkdtempSync(join(scratch, "state-"));
  writeFileSync(
    join(state, "jobs.jsonl"),
    `${JSON.stringify({ at, type: "add", job: { id: "a", item: item("a"), source: "pick" } })}\n`,
  );
  expect(readJobs(state)[0]).toMatchObject({
    id: "a",
    after: [],
    gates: [],
    needs: [],
    unverified: [],
    escalations: 0,
  });
});

test("goal show: layers by dependency depth, tiers, the critical path, and what waits on the user", () => {
  const { state, add, jobs } = graph();
  add("base", { key: "base", tier: "builder" });
  add("ui", { key: "ui", tier: "communicator", after: ["base"] });
  add("port", { key: "port", tier: "grunt", after: ["base"] });
  add("polish", { key: "polish", tier: "grunt", after: ["ui"] });
  startJob(state, "port", "claude");
  addNote(state, "port", { kind: "assume", text: "keep the old API?", assumed: "yes" });
  const text = showGoal(
    jobs(),
    jobs().find((job) => job.id === "g")!,
  );
  expect(text).toMatch(/layer 0\n {4}base\s+base\s+builder\s+queued \*/);
  expect(text).toMatch(
    /layer 1\n {4}ui\s+ui\s+communicator\s+queued \*\n {4}port\s+port\s+grunt\s+running\n/,
  );
  expect(text).toContain("estimate: 1 communicator, 1 builder, 2 grunt attempts to go");
  expect(text).toContain("port: assumed yes, asked keep the old API?");
});

test("a plan can't make a node wait for the milestone that contains it", () => {
  const repo = mkdtempSync(join(scratch, "repo-"));
  mkdirSync(join(repo, ".git"));
  const node = (key: string, rest: object = {}) => ({
    key,
    title: key,
    tier: "grunt",
    prompt: "p",
    after: [],
    touches: [],
    gates: [],
    ...rest,
  });
  const problems = checkPlan({
    format: "factory-plan/1",
    goal: { title: "t", repo, summary: "s", gates: [] },
    nodes: [
      node("m"),
      node("a", { parent: "m", after: ["m"] }),
      node("b", { parent: "a", after: ["m"] }),
    ],
  });
  expect(problems).toEqual([
    "a comes after m, which contains it; drop it (a milestone's nodes already wait for what the milestone comes after)",
    "b comes after m, which contains it; drop it (a milestone's nodes already wait for what the milestone comes after)",
  ]);
});

test("a milestone needs only a key, a title and after; a node that runs needs the rest", () => {
  const repo = mkdtempSync(join(scratch, "repo-"));
  mkdirSync(join(repo, ".git"));
  const plan = (nodes: object[]) =>
    checkPlan({
      format: "factory-plan/1",
      goal: { title: "t", repo, summary: "s", gates: [] },
      nodes,
    });
  const runs = { key: "a", title: "a", parent: "m", after: [] };
  expect(
    plan([
      { key: "m", title: "m", after: [] },
      { ...runs, tier: "grunt", prompt: "p", touches: [], gates: [] },
    ]),
  ).toEqual([]);
  expect(plan([{ key: "m", title: "m", after: [] }, runs])).toEqual([
    "nodes[1] (a): prompt is empty",
    "nodes[1] (a): tier must be one of communicator, builder, grunt",
    "nodes[1] (a): touches must be a list of globs (empty: anything)",
    "nodes[1] (a): gates must be a list of commands",
  ]);
});

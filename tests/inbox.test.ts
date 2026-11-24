import { describe, expect, test } from "vite-plus/test";
import type { Job, Note, Pr } from "../src/backend/types.ts";
import { holds, inbox } from "../src/inbox.ts";

const job = (id: string, rest: Partial<Job> = {}): Job =>
  ({
    id,
    item: { repo: "/r", label: "r", id, blueprint: "p", attention: "skim", title: id },
    source: "pick",
    added: "2026-11-20T00:00:00.000Z",
    state: "queued",
    attempts: [],
    notes: [],
    after: [],
    gates: [],
    needs: [],
    unverified: [],
    escalations: 0,
    ...rest,
  }) as Job;
const note = (kind: Note["kind"], at: string, rest: Partial<Note> = {}): Note => ({
  at,
  attempt: 1,
  kind,
  text: kind,
  ...rest,
});
const withPr = (url: string): Partial<Job> => ({
  state: "done",
  attempts: [
    {
      run: "r",
      agent: "claude",
      start: "",
      end: "2026-11-21T00:00:00.000Z",
      outcome: "done",
      log: "",
      url,
    },
  ],
});
const pr = (state: Pr["state"]) => ({ state }) as Pr;

describe("inbox", () => {
  test("blocking work comes first and oldest first; the rest newest first", () => {
    const { stopped, ready } = inbox({
      jobs: [
        job("late", {
          state: "blocked",
          blocked: "asked",
          notes: [note("ask", "2026-11-22T00:00:00.000Z")],
        }),
        job("early", {
          state: "blocked",
          blocked: "asked",
          notes: [note("ask", "2026-11-21T00:00:00.000Z")],
        }),
        job("goal", { state: "blocked", blocked: "checkpoint", added: "2026-11-23T00:00:00.000Z" }),
        job("pr", withPr("https://github.com/o/r/pull/1")),
        job("assumed", {
          state: "done",
          notes: [note("assume", "2026-11-23T00:00:00.000Z", { assumed: "yes" })],
        }),
      ],
      prs: {},
    });
    expect(stopped.map((item) => `${item.kind} ${item.job.id}`)).toEqual([
      "ask early",
      "ask late",
      "checkpoint goal",
    ]);
    expect(ready.map((item) => `${item.kind} ${item.job.id}`)).toEqual([
      "assume assumed",
      "review pr",
    ]);
  });

  test("answered assumptions, merged PRs, goal nodes' PRs and paused jobs stay out", () => {
    const url = "https://github.com/o/r/pull/2";
    const { stopped, ready } = inbox({
      jobs: [
        job("answered", {
          state: "done",
          notes: [note("assume", "a"), note("answer", "b", { re: 0 })],
        }),
        job("merged", withPr(url)),
        job("node", { ...withPr("https://github.com/o/r/pull/3"), of: "goal" }),
        job("paused", { state: "blocked", blocked: "paused" }),
      ],
      prs: { [url]: pr("MERGED") },
    });
    expect([...stopped, ...ready]).toEqual([]);
  });

  test("a job holds the unfinished jobs that wait for it", () => {
    const failed = job("failed", { state: "failed" });
    const jobs = [
      failed,
      job("next", { after: ["failed"] }),
      job("done", { after: ["failed"], state: "done" }),
    ];
    expect(holds(failed, jobs)).toBe(1);
  });
});

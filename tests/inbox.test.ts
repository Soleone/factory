import { describe, expect, test } from "vite-plus/test";
import type { Job, Note, Pr } from "../src/backend/types.ts";
import { inboxText, taskTitle } from "../src/backend/inboxText.ts";
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

describe("inboxText", () => {
  const open = "https://github.com/o/r/pull/1";
  const merged = "https://github.com/o/r/pull/2";
  const closed = "https://github.com/o/r/pull/3";
  const item = (id: string, title: string, blueprint = "p") => ({
    item: { repo: "/src/app", label: "app", id, blueprint, attention: "skim", title },
  });

  test("prints the page's two groups, with counts, kinds, context, job ids and PRs", () => {
    const text = inboxText({
      jobs: [
        job("asked", {
          ...item("own-1", "Pick a parser"),
          state: "blocked",
          blocked: "asked",
          notes: [note("ask", "2026-11-21T00:00:00.000Z", { text: "yaml or toml?" })],
        }),
        job("goal", {
          ...item("g", "Units CLI"),
          state: "blocked",
          blocked: "checkpoint",
          added: "2026-11-22T00:00:00.000Z",
        }),
        job("broke", {
          ...item("file-size/src/App.tsx", "over 500 lines", "file-size"),
          state: "failed",
          attempts: [
            {
              run: "r",
              agent: "claude",
              start: "",
              end: "2026-11-23T00:00:00.000Z",
              outcome: "failed",
              log: "",
              error: "tests fail\nmore detail",
            },
          ],
        }),
        job("open", { ...item("simplify/src/Row.tsx", "", "simplify"), ...withPr(open) }),
        job("merged", withPr(merged)),
        job("closed", withPr(closed)),
        job("assumed", {
          ...item("bug-sweep/.", "the whole repo", "bug-sweep"),
          ...withPr(merged),
          notes: [note("assume", "2026-11-23T00:00:00.000Z", { text: "keep v1?", assumed: "yes" })],
          unverified: ["looks right on a phone"],
        }),
      ],
      prs: { [merged]: pr("MERGED"), [closed]: pr("CLOSED") },
    });
    expect(text).toBe(`Work stopped until you act (3)
  question   app: Pick a parser
             job asked
             asks: yaml or toml?
  approval   app: Units CLI
             job goal
             waiting for your approval
  failed     app: file-size src/App.tsx: over 500 lines
             job broke
             tests fail

Ready when you are (3)
  assumption app: bug-sweep: the whole repo
             job assumed  ${merged}
             assumed yes, asked: keep v1?
  PR         app: simplify src/Row.tsx
             job open  ${open}
  unverified app: bug-sweep: the whole repo
             job assumed  ${merged}
             not verified: looks right on a phone`);
  });

  test("says so when nothing waits, and when one group is empty", () => {
    expect(inboxText({ jobs: [], prs: {} })).toMatch(/^Nothing waits on you/);
    expect(inboxText({ jobs: [job("pr", withPr(open))], prs: {} })).toMatch(
      /^Work stopped until you act \(0\)\n  nothing\n\nReady when you are \(1\)/,
    );
  });

  test("a title workwork writes for its target gets the blueprint and target in front", () => {
    const title = (id: string, text: string, blueprint: string) =>
      taskTitle(item(id, text, blueprint).item);
    expect(title("dep-patch/yaml", "2.1 → 2.2", "dep-patch")).toBe(
      "app: dep-patch yaml: 2.1 → 2.2",
    );
    expect(title("simplify/src/a.ts", "", "simplify")).toBe("app: simplify src/a.ts");
    expect(title("bug-sweep/.", "Resolve conflicts: the whole repo", "conflicts")).toBe(
      "app: Resolve conflicts: the whole repo",
    );
    expect(title("own-1", "", "own")).toBe("app: own-1");
  });
});

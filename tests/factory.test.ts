import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { agent, classify, resetTime } from "../src/backend/agents.ts";
import {
  addJobs,
  addNote,
  autoPicks,
  endJob,
  moveJob,
  nextJob,
  queueFollowup,
  queueReview,
  queueReviewFix,
  order,
  readJobs,
  removeJob,
  retryJob,
  pinJob,
  startJob,
} from "../src/backend/jobs.ts";
import { readSettings } from "../src/backend/state.ts";
import type { Job } from "../src/backend/types.ts";
import { scratch, NOW, MINUTE, item } from "./harness.ts";

describe("limit messages", () => {
  test("reset times in every format the agents print", () => {
    expect(resetTime("Claude AI usage limit reached|1794801600", NOW)).toBe(1794801600_000);
    expect(resetTime("You've hit your session limit · resets 3pm (Europe/Berlin)", NOW)).toBe(
      Date.parse("2026-11-16T14:00:00Z"),
    );
    expect(
      resetTime("You've hit your weekly limit · resets Nov 20, 5pm (Europe/Berlin)", NOW),
    ).toBe(Date.parse("2026-11-20T16:00:00Z"));
    expect(resetTime("You've hit your limit · resets 3:30pm (America/New_York)", NOW)).toBe(
      Date.parse("2026-11-16T20:30:00Z"),
    );
    // Already past today in that zone, so tomorrow.
    expect(resetTime("You've hit your session limit · resets 3am (UTC)", NOW)).toBe(
      Date.parse("2026-11-17T03:00:00Z"),
    );
    const local = new Date(NOW);
    local.setHours(3, 0, 0, 0);
    if (local.getTime() <= NOW) local.setDate(local.getDate() + 1);
    expect(resetTime("5-hour limit reached ∙ resets 3am", NOW)).toBe(local.getTime());
    expect(
      resetTime("You have hit your ChatGPT usage limit (plus plan). Try again in ~42 min.", NOW),
    ).toBe(NOW + 42 * MINUTE);
    expect(resetTime("You've hit your usage limit. Try again in 5 minutes.", NOW)).toBe(
      NOW + 5 * MINUTE,
    );
    expect(
      resetTime('{"error":{"type":"usage_limit_reached","resets_in_seconds":3600}}', NOW),
    ).toBe(NOW + 3600_000);
    expect(resetTime('{"type":"usage_limit_reached","resets_at": 1794801600}', NOW)).toBe(
      1794801600_000,
    );
  });

  test("no reset time when the message has none or names an unknown zone", () => {
    expect(resetTime("You've hit your monthly spend limit.", NOW)).toBeUndefined();
    expect(resetTime("You've hit your limit · resets 3pm (Mars/Olympus)", NOW)).toBeUndefined();
  });

  test("classify reads the exit code and the end of the log", () => {
    const claude = agent("claude");
    const pi = agent("pi");
    const result = (isError: boolean, text: string) =>
      JSON.stringify({ type: "result", is_error: isError, result: text });
    expect(classify(claude, 0, result(false, "Opened a PR"))).toBe("done");
    expect(
      classify(
        claude,
        1,
        result(true, "You've hit your session limit · resets 3pm (Europe/Berlin)"),
      ),
    ).toBe("limited");
    expect(classify(claude, 0, result(true, "API Error: 500"))).toBe("failed");
    expect(classify(claude, 1, "Claude AI usage limit reached|1794801600")).toBe("limited");
    expect(
      classify(
        pi,
        1,
        "Error: You have hit your ChatGPT usage limit (plus plan). Try again in ~42 min.",
      ),
    ).toBe("limited");
    expect(classify(pi, 1, '{"code":"usage_limit_reached"}')).toBe("limited");
    expect(classify(pi, 1, "Error: ENOENT")).toBe("failed");
    // A limit the agent read about early in a successful run isn't one.
    expect(classify(pi, 0, `docs: usage limit reached\n${"work\n".repeat(3000)}done`)).toBe("done");
  });
});

describe("queue", () => {
  test("cheapest attention first, taking turns between repos, only the wanted attention", () => {
    const items = [
      item("a", "a1"),
      item("a", "a2"),
      item("a", "a3"),
      item("b", "b1"),
      item("a", "a4", "none"),
      item("b", "b2", "decide"),
      item("c", "c1"),
    ];
    expect(order(items, ["none", "skim", "decide"]).map((item) => item.id)).toEqual([
      "a4",
      "a1",
      "b1",
      "c1",
      "a2",
      "a3",
      "b2",
    ]);
    expect(order(items, ["none"]).map((item) => item.id)).toEqual(["a4"]);
  });

  test("auto mode takes only the chosen repos and blueprints, none chosen meaning all", () => {
    const items = [item("a", "a1"), item("b", "b1", "skim", "simplify"), item("c", "c1")];
    const ids = (auto: { blueprints: string[]; repos: string[] }) =>
      autoPicks(items, [], { attention: ["skim"], ...auto }, 5).map((item) => item.id);
    expect(ids({ blueprints: [], repos: [] })).toEqual(["a1", "b1", "c1"]);
    expect(ids({ blueprints: [], repos: ["a", "b"] })).toEqual(["a1", "b1"]);
    expect(ids({ blueprints: ["simplify"], repos: ["a", "b"] })).toEqual(["b1"]);
  });

  test("jobs and settings saved before blueprints still read, with auto as none", () => {
    const state = mkdtempSync(join(scratch, "state-"));
    const old = { repo: "r", label: "r", id: "todo/a", play: "todo", level: "auto", title: "a" };
    writeFileSync(
      join(state, "jobs.jsonl"),
      `${JSON.stringify({ at: "2026-11-01T00:00:00Z", type: "add", job: { id: "j", item: old, source: "pick" } })}\n`,
    );
    writeFileSync(
      join(state, "settings.json"),
      JSON.stringify({ auto: { on: true, levels: ["auto", "skim"], plays: ["todo"], repos: [] } }),
    );
    expect(readJobs(state)[0].item).toEqual({
      repo: "r",
      label: "r",
      id: "todo/a",
      blueprint: "todo",
      attention: "none",
      title: "a",
    });
    expect(readSettings(state).auto).toEqual({
      on: true,
      attention: ["none", "skim"],
      blueprints: ["todo"],
      repos: [],
    });
  });

  test("picks come before auto jobs, in the order the user gives them", async () => {
    const state = mkdtempSync(join(scratch, "state-"));
    addJobs(state, [item("r", "auto1")], "auto");
    const [a, b, c] = addJobs(state, [item("r", "a"), item("r", "b"), item("r", "c")], "pick");
    moveJob(state, c.id, 0);
    await removeJob(state, b.id);
    const ids = (jobs: Job[]) =>
      jobs.filter((job) => job.state === "queued").map((job) => job.item.id);
    expect(ids(readJobs(state))).toEqual(["c", "a", "auto1"]);
    moveJob(state, c.id, 1);
    expect(ids(readJobs(state))).toEqual(["a", "c", "auto1"]);
    await expect(removeJob(state, b.id)).rejects.toThrow("is removed");
    expect(() => retryJob(state, a.id)).toThrow(
      `Job ${a.id} is queued. Try again with a job in an allowed state: failed.`,
    );
  });
});

describe("jobs that wait on others", () => {
  test("a job waits for the one it comes after; the same blueprint is queued once", () => {
    const state = mkdtempSync(join(scratch, "state-"));
    const [fix] = addJobs(state, [item("r", "a")], "pick", { agent: "claude" });
    expect(addJobs(state, [item("r", "a")], "pick")).toEqual([]);
    expect(() => queueReview(state, fix.id, "claude")).toThrow("claude's own");
    const review = queueReview(state, fix.id, "pi")!;
    expect(review).toMatchObject({
      after: [fix.id],
      agent: "pi",
      item: { id: "a", blueprint: "review" },
    });
    expect(review.prompt).toContain("gh pr diff workwork/a");
    expect(queueReview(state, fix.id, "pi")).toBeUndefined();
    expect(nextJob(readJobs(state), "pi")).toBeUndefined();
    startJob(state, fix.id, "claude");
    endJob(state, fix.id, {
      run: "r",
      agent: "claude",
      start: "",
      end: "",
      outcome: "done",
      log: "",
    });
    expect(nextJob(readJobs(state), "pi")?.id).toBe(review.id);
  });

  test("a waiting job's pin can change until a worker takes it", () => {
    const state = mkdtempSync(join(scratch, "state-"));
    const [job] = addJobs(state, [item("r", "a")], "pick", { agent: "pi", model: "p/luna" });
    pinJob(state, job.id, { tier: "grunt" });
    expect(readJobs(state)[0]).toMatchObject({ tier: "grunt" });
    expect(readJobs(state)[0]).not.toHaveProperty("agent");
    pinJob(state, job.id, {});
    expect(readJobs(state)[0]).not.toHaveProperty("tier");
    startJob(state, job.id, "claude");
    expect(() => pinJob(state, job.id, { tier: "grunt" })).toThrow("is running");
  });

  test("a job waiting on one that failed is held, and goes on after a retry", () => {
    const state = mkdtempSync(join(scratch, "state-"));
    const [fix] = addJobs(state, [item("r", "a")], "pick", { agent: "claude" });
    const review = queueReview(state, fix.id, "pi")!;
    addJobs(state, [item("r", "b")], "pick", { after: [review.id] });
    for (let i = 0; i < 2; i++) {
      startJob(state, fix.id, "claude");
      endJob(state, fix.id, {
        run: "r",
        agent: "claude",
        start: "",
        end: "",
        outcome: "failed",
        log: "",
      });
    }
    const states = () => readJobs(state).map((job) => job.state);
    expect(states()).toEqual(["failed", "blocked", "blocked"]);
    expect(readJobs(state).map((job) => job.blocked)).toEqual([undefined, "held", "held"]);
    retryJob(state, fix.id);
    expect(states()).toEqual(["queued", "queued", "queued"]);
  });

  test("a review goes to another role, and its findings become a fix on the same PR", () => {
    const state = mkdtempSync(join(scratch, "state-"));
    const finish = (id: string, agent: string, followups: string[] = []) => {
      startJob(state, id, agent);
      addNote(state, id, { kind: "result", text: "done", followups });
      endJob(state, id, { run: "r", agent, start: "", end: "", outcome: "done", log: "" });
    };
    const [job] = addJobs(state, [item("r", "a")], "pick", { tier: "builder" });
    const review = queueReview(state, job.id)!;
    expect(review).toMatchObject({ tier: "communicator", branchOf: job.id });
    expect(review.prompt).toContain("--followup");
    finish(job.id, "claude");
    finish(review.id, "pi", ["a.ts:3 off by one"]);
    const fix = queueReviewFix(state, review.id)!;
    expect(fix).toMatchObject({
      tier: "builder",
      branchOf: job.id,
      item: { id: "a", blueprint: "fix" },
    });
    expect(fix.prompt).toContain("- a.ts:3 off by one");
    expect(queueReviewFix(state, review.id)).toBeUndefined();

    const [clean] = addJobs(state, [item("r", "b")], "pick");
    const second = queueReview(state, clean.id)!;
    expect(second.tier).toBe("builder");
    finish(second.id, "pi");
    expect(queueReviewFix(state, second.id)).toBeUndefined();
  });

  test("a follow-up an agent reported becomes its own job, once", () => {
    const state = mkdtempSync(join(scratch, "state-"));
    const [job] = addJobs(state, [item("r", "a")], "pick");
    startJob(state, job.id, "claude");
    addNote(state, job.id, { kind: "result", text: "done", followups: ["also b"] });
    expect(() => queueFollowup(state, job.id, "not reported")).toThrow("no follow-up");
    const followup = queueFollowup(state, job.id, "also b")!;
    expect(followup.item).toMatchObject({
      id: "a+followup",
      blueprint: "followup",
      title: "also b",
    });
    expect(followup.prompt).toMatch(/^also b\n/);
    expect(queueFollowup(state, job.id, "also b")).toBeUndefined();
  });
});

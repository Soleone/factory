import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { addJob, readJobs, record, startJob } from "../src/backend/jobs.ts";
import { feedback, failedRuns, watch, type Remark, type Run } from "../src/backend/triggers.ts";
import type { Job } from "../src/backend/types.ts";

const run = (headSha: string, conclusion: string, status = "completed"): Run => ({
  headSha,
  conclusion,
  status,
  url: `u-${headSha}-${conclusion}`,
  workflowName: "ci",
});

describe("triggers", () => {
  test("CI counts as red when the newest finished commit has a failed run", () => {
    expect(
      failedRuns([run("b", "", "in_progress"), run("a", "failure"), run("a", "success")]),
    ).toHaveLength(1);
    expect(failedRuns([run("b", "success"), run("a", "failure")])).toEqual([]);
  });

  test("feedback skips approvals and what agents said while they worked", () => {
    const attempt = { start: "2026-11-20T10:00:00Z", end: "2026-11-20T11:00:00Z" };
    const job = { item: { repo: "/r", id: "x" }, attempts: [attempt] } as Job;
    const remark = (id: string, at: string, rest: Partial<Remark> = {}): Remark => ({
      id,
      author: { login: "me" },
      body: id,
      createdAt: at,
      ...rest,
    });
    const remarks = [
      remark("agent", "2026-11-20T10:30:00Z"),
      remark("person", "2026-11-20T12:00:00Z"),
      remark("approved", "2026-11-20T12:00:00Z", { body: "", state: "APPROVED" }),
    ];
    expect(feedback(job, [job], remarks).map((each) => each.id)).toEqual(["person"]);
  });

  test("each event queues one job, once", async () => {
    const state = mkdtempSync(join(tmpdir(), "factory-triggers-"));
    const repo = mkdtempSync(join(tmpdir(), "factory-repo-"));
    const bin = mkdtempSync(join(tmpdir(), "factory-bin-"));
    const url = "https://github.com/o/r/pull/1";
    writeFileSync(
      join(bin, "gh"),
      `#!/bin/sh
case "$1 $2" in
  "repo view") echo main ;;
  "run list") echo '[{"headSha":"abc1234","status":"completed","conclusion":"failure","url":"r1","workflowName":"test"}]' ;;
  "issue list") echo '[{"number":7,"title":"Add dark mode","url":"https://github.com/o/r/issues/7"}]' ;;
  "pr view") echo '{"state":"OPEN","reviews":[],"comments":[{"id":"c1","author":{"login":"me"},"body":"rename it","createdAt":"2026-11-21T00:00:00Z"}]}' ;;
esac
`,
    );
    chmodSync(join(bin, "gh"), 0o755);
    process.env.PATH = `${bin}:${process.env.PATH}`;
    const item = { repo, label: "r", id: "x", blueprint: "p", attention: "skim", title: "X" };
    addJob(state, { id: "done", item, source: "pick" }, "2026-11-20T00:00:00Z");
    startJob(state, "done", "claude");
    record(state, {
      type: "attempt",
      id: "done",
      attempt: {
        run: "r",
        agent: "claude",
        start: "2026-11-20T00:00:00Z",
        end: "2026-11-20T01:00:00Z",
        outcome: "done",
        log: "",
        url,
      },
    });

    const first = await watch(state);
    expect(first).toHaveLength(3);
    const titles = readJobs(state).map((job) => job.item.title);
    expect(titles).toEqual(
      expect.arrayContaining(["Fix main: test failed", "Add dark mode", "Address review: X"]),
    );
    expect(await watch(state)).toEqual([]);
  });
});

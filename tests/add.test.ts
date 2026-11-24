import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { addJobs, readJobs } from "../src/backend/jobs.ts";
import { scratch, item, sh, script } from "./harness.ts";

describe("the factory", () => {
  describe("factory add", () => {
    /**
     * A repo, factory's state listing `listed` in it, and a workwork on PATH that logs each call and
     * fails the way listing a repo does without a git identity, unless `offers` says what it finds.
     */
    function setupAdd(listed: string[], offers?: string[]) {
      const repo = mkdtempSync(join(scratch, "repo-"));
      sh(repo, "git", "init", "-q");
      const data = mkdtempSync(join(scratch, "data-"));
      const state = join(data, "apps", "factory");
      execFileSync("mkdir", ["-p", state]);
      const items = (ids: string[]) => ids.map((id) => ({ ...item(repo, id), label: "repo" }));
      writeFileSync(
        join(state, "candidates.json"),
        JSON.stringify({ at: "2026-11-23T00:00:00Z", items: items(listed) }),
      );
      const bin = mkdtempSync(join(scratch, "bin-"));
      script(
        bin,
        "workwork",
        `echo "$*" >> ${bin}/calls\n` +
          (offers
            ? `echo '${JSON.stringify(items(offers))}'`
            : `echo "Author identity unknown\n\n*** Please tell me who you are." >&2; exit 128`),
      );
      // A shell without a git author, as in the session this came from.
      const noIdentity = join(scratch, "no-identity");
      writeFileSync(noIdentity, "");
      const env = {
        ...process.env,
        DATA: data,
        PATH: `${bin}:${process.env.PATH}`,
        GIT_CONFIG_GLOBAL: noIdentity,
      };
      const add = (...args: string[]) =>
        promisify(execFile)(process.execPath, ["src/backend/cli.ts", "add", ...args], { env });
      const calls = () =>
        existsSync(join(bin, "calls")) ? readFileSync(join(bin, "calls"), "utf8") : "";
      return { repo, state, add, calls };
    }

    test("queues candidates factory lists without asking workwork, with no git identity", async () => {
      const { repo, state, add, calls } = setupAdd(["a", "b"]);
      const [first] = addJobs(state, [item("other", "x")], "pick");
      const { stdout } = await add(
        "a",
        "b",
        "a",
        "--repo",
        repo,
        "--after",
        first.id,
        "--tier",
        "builder",
        "--machine",
      );
      expect(stdout).toMatch(/^queued \w+: repo a\nqueued \w+: repo b\n$/);
      expect(calls()).toBe("");
      const jobs = readJobs(state).filter((job) => job.item.repo === repo);
      expect(jobs.map((job) => [job.item.id, job.after, job.tier, job.machine])).toEqual([
        ["a", [first.id], "builder", true],
        ["b", [first.id], "builder", true],
      ]);
      // From a folder inside the repo, and again: already queued, still without workwork.
      execFileSync("mkdir", [join(repo, "sub")]);
      expect((await add("a", "--repo", join(repo, "sub"))).stdout).toBe("already queued: repo a\n");
      expect(calls()).toBe("");
    });

    test("asks workwork for an id factory doesn't list, and queues it", async () => {
      const { repo, state, add, calls } = setupAdd(["a"], ["a", "new"]);
      await add("a", "new", "--repo", repo);
      expect(calls()).toBe("--json\n");
      expect(readJobs(state).map((job) => job.item.id)).toEqual(["a", "new"]);
    });

    test("queues none of the ids when one is missing, and says what to do", async () => {
      const { repo, state, add } = setupAdd(["a"], ["a"]);
      await expect(add("a", "gone", "--repo", repo)).rejects.toThrow(
        /workwork has no candidate gone in .*; nothing queued\. .*--all-history/,
      );
      expect(readJobs(state)).toEqual([]);
    });

    test("queues none when workwork can't list the repo, and says why", async () => {
      const { repo, state, add } = setupAdd(["a"]);
      await expect(add("a", "new", "--repo", repo)).rejects.toThrow(
        /factory lists no new in .*, and asking workwork failed; nothing queued:[^]*Author identity unknown[^]*set user\.name and user\.email/,
      );
      expect(readJobs(state)).toEqual([]);
    });

    test("checks pins and --after before looking up candidates", async () => {
      const { repo, state, add, calls } = setupAdd(["a"]);
      await expect(add("new", "--repo", repo, "--tier", "nope")).rejects.toThrow("--tier wants");
      await expect(add("new", "--repo", repo, "--after", "nope")).rejects.toThrow(
        "--after names no job nope",
      );
      expect(readJobs(state)).toEqual([]);
      expect(calls()).toBe("");
    });
  });
});

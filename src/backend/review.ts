import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { output } from "./state.ts";
import type { Item, Pr } from "./types.ts";

const MINUTE = 60_000;

/** The PR workwork had the agent open, found by the branch workwork names; scans name theirs per area, so they find none. */
export async function findPr(item: Item): Promise<string | undefined> {
  const branch = `workwork/${item.id.replace(/[^\w./@-]+/g, "-")}`;
  const found: { url: string }[] = JSON.parse(
    await output(
      "gh",
      ["pr", "list", "--head", branch, "--state", "all", "--json", "url"],
      item.repo,
    ),
  );
  return found[0]?.url;
}

type Check = { conclusion?: string; state?: string };

async function readPr(url: string): Promise<Pr> {
  const raw: {
    state: Pr["state"];
    isDraft: boolean;
    title: string;
    body: string;
    additions: number;
    deletions: number;
    files: { path: string }[];
    mergeable: "UNKNOWN" | "CONFLICTING" | "MERGEABLE";
    isCrossRepository: boolean;
    statusCheckRollup: Check[];
  } = JSON.parse(
    await gh([
      "pr",
      "view",
      url,
      "--json",
      "state,isDraft,title,body,additions,deletions,files,mergeable,isCrossRepository,statusCheckRollup",
    ]),
  );
  return {
    state: raw.state,
    draft: raw.isDraft,
    title: raw.title,
    summary:
      raw.body
        .split(/^## /m)
        .find((section) => section.startsWith("Summary"))
        ?.slice("Summary".length)
        .trim() ?? "",
    level: /^Level: (\w+)\s*$/m.exec(raw.body)?.[1],
    additions: raw.additions,
    deletions: raw.deletions,
    files: raw.files.map((file) => file.path),
    checks: checks(raw.statusCheckRollup),
    conflicts: raw.mergeable === "UNKNOWN" ? null : raw.mergeable === "CONFLICTING",
    fork: raw.isCrossRepository,
  };
}

/** Check runs have a conclusion, empty while running; commit statuses have a state. */
function checks(rollup: Check[]): Pr["checks"] {
  if (rollup.length === 0) return "none";
  const results = rollup.map((check) => check.conclusion || check.state || "");
  if (results.some((result) => /FAILURE|ERROR|CANCELLED|TIMED_OUT|ACTION_REQUIRED/.test(result)))
    return "failing";
  if (results.some((result) => result === "" || result === "PENDING" || result === "EXPECTED"))
    return "pending";
  return "passing";
}

export const mergePr = (url: string) => gh(["pr", "merge", url, "--squash", "--delete-branch"]);
export const closePr = (url: string) => gh(["pr", "close", url, "--delete-branch"]);

export async function rebasePr(url: string): Promise<void> {
  const pull = /^(https:\/\/github\.com\/[\w.-]+\/[\w.-]+)\/pull\/(\d+)$/.exec(url);
  if (!pull) throw new Error("Rebase requires a github.com pull request URL");
  const [, repo, number] = pull;
  const pr: { baseRefName: string; headRefName: string; isCrossRepository: boolean } = JSON.parse(
    await gh(["pr", "view", url, "--json", "baseRefName,headRefName,isCrossRepository"]),
  );
  if (pr.isCrossRepository || pr.baseRefName === pr.headRefName)
    throw new Error("Rebase requires a separate PR branch in the same repository");

  const dir = await mkdtemp(join(tmpdir(), "factory-rebase-"));
  const git = (...args: string[]) => output("git", args, dir);
  const remote = `${repo}.git`;
  const base = "refs/factory/base";
  const head = "refs/factory/head";
  const branch = `refs/heads/${pr.headRefName}`;
  try {
    await git("init", "--quiet");
    await git("config", "--add", "credential.https://github.com.helper", "");
    await git("config", "--add", "credential.https://github.com.helper", "!gh auth git-credential");
    await git(
      "fetch",
      "--no-tags",
      remote,
      `refs/heads/${pr.baseRefName}:${base}`,
      `refs/pull/${number}/head:${head}`,
    );
    const before = (await git("rev-parse", head)).trim();
    await git("checkout", "--quiet", "--detach", head);
    try {
      await git("rebase", "--rebase-merges", base);
    } catch (error) {
      const conflicts = (await git("diff", "--name-only", "--diff-filter=U")).trim();
      if (!conflicts) throw error;
      throw new Error(
        `Rebase stopped. Resolve these conflicts manually; no changes were pushed:\n${conflicts}`,
      );
    }
    // Only update the branch if it still points at the PR head we rebased.
    await git("push", `--force-with-lease=${branch}:${before}`, remote, `HEAD:${branch}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Run outside any repo, so --delete-branch only touches GitHub, never a local checkout. */
const gh = (args: string[]) => output("gh", args, tmpdir());

/**
 * PR status for the page. gh takes a second or more per PR, so this answers from what it last
 * fetched and refreshes open PRs in the background. While GitHub calculates mergeability, retry
 * sooner so the page doesn't wait a minute after a rebase.
 */
export function prCache() {
  const cache = new Map<string, { at: number; pr?: Pr }>();

  function refresh(url: string): void {
    const entry = { at: Date.now(), pr: cache.get(url)?.pr };
    cache.set(url, entry);
    readPr(url).then(
      (pr) => (entry.pr = pr),
      (error: Error) => console.error(`factory: gh pr view ${url} failed: ${error.message}`),
    );
  }

  return {
    get(urls: string[]): Record<string, Pr> {
      const prs: Record<string, Pr> = {};
      for (const url of urls) {
        const entry = cache.get(url);
        const interval = entry?.pr?.conflicts === null ? 5_000 : MINUTE;
        if (!entry || ((entry.pr?.state ?? "OPEN") === "OPEN" && Date.now() - entry.at > interval))
          refresh(url);
        const pr = cache.get(url)!.pr;
        if (pr) prs[url] = pr;
      }
      return prs;
    },
    /** Asks GitHub now, for an action that must not act on a stale answer. */
    async fresh(url: string): Promise<Pr> {
      const pr = await readPr(url);
      cache.set(url, { at: Date.now(), pr });
      return pr;
    },
  };
}

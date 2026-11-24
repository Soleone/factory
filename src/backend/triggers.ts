import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { addJobs, readJobs } from "./jobs.ts";
import { itemKey, prUrl, type Item, type Job } from "./types.ts";
import { output, readSettings } from "./state.ts";

/** Work an event asks for, if any. `keys` name the events, so each one queues a job once. */
type Fired = { keys: string[]; item?: Item; prompt?: string };

export type Run = {
  conclusion: string;
  status: string;
  headSha: string;
  url: string;
  workflowName: string;
};

/** A review or a comment on a PR, as `gh pr view --json reviews,comments` lists them. */
export type Remark = {
  id: string;
  author: { login: string } | null;
  body: string;
  state?: string;
  submittedAt?: string;
  createdAt?: string;
};

/** The runs that failed on the newest commit with a finished run, newest first as gh lists them. */
export function failedRuns(runs: Run[]): Run[] {
  const sha = runs.find((run) => run.status === "completed")?.headSha;
  return runs.filter(
    (run) => run.headSha === sha && run.status === "completed" && run.conclusion === "failure",
  );
}

/**
 * Remarks a person left on the job's PR: not approvals, and not made while an agent worked on
 * the same item, since agents post with the user's account too.
 */
export function feedback(job: Job, jobs: Job[], remarks: Remark[]): Remark[] {
  const windows = jobs
    .filter((other) => itemKey(other.item) === itemKey(job.item))
    .flatMap((other) => other.attempts)
    .map((attempt) => [Date.parse(attempt.start), Date.parse(attempt.end || "9999")]);
  return remarks.filter((remark) => {
    const at = Date.parse(remark.submittedAt ?? remark.createdAt ?? "");
    if (remark.state === "APPROVED" && !remark.body.trim()) return false;
    return windows.every(([start, end]) => at < start || at > end);
  });
}

const gh = (args: string[], repo: string) => output("gh", args, repo);

async function redMain(repo: string): Promise<Fired[]> {
  const branch = await gh(
    ["repo", "view", "--json", "defaultBranchRef", "-q", ".defaultBranchRef.name"],
    repo,
  );
  const runs: Run[] = JSON.parse(
    await gh(
      [
        "run",
        "list",
        "--branch",
        branch.trim(),
        "--limit",
        "20",
        "--json",
        "conclusion,status,headSha,url,workflowName",
      ],
      repo,
    ),
  );
  const failed = failedRuns(runs);
  if (!failed.length) return [];
  const sha = failed[0].headSha;
  return [
    {
      keys: [`ci ${repo} ${sha}`],
      item: {
        repo,
        label: basename(repo),
        id: `ci-${sha.slice(0, 7)}`,
        blueprint: "ci",
        attention: "skim",
        title: `Fix ${branch.trim()}: ${[...new Set(failed.map((run) => run.workflowName))].join(", ")} failed`,
      },
      prompt: `CI fails on ${branch.trim()} at ${sha}:
${failed.map((run) => `- ${run.workflowName}: ${run.url}`).join("\n")}

Read the failures with \`gh run view <url> --log-failed\`, find the cause and fix it in a pull request. If it's flaky or outside the repo (an outage, a missing secret), change no code: rerun it with \`gh run rerun <url> --failed\` and say so in your result.
`,
    },
  ];
}

async function labeled(repo: string, label: string): Promise<Fired[]> {
  const issues: { number: number; title: string; url: string }[] = JSON.parse(
    await gh(
      ["issue", "list", "--label", label, "--state", "open", "--json", "number,title,url"],
      repo,
    ),
  );
  return issues.map((issue) => ({
    keys: [`issue ${issue.url}`],
    item: {
      repo,
      label: basename(repo),
      id: `issue-${issue.number}`,
      blueprint: "issue",
      attention: "decide",
      title: issue.title,
    },
    prompt: `Work on issue ${issue.url}. Read it and its comments with \`gh issue view ${issue.url} --comments\`, then do what it asks in a pull request whose body says "Closes #${issue.number}".
`,
  }));
}

async function reviewed(job: Job, jobs: Job[], seen: Set<string>): Promise<Fired[]> {
  const url = prUrl(job)!;
  const pr: { state: string; reviews: Remark[]; comments: Remark[] } = JSON.parse(
    await gh(["pr", "view", url, "--json", "state,reviews,comments"], job.item.repo),
  );
  // Recorded like an event, so a merged or closed PR isn't asked about again.
  if (pr.state !== "OPEN") return [{ keys: [`closed ${url}`] }];
  const remarks = feedback(job, jobs, [...pr.reviews, ...pr.comments]).filter(
    (remark) => !seen.has(`remark ${remark.id}`),
  );
  if (!remarks.length) return [];
  return [
    {
      keys: remarks.map((remark) => `remark ${remark.id}`),
      // The job's workwork id, so the attempt finds and links the same PR.
      item: { ...job.item, blueprint: "feedback", title: `Address review: ${job.item.title}` },
      prompt: `Pull request ${url} got feedback:
${remarks.map((remark) => `- ${remark.author?.login ?? "someone"}: ${remark.body.trim().slice(0, 500) || `(${remark.state?.toLowerCase()}, see its inline comments)`}`).join("\n")}

1. Check out its branch with \`gh pr checkout ${url}\`.
2. Read every point in full: \`gh pr view ${url} --comments\`, and the inline ones with \`gh api repos/{owner}/{repo}/pulls/${url.split("/").at(-1)}/comments\`.
3. Address each point, run the repo's checks and tests, and push to the same branch. Don't open a new pull request.
4. Reply on the pull request with what changed, or why you'd leave a point as it is.

End your reply with the pull request's URL.
`,
    },
  ];
}

const seenPath = (state: string) => join(state, "triggers.json");

/**
 * Queues a job for each new event in the repos factory works in: CI failing on the default
 * branch, an open issue with the trigger label, and a person's review or comment on a job's PR.
 * Returns what it queued, one line each; a repo gh can't read is skipped with a line of its own.
 */
export async function watch(state: string): Promise<string[]> {
  const { triggers } = readSettings(state);
  const jobs = readJobs(state).filter((job) => job.state !== "removed");
  const repos = [...new Set(jobs.map((job) => job.item.repo))].filter(existsSync);
  const seen = new Set<string>(
    existsSync(seenPath(state)) ? JSON.parse(readFileSync(seenPath(state), "utf8")) : [],
  );
  // One job per PR; later jobs on it (conflicts, feedback) link the same one.
  const prs = new Map(
    jobs
      .filter((job) => job.state === "done" && !job.of && prUrl(job))
      .map((job) => [prUrl(job)!, job]),
  );
  for (const url of prs.keys()) if (seen.has(`closed ${url}`)) prs.delete(url);
  const checks = [
    ...(triggers.ci ? repos.map(redMain) : []),
    ...(triggers.label ? repos.map((repo) => labeled(repo, triggers.label)) : []),
    ...(triggers.reviews ? [...prs.values()].map((job) => reviewed(job, jobs, seen)) : []),
  ];
  const lines: string[] = [];
  const fired = (await Promise.allSettled(checks)).flatMap((result) => {
    if (result.status === "fulfilled") return result.value;
    lines.push(`a trigger can't ask GitHub: ${(result.reason as Error).message.split("\n")[0]}`);
    return [];
  });
  for (const { keys, item, prompt } of fired) {
    if (keys.every((key) => seen.has(key))) continue;
    keys.forEach((key) => seen.add(key));
    if (!item) continue;
    for (const job of addJobs(state, [item], "pick", { prompt }))
      lines.push(`queued ${job.id}: ${item.label} ${item.title}`);
  }
  writeFileSync(seenPath(state), `${JSON.stringify([...seen], null, 2)}\n`);
  return lines;
}

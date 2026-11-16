// Staging: candidates from the repos the user picked, a bounded list they read, and the exact items
// they approve. `factory run --queue` takes only those; nothing here decides what runs.
import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { output } from "./loop.ts";
import { key, order, readLedger, replay, type Item } from "./state.ts";

/** What workwork says a candidate rests on: a tool reported it (finding), or it only says where to look. */
export const KINDS = ["finding", "scan", "rotation"] as const;
type Kind = (typeof KINDS)[number];

const MEANING: Record<Kind, string> = {
  finding: "a tool reported this exact thing",
  scan: "an agent would search the whole repo; nothing found yet",
  rotation: "one file in turn; nothing found in it yet",
};

type Staged = Item & { kind: Kind; title: string };

export type Stage = {
  date: string;
  repos: { repo: string; head: string }[];
  /** Numbered from 1 in this order by preview and approve. */
  items: Staged[];
  /** Candidates left out: past --limit, or of a kind --kinds didn't ask for. */
  left: { limit: number; kinds: Partial<Record<Kind, number>> };
  /** Finders that failed, as workwork reported them. */
  errors: string[];
};

export type Queue = { date: string; items: Staged[] };

export type StageOptions = {
  repos: string[];
  levels: string[];
  kinds: string[];
  limit: number;
  /** Fast-forward each checkout to its remote default branch first. */
  pull: boolean;
  state: string;
  workwork: string;
};

/** Pulls, asks workwork about each repo, and saves at most `limit` candidates for preview and approve. */
export async function stage(options: StageOptions): Promise<Stage> {
  const repos: Stage["repos"] = [];
  const candidates: Staged[] = [];
  const errors: string[] = [];
  for (const repo of options.repos) {
    if (options.pull) await pull(repo);
    repos.push({
      repo,
      head: (await output("git", ["rev-parse", "--short", "HEAD"], repo)).trim(),
    });
    const { stdout, stderr } = await promisify(execFile)(options.workwork, ["--json"], {
      cwd: repo,
      maxBuffer: 64 * 1024 * 1024,
    });
    errors.push(...stderr.split("\n").filter(Boolean));
    candidates.push(...JSON.parse(stdout));
  }
  if (candidates.some((candidate) => !KINDS.includes(candidate.kind)))
    throw new Error("workwork's --json has no kind; factory stage needs a newer workwork");

  const { finished } = replay(readLedger(options.state));
  const open = candidates.filter(
    (candidate) => !finished.has(key(candidate)) && options.levels.includes(candidate.level),
  );
  const kinds: Stage["left"]["kinds"] = {};
  for (const { kind } of open.filter((candidate) => !options.kinds.includes(candidate.kind)))
    kinds[kind] = (kinds[kind] ?? 0) + 1;
  // Within a level, findings come before scans and scans before rotations.
  const wanted = order(
    KINDS.flatMap((kind) =>
      options.kinds.includes(kind) ? open.filter((candidate) => candidate.kind === kind) : [],
    ),
    options.levels,
  );
  const staged: Stage = {
    date: new Date().toISOString(),
    repos,
    items: wanted.slice(0, options.limit),
    left: { limit: Math.max(0, wanted.length - options.limit), kinds },
    errors,
  };
  writeJson(options.state, "stage.json", staged);
  return staged;
}

/**
 * Discovery reads the checkout, so a stale one finds stale work. Only a fast-forward of a clean
 * default branch is safe to do unasked; anything else is the user's to sort out.
 */
async function pull(repo: string): Promise<void> {
  await output("git", ["fetch", "--quiet", "origin"], repo);
  const remote = (
    await output("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], repo)
  ).trim();
  const main = remote.slice(remote.indexOf("/") + 1);
  const branch = (await output("git", ["branch", "--show-current"], repo)).trim();
  const instead = "or stage with --no-pull to use it as it is";
  if (branch !== main)
    throw new Error(
      `${repo} is on ${branch || "a detached HEAD"}, not ${main}: switch, ${instead}`,
    );
  if ((await output("git", ["status", "--porcelain", "--untracked-files=no"], repo)).trim())
    throw new Error(`${repo} has uncommitted changes: commit or stash them, ${instead}`);
  try {
    await output("git", ["merge", "--ff-only", "--quiet", remote], repo);
  } catch (error) {
    const why = (error as Error).message.trim().split("\n").at(-1);
    throw new Error(`${repo} can't fast-forward ${main} to ${remote} (${why}), ${instead}`);
  }
}

/** Saves exactly the picked items (1-based numbers from preview, or "all") as the queue `--queue` runs. */
export function approve(state: string, picks: string[]): Queue {
  const { items } = readStage(state);
  const words = picks.flatMap((pick) => pick.split(",")).filter(Boolean);
  if (words.length === 0) throw new Error("approve which? factory approve 1,3 (or all)");
  const chosen =
    words.length === 1 && words[0] === "all"
      ? items
      : words.map((word) => {
          const n = Number(word);
          if (!Number.isInteger(n) || n < 1 || n > items.length)
            throw new Error(
              `no staged item ${word}; factory preview numbers them 1 to ${items.length}`,
            );
          return items[n - 1];
        });
  const queue: Queue = { date: new Date().toISOString(), items: [...new Set(chosen)] };
  writeJson(state, "queue.json", queue);
  return queue;
}

export function readQueue(state: string): Queue {
  const path = join(state, "queue.json");
  if (!existsSync(path))
    throw new Error("nothing approved yet: factory stage, factory preview, factory approve");
  return JSON.parse(readFileSync(path, "utf8"));
}

/** The staged list, numbered, with what each kind means, what was left out, and what's approved and done. */
export function preview(state: string): string {
  const staged = readStage(state);
  const path = join(state, "queue.json");
  const queue: Queue | undefined = existsSync(path)
    ? JSON.parse(readFileSync(path, "utf8"))
    : undefined;
  const approved = new Set(queue?.items.map(key));
  const last = new Map(readLedger(state).map((entry) => [key(entry), entry]));
  const where = staged.repos.map(({ repo, head }) => `${basename(repo)} at ${head}`).join(", ");
  const lines = [`Staged ${when(staged.date)} from ${where}: ${staged.items.length} items`];

  const width = Math.min(48, Math.max(0, ...staged.items.map(({ id }) => id.length)));
  let level = "";
  for (const [i, item] of staged.items.entries()) {
    if (item.level !== level) lines.push("", (level = item.level));
    const outcome = last.get(key(item));
    const result = outcome ? ` → ${outcome.outcome} ${outcome.url ?? outcome.log}` : "";
    lines.push(
      `${approved.has(key(item)) ? "*" : " "}${String(i + 1).padStart(3)}  ${basename(item.repo)}  ${item.id.padEnd(width)}  ${item.kind.padEnd(8)}  ${item.title}${result}`.trimEnd(),
    );
  }

  const shown = KINDS.filter((kind) => staged.items.some((item) => item.kind === kind));
  if (shown.length) lines.push("", ...shown.map((kind) => `${kind}: ${MEANING[kind]}`));
  const left = [
    staged.left.limit ? `${staged.left.limit} past --limit` : "",
    ...Object.entries(staged.left.kinds).map(([kind, n]) => `${n} ${kind} (--kinds)`),
  ].filter(Boolean);
  if (left.length) lines.push(`Not staged: ${left.join(", ")}`);
  if (staged.errors.length)
    lines.push("", "Finders that failed:", ...staged.errors.map((e) => `  ${e}`));

  lines.push("");
  if (queue) {
    const elsewhere = queue.items.filter(
      (item) => !staged.items.some((each) => key(each) === key(item)),
    );
    lines.push(
      `Approved ${when(queue.date)}: ${queue.items.length} items, marked *${elsewhere.length ? `, and from an earlier stage: ${elsewhere.map((item) => item.id).join(", ")}` : ""}`,
      "Run them: factory start --queue",
    );
  }
  lines.push("Approve: factory approve <numbers, like 1,3> | all (replaces what's approved)");
  return lines.join("\n");
}

function readStage(state: string): Stage {
  const path = join(state, "stage.json");
  if (!existsSync(path)) throw new Error("nothing staged yet: factory stage --repo <name>");
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(state: string, name: string, value: unknown): void {
  writeFileSync(join(state, name), `${JSON.stringify(value, null, 2)}\n`);
}

/** Local time, with its zone, so it reads right whatever TZ says. */
function when(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  });
}

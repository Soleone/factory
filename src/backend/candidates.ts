import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { ownedRepos } from "./repos.ts";
import { alive, output } from "./state.ts";
import {
  itemKey,
  scanKey,
  upgradeItem,
  type Blueprint,
  type Candidates,
  type Item,
  type Scan,
} from "./types.ts";

/**
 * Repos scanned at once in a sweep. workwork --all does one at a time because some finders (kit
 * check) are heavy, but a few at once still finish many times sooner.
 */
const POOL = 3;

const candidatesPath = (state: string) => join(state, "candidates.json");

export function readCandidates(state: string): Candidates | undefined {
  if (!existsSync(candidatesPath(state))) return undefined;
  const { at, items, scans } = JSON.parse(readFileSync(candidatesPath(state), "utf8"));
  return { at, items: items.map(upgradeItem), scans: scans ?? {} };
}

function writeCandidates(state: string, change: (cached: Candidates) => Candidates) {
  const cached = readCandidates(state) ?? { at: "", items: [], scans: {} };
  writeFileSync(candidatesPath(state), JSON.stringify(change(cached)));
}

/** One lock per scan, so one repo or blueprint can be scanned while another, or a sweep, is. */
const lockPath = (state: string, scan: Scan) =>
  join(
    state,
    `candidates-${createHash("sha1")
      .update(JSON.stringify([scan.repo, scan.blueprint]))
      .digest("hex")
      .slice(0, 12)}.lock`,
  );

/** The scan a live process holds the lock for; a lock being created or removed right now has none. */
function holder(path: string): Scan | undefined {
  try {
    const { pid, ...scan } = JSON.parse(readFileSync(path, "utf8"));
    return alive(pid) ? scan : undefined;
  } catch {
    return undefined;
  }
}

const writeLock = (path: string, scan: Scan) =>
  writeFileSync(path, JSON.stringify({ pid: process.pid, ...scan }));

/** The scans under way in any process (the factory or serve). */
export function refreshingCandidates(state: string): Scan[] {
  return readdirSync(state)
    .filter((name) => /^candidates-\w+\.lock$/.test(name))
    .flatMap((name) => holder(join(state, name)) ?? []);
}

/**
 * Asks workwork again: in `repo`, or every repo of the user's under $SRC; for `blueprint`, or every
 * blueprint that isn't on request. Unless some process already is. One repo takes under a minute.
 */
export async function refreshCandidates(
  state: string,
  workwork: string,
  scan: Omit<Scan, "done" | "total"> = {},
): Promise<void> {
  const lock = lockPath(state, scan);
  if (holder(lock)) return;
  rmSync(lock, { force: true });
  try {
    closeSync(openSync(lock, "wx"));
  } catch (error) {
    // Another process took the lock between the check and here.
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
    throw error;
  }
  writeLock(lock, scan);
  try {
    if (scan.repo) await scanRepo(state, workwork, scan.repo, scan.blueprint);
    else await sweep(state, workwork, lock, scan.blueprint);
  } finally {
    rmSync(lock, { force: true });
  }
}

/** Every repo of the user's, a few at once, saving each as it finishes so the page fills in. */
async function sweep(state: string, workwork: string, lock: string, blueprint?: string) {
  const started = new Date().toISOString();
  const repos = await ownedRepos();
  const left = [...repos];
  let done = 0;
  writeLock(lock, { blueprint, done, total: repos.length });
  await Promise.all(
    Array.from({ length: POOL }, async () => {
      for (let repo = left.shift(); repo; repo = left.shift()) {
        // One repo failing (no git identity, say) shouldn't cost the others theirs.
        await refreshCandidates(state, workwork, { repo, blueprint }).catch((error: Error) =>
          console.error(`factory: workwork failed in ${repo}: ${error.message}`),
        );
        writeLock(lock, { blueprint, done: ++done, total: repos.length });
      }
    }),
  );
  if (blueprint) return;
  const owned = new Set(repos);
  writeCandidates(state, (cached) => ({
    at: started,
    items: cached.items.filter((item) => owned.has(item.repo)),
    scans: Object.fromEntries(Object.entries(cached.scans).filter(([, at]) => at > started)),
  }));
}

/**
 * One repo, replacing what workwork said about it before. A plain scan keeps on-request
 * blueprints' candidates, since only scanning that blueprint finds them.
 */
async function scanRepo(state: string, workwork: string, repo: string, blueprint?: string) {
  // When workwork started looking: a job that ends while it looks may still be in its answer.
  const at = new Date().toISOString();
  const args = blueprint ? ["--blueprint", blueprint, "--json"] : ["--json"];
  const found: Item[] = JSON.parse(await output(workwork, args, repo));
  const onRequest = blueprint
    ? new Set<string>()
    : new Set(
        (JSON.parse(await output(workwork, ["blueprints", "--json"], repo)) as Blueprint[])
          .filter((each) => each.onRequest)
          .map((each) => each.name),
      );
  const replaced = (item: Item) =>
    item.repo === repo &&
    (blueprint ? item.blueprint === blueprint : !onRequest.has(item.blueprint));
  writeCandidates(state, (cached) => ({
    ...cached,
    items: [...cached.items.filter((item) => !replaced(item)), ...found],
    scans: { ...cached.scans, [scanKey(repo, blueprint)]: at },
  }));
}

/**
 * Records the user's verdict with workwork, in each item's repo, and drops the item: reject hides
 * it for good, defer until its code changes.
 */
export async function decideCandidates(
  state: string,
  workwork: string,
  items: Item[],
  verdict: "reject" | "defer",
): Promise<void> {
  for (const item of items) {
    await output(workwork, ["decide", item.id, verdict], item.repo);
    writeCandidates(state, (cached) => ({
      ...cached,
      items: cached.items.filter((each) => itemKey(each) !== itemKey(item)),
    }));
  }
}

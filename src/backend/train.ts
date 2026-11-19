import { Conflicts, mergePr, rebasePr, type prCache } from "./review.ts";
import { canMerge, onTrain, type Pr, type TrainCar } from "./types.ts";

const POLL = 10_000;
const PATIENCE = 30 * 60_000;
/** A PR gets this many tries at rebase-then-merge before the train gives up on it. */
const TRIES = 3;

/**
 * Merges PRs one after another per repo, since each merge moves the base under the next one.
 * Repos go in parallel. A PR that conflicts is rebased; one that can't be is skipped with the reason,
 * and when git stopped on conflicts, handed to `onConflicts` to queue for an agent.
 */
export function mergeTrain(
  prs: ReturnType<typeof prCache>,
  onConflicts: (id: string, url: string, files: string[]) => void,
) {
  const cars = new Map<string, TrainCar>();
  /** Each repo's last PR on the train; a new one waits for it, even from a later start. */
  const tracks = new Map<string, Promise<void>>();

  /** GitHub's answer once mergeability is known and checks have finished. */
  async function settled(id: string, url: string): Promise<Pr> {
    const deadline = Date.now() + PATIENCE;
    for (;;) {
      const pr = await prs.fresh(url);
      if (pr.state !== "OPEN" || (pr.conflicts !== null && pr.checks !== "pending")) return pr;
      if (Date.now() > deadline) throw new Error("checks still running after 30 minutes");
      cars.set(id, { step: "waiting" });
      await new Promise((resolve) => setTimeout(resolve, POLL));
    }
  }

  async function land(id: string, url: string): Promise<void> {
    for (let tries = 1; ; tries++) {
      const pr = await settled(id, url);
      if (pr.state !== "OPEN") throw new Error(`already ${pr.state.toLowerCase()}`);
      if (pr.conflicts) {
        if (pr.fork) throw new Error("conflicts in a fork");
      } else {
        if (!canMerge(pr)) throw new Error(blocker(pr));
        cars.set(id, { step: "merging" });
        try {
          await mergePr(url);
          await prs.fresh(url);
          return;
        } catch (error) {
          // GitHub can still call it mergeable right after the merge before it, or want it up to date.
          if (tries >= TRIES || pr.fork) throw error;
        }
      }
      if (tries >= TRIES) throw new Error(`still conflicting after ${TRIES} rebases`);
      cars.set(id, { step: "rebasing" });
      await rebasePr(url);
    }
  }

  return {
    cars: () => Object.fromEntries(cars),
    /** Smallest diffs first, so the ones most likely to clash merge last. */
    start(jobs: { id: string; url: string }[]): void {
      const boarding = jobs.filter(({ id }) => !onTrain(cars.get(id)));
      const known = prs.get(boarding.map(({ url }) => url));
      const size = (url: string) => (known[url]?.additions ?? 0) + (known[url]?.deletions ?? 0);
      for (const { id, url } of boarding.toSorted((a, b) => size(a.url) - size(b.url))) {
        cars.set(id, { step: "queued" });
        const repo = url.replace(/\/pull\/\d+$/, "");
        const track = (tracks.get(repo) ?? Promise.resolve())
          .then(() => land(id, url))
          .then(
            () => void cars.set(id, { step: "merged" }),
            (error: Error) => {
              if (!(error instanceof Conflicts))
                return void cars.set(id, { step: "skipped", reason: error.message });
              onConflicts(id, url, error.files);
              const reason = `conflicts in ${error.files.join(", ")}; a job to resolve them is queued`;
              cars.set(id, { step: "skipped", reason });
            },
          );
        tracks.set(repo, track);
      }
    },
  };
}

function blocker(pr: Pr): string {
  if (pr.draft) return "draft";
  if (pr.checks === "failing") return "checks failing";
  return "not ready to merge";
}

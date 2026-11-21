import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { output } from "./state.ts";

/** The worktree at `base`, created on first use; reused across jobs so installed dependencies survive. */
export async function checkout(worktree: string, repo: string, base: string): Promise<void> {
  if (!existsSync(worktree)) {
    await output("git", ["worktree", "prune"], repo);
    mkdirSync(join(worktree, ".."), { recursive: true });
    await output("git", ["worktree", "add", "--quiet", "--detach", worktree, base], repo);
    return;
  }
  // Whatever a crashed run left here is kept before the reset; work the last attempt kept is already on its branch.
  await keepWork(worktree, `factory/leftover-${Date.now()}`, ["--remotes", "--branches"]);
  await output("git", ["checkout", "--quiet", "--force", "--detach", base], worktree);
  // Untracked files go; ignored ones like node_modules stay.
  await output("git", ["clean", "-fdq"], worktree);
}

/** origin's default branch, freshly fetched, as origin itself names it. */
export async function originHead(repo: string): Promise<string> {
  await output("git", ["fetch", "--quiet", "origin"], repo);
  // Asks origin itself: clones made with `git remote add` have no refs/remotes/origin/HEAD.
  const head = await output("git", ["ls-remote", "--symref", "origin", "HEAD"], repo);
  const branch = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(head)?.[1];
  if (!branch) throw new Error(`origin of ${repo} names no default branch`);
  return branch;
}

/** Saves commits and changes that aren't on `saved` refs to a branch; returns its name, if there was any. */
export async function keepWork(
  worktree: string,
  branch: string,
  saved = ["--remotes"],
): Promise<string | undefined> {
  if (!existsSync(worktree)) return undefined;
  if ((await output("git", ["status", "--porcelain"], worktree)).trim()) {
    await output("git", ["add", "-A"], worktree);
    await output(
      "git",
      ["commit", "--quiet", "--no-verify", "-m", "factory: changes the agent left uncommitted"],
      worktree,
    );
  }
  const unpushed = await output("git", ["log", "--oneline", "HEAD", "--not", ...saved], worktree);
  if (!unpushed.trim()) return undefined;
  await output("git", ["branch", "--force", branch, "HEAD"], worktree);
  return branch;
}

/** A worktree back in the pool: detached, so the branch it was on is free to check out elsewhere. */
export async function release(worktree: string): Promise<void> {
  if (existsSync(worktree)) await output("git", ["checkout", "--quiet", "--detach"], worktree);
}

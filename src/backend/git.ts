import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { output } from "./state.ts";
import type { CommitIdentity, Settings } from "./types.ts";

export function identityEnv(identity: CommitIdentity | undefined): Record<string, string> {
  return identity
    ? {
        GIT_AUTHOR_NAME: identity.name,
        GIT_AUTHOR_EMAIL: identity.email,
        GIT_COMMITTER_NAME: identity.name,
        GIT_COMMITTER_EMAIL: identity.email,
      }
    : {};
}

export function worktreeEnv(
  settings: Settings,
  repo: string,
  worktree: string,
): Record<string, string> {
  const extra = settings.env[repo] ?? {};
  return {
    ...Object.fromEntries(
      Object.entries(extra).map(([key, value]) => [key, value.replaceAll("{worktree}", worktree)]),
    ),
    ...identityEnv(settings.commitIdentity),
  };
}

export const worktreeGit =
  (worktree: string, env: Record<string, string>) =>
  (...args: string[]) =>
    output("git", args, worktree, undefined, env);

export class GitIdentityError extends Error {
  constructor() {
    super(
      "Git needs a name and email to create commits. Set both in Settings → GitHub → Commit identity, or configure Git for this repository, then retry the job.",
    );
  }
}

/** Ask Git in the actual worktree, where conditional and worktree-local config takes effect. */
export async function requireIdentity(git: ReturnType<typeof worktreeGit>): Promise<void> {
  try {
    for (const role of ["AUTHOR", "COMMITTER"]) {
      const identity = await git("var", `GIT_${role}_IDENT`);
      if (!/^\S[^\n]* <[^\s<>@]+@[^\s<>@]+> \d+ [+-]\d{4}\n?$/.test(identity))
        throw new GitIdentityError();
    }
  } catch {
    throw new GitIdentityError();
  }
}

/** The worktree at `base`, created on first use; reused across jobs so installed dependencies survive. */
export async function checkout(
  worktree: string,
  repo: string,
  base: string,
  env: Record<string, string>,
): Promise<void> {
  if (!existsSync(worktree)) {
    await output("git", ["worktree", "prune"], repo);
    mkdirSync(join(worktree, ".."), { recursive: true });
    await output("git", ["worktree", "add", "--quiet", "--detach", worktree, base], repo);
    return;
  }
  // Whatever a crashed run left here is kept before the reset; work the last attempt kept is already on its branch.
  await keepWork(worktree, `factory/leftover-${Date.now()}`, env, ["--remotes", "--branches"]);
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
  env: Record<string, string>,
  saved = ["--remotes"],
): Promise<string | undefined> {
  if (!existsSync(worktree)) return undefined;
  const git = worktreeGit(worktree, env);
  if ((await git("status", "--porcelain")).trim()) {
    await requireIdentity(git);
    await git("add", "-A");
    await git(
      "commit",
      "--quiet",
      "--no-verify",
      "-m",
      "factory: changes the agent left uncommitted",
    );
  }
  const unpushed = await git("log", "--oneline", "HEAD", "--not", ...saved);
  if (!unpushed.trim()) return undefined;
  await git("branch", "--force", branch, "HEAD");
  return branch;
}

/** A worktree back in the pool: detached, so the branch it was on is free to check out elsewhere. */
export async function release(worktree: string): Promise<void> {
  if (existsSync(worktree)) await output("git", ["checkout", "--quiet", "--detach"], worktree);
}

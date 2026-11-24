import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CommitIdentity } from "./types.ts";

/** An explicit, read-only suggestion from the active github.com account. */
export async function githubIdentity(): Promise<CommitIdentity> {
  let profile: { name?: string | null; login: string; id: number };
  try {
    const { stdout } = await promisify(execFile)(
      "gh",
      ["api", "--hostname", "github.com", "user", "--jq", "{name, login, id}"],
      { timeout: 10_000, env: { ...process.env, GH_PROMPT_DISABLED: "1" } },
    );
    profile = JSON.parse(stdout);
  } catch (error) {
    // Don't relay gh's stdout, stderr, or command errors to the UI or server log.
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error(
        "GitHub CLI (gh) is not installed or not on Factory’s PATH. Enter your name and email manually.",
      );
    throw new Error(
      "Could not read the GitHub profile. Sign in with gh auth login and try again, or enter your name and email manually.",
    );
  }
  if (
    !/^[\w-]+$/.test(profile?.login ?? "") ||
    !Number.isSafeInteger(profile.id) ||
    profile.id <= 0
  )
    throw new Error(
      "GitHub did not return a usable login and account ID. Enter your name and email manually.",
    );
  return {
    name: profile.name?.trim() || profile.login,
    email: `${profile.id}+${profile.login}@users.noreply.github.com`,
  };
}

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { output } from "./state.ts";

/** Where workwork --all looks for repos, with the same fallback. */
const SRC = process.env.SRC ?? process.cwd();

export type GithubRepo = { name: string; description: string; createdAt: string };

/**
 * The GitHub user's own repos (not forked or archived) that aren't cloned anywhere under $SRC
 * yet, newest first.
 */
export async function clonableRepos(): Promise<{ root: string; repos: GithubRepo[] }> {
  const listed: { nameWithOwner: string; description: string; createdAt: string }[] = JSON.parse(
    await output(
      "gh",
      [
        "repo",
        "list",
        "--source",
        "--no-archived",
        "--limit",
        "5000",
        "--json",
        "nameWithOwner,description,createdAt",
      ],
      SRC,
    ),
  );
  const local = findRepos(SRC, 4);
  const cloned = new Set(await Promise.all(local.map(originName)));
  const repos = listed
    .filter((repo) => !cloned.has(repo.nameWithOwner.toLowerCase()))
    .map((repo) => ({
      name: repo.nameWithOwner,
      description: repo.description,
      createdAt: repo.createdAt,
    }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { root: SRC, repos };
}

/** Clones `name` (owner/repo) to $SRC/<repo> and returns that path. */
export async function cloneRepo(name: string): Promise<string> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(name)) throw new Error(`${name} isn't a GitHub owner/repo`);
  const path = join(SRC, name.split("/")[1]);
  if (existsSync(path)) throw new Error(`${path} already exists`);
  await output("gh", ["repo", "clone", name, path], SRC);
  return path;
}

/** Repos under `dir`, searched the way workwork --all does. */
function findRepos(dir: string, depth: number): string[] {
  if (existsSync(join(dir, ".git"))) return [dir];
  if (depth === 0) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules",
    )
    .flatMap((entry) => findRepos(join(dir, entry.name), depth - 1));
}

/** owner/repo of the GitHub origin, lowercased; empty when there is none. */
async function originName(repo: string): Promise<string> {
  const url = await output("git", ["remote", "get-url", "origin"], repo).catch(() => "");
  return /github\.com[:/](.+?)(?:\.git)?\/?$/.exec(url.trim())?.[1].toLowerCase() ?? "";
}

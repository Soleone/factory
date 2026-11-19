import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { output } from "./state.ts";

/** Where workwork --all looks for repos, with the same fallback. */
const sourceRoot = () => resolve(process.env.SRC ?? process.cwd());

/** Local repos are available as filters even when workwork finds no candidates in them. */
export function localRepos(): string[] {
  const root = sourceRoot();
  return existsSync(root) ? findRepos(root, 4) : [];
}

export type GithubRepo = { name: string; description: string; createdAt: string };

/**
 * The GitHub user's own repos (not forked or archived) that aren't cloned anywhere under $SRC
 * yet, newest first.
 */
export async function clonableRepos(): Promise<{ root: string; repos: GithubRepo[] }> {
  const root = sourceRoot();
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
      root,
    ),
  );
  const cloned = new Set(await Promise.all(localRepos().map(originName)));
  const repos = listed
    .filter((repo) => !cloned.has(repo.nameWithOwner.toLowerCase()))
    .map((repo) => ({
      name: repo.nameWithOwner,
      description: repo.description,
      createdAt: repo.createdAt,
    }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { root, repos };
}

/** Clones `name` (owner/repo) to $SRC/<repo> and returns that path. */
export async function cloneRepo(name: string): Promise<string> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(name)) throw new Error(`${name} isn't a GitHub owner/repo`);
  const root = sourceRoot();
  const path = join(root, name.split("/")[1]);
  if (existsSync(path)) throw new Error(`${path} already exists`);
  await output("gh", ["repo", "clone", name, path], root);
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

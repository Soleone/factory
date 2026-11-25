import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { output } from "./state.ts";

/** Where workwork --all looks for repos, with the same fallback. */
export const sourceRoot = () => resolve(process.env.SRC ?? process.cwd());

/** Local repos are available as filters even when workwork finds no candidates in them. */
export function localRepos(): string[] {
  const root = sourceRoot();
  return existsSync(root) ? findRepos(root, 4, skipped()) : [];
}

/** Folder names workwork --all doesn't search: node_modules and those in its config's skip file. */
function skipped(): Set<string> {
  const config = process.env.DATA
    ? join(process.env.DATA, "apps", "workwork")
    : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "workwork");
  const file = join(config, "skip");
  const names = existsSync(file) ? readFileSync(file, "utf8").split("\n") : [];
  return new Set(["node_modules", ...names.map((name) => name.trim()).filter(Boolean)]);
}

export type GithubRepo = { name: string; description: string; createdAt: string };

/** The GitHub user's own repos, not forked or archived. */
async function githubRepos(): Promise<GithubRepo[]> {
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
      sourceRoot(),
    ),
  );
  return listed.map((repo) => ({
    name: repo.nameWithOwner,
    description: repo.description,
    createdAt: repo.createdAt,
  }));
}

/** The repos under $SRC whose origin is one of the user's own: the ones workwork --all works in. */
export async function ownedRepos(): Promise<string[]> {
  const owned = new Set((await githubRepos()).map((repo) => repo.name.toLowerCase()));
  const local = localRepos();
  const origins = await Promise.all(local.map(originName));
  return local.filter((_, index) => owned.has(origins[index]));
}

/**
 * The GitHub user's own repos (not forked or archived) that aren't cloned anywhere under $SRC
 * yet, newest first.
 */
export async function clonableRepos(): Promise<{ root: string; repos: GithubRepo[] }> {
  const cloned = new Set(await Promise.all(localRepos().map(originName)));
  const repos = (await githubRepos())
    .filter((repo) => !cloned.has(repo.name.toLowerCase()))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { root: sourceRoot(), repos };
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

/**
 * A new project: $SRC/<name> with a first commit, pushed to a new private GitHub repo of the same
 * name, since a goal's integration branch lives on origin. Returns its path.
 */
export async function createRepo(name: string): Promise<string> {
  if (!/^[\w.-]+$/.test(name)) throw new Error(`${name} isn't a repo name: letters, digits, . _ -`);
  const path = join(sourceRoot(), name);
  if (existsSync(path)) throw new Error(`${path} already exists`);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "README.md"), `# ${name}\n`);
  await output("git", ["init", "-b", "main"], path);
  await output("git", ["add", "README.md"], path);
  await output("git", ["commit", "-m", "init"], path);
  await output("gh", ["repo", "create", name, "--private", "--source", ".", "--push"], path);
  return path;
}

/** Repos under `dir`, searched the way workwork --all does. */
function findRepos(dir: string, depth: number, skip: Set<string>): string[] {
  if (existsSync(join(dir, ".git"))) return [dir];
  if (depth === 0) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && !skip.has(entry.name))
    .flatMap((entry) => findRepos(join(dir, entry.name), depth - 1, skip));
}

/** owner/repo of the GitHub origin, lowercased; empty when there is none. */
async function originName(repo: string): Promise<string> {
  const url = await output("git", ["remote", "get-url", "origin"], repo).catch(() => "");
  return /github\.com[:/](.+?)(?:\.git)?\/?$/.exec(url.trim())?.[1].toLowerCase() ?? "";
}

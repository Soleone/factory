import { execFile } from "node:child_process";
import { existsSync, openSync, closeSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { AGENT_NAMES } from "./agents.ts";
import type { Candidates, Item, Settings } from "./types.ts";

export const STATE = process.env.DATA
  ? join(process.env.DATA, "apps", "factory")
  : join(homedir(), ".local", "share", "factory");

export const pidPath = (state: string) => join(state, "factory.pid");

export function runningPid(state: string): number | undefined {
  if (!existsSync(pidPath(state))) return undefined;
  const pid = Number(readFileSync(pidPath(state), "utf8"));
  return alive(pid) ? pid : undefined;
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

export const LEVELS = ["auto", "skim", "decide"];

const DEFAULTS: Settings = {
  agents: { claude: {}, pi: {} },
  chat: { agent: "pi" },
  limit: 1,
  timeout: 60,
  auto: { on: false, levels: LEVELS, plays: [], repos: [] },
};

const settingsPath = (state: string) => join(state, "settings.json");

export function readSettings(state: string): Settings {
  if (!existsSync(settingsPath(state))) return DEFAULTS;
  return checkSettings(JSON.parse(readFileSync(settingsPath(state), "utf8")));
}

export function writeSettings(state: string, settings: Settings): void {
  writeFileSync(settingsPath(state), `${JSON.stringify(checkSettings(settings), null, 2)}\n`);
}

/** Settings come from a file people edit and from the page, so they are checked on the way in. */
export function checkSettings(raw: Partial<Settings>): Settings {
  const settings = { ...DEFAULTS, ...raw, auto: { ...DEFAULTS.auto, ...raw.auto } };
  for (const name of Object.keys(settings.agents))
    if (!AGENT_NAMES.includes(name))
      throw new Error(`unknown agent ${name} (known: ${AGENT_NAMES.join(", ")})`);
  if (!AGENT_NAMES.includes(settings.chat.agent))
    throw new Error(`unknown chat agent ${settings.chat.agent} (known: ${AGENT_NAMES.join(", ")})`);
  if (Object.keys(settings.agents).length === 0)
    throw new Error("settings need at least one agent");
  if (settings.limit !== null && !(Number.isInteger(settings.limit) && settings.limit > 0))
    throw new Error(`limit wants a whole number above 0 or null, got ${settings.limit}`);
  if (settings.until !== undefined && !/^\d{1,2}:\d{2}$/.test(settings.until))
    throw new Error(`until wants HH:MM, got ${settings.until}`);
  if (!(Number.isInteger(settings.timeout) && settings.timeout > 0))
    throw new Error(`timeout wants whole minutes above 0, got ${settings.timeout}`);
  for (const level of settings.auto.levels)
    if (!LEVELS.includes(level)) throw new Error(`unknown level ${level}`);
  return settings;
}

export const itemKey = (item: Pick<Item, "repo" | "id">) => `${item.repo} ${item.id}`;

const candidatesPath = (state: string) => join(state, "candidates.json");
const refreshLock = (state: string) => join(state, "candidates.lock");

export function readCandidates(state: string): Candidates | undefined {
  if (!existsSync(candidatesPath(state))) return undefined;
  return JSON.parse(readFileSync(candidatesPath(state), "utf8"));
}

export function refreshingCandidates(state: string): boolean {
  if (!existsSync(refreshLock(state))) return false;
  return alive(Number(readFileSync(refreshLock(state), "utf8")));
}

/** Asks workwork again, unless some process (the factory or serve) already is. */
export async function refreshCandidates(state: string, workwork: string): Promise<void> {
  if (refreshingCandidates(state)) return;
  rmSync(refreshLock(state), { force: true });
  try {
    closeSync(openSync(refreshLock(state), "wx"));
  } catch (error) {
    // Another process took the lock between the check and here.
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
    throw error;
  }
  writeFileSync(refreshLock(state), `${process.pid}\n`);
  try {
    const items: Item[] = JSON.parse(await output(workwork, ["--all", "--json"], process.cwd()));
    const candidates: Candidates = { at: new Date().toISOString(), items };
    writeFileSync(candidatesPath(state), JSON.stringify(candidates));
  } finally {
    rmSync(refreshLock(state), { force: true });
  }
}

export async function output(command: string, args: string[], cwd: string): Promise<string> {
  const { stdout, stderr } = await promisify(execFile)(command, args, {
    cwd,
    maxBuffer: 64 * 1024 * 1024,
  });
  // workwork reports failed finders here; they belong in the factory log.
  process.stderr.write(stderr);
  return stdout;
}

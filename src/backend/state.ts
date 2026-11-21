import { execFile } from "node:child_process";
import { existsSync, openSync, closeSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { AGENT_NAMES } from "./agents.ts";
import {
  presetId,
  TIERS,
  type Candidates,
  type Item,
  type Preset,
  type Settings,
} from "./types.ts";

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
  presets: [],
  limit: 1,
  idle: 10,
  tiers: { communicator: [], builder: [], grunt: [] },
  store: "local",
  capabilities: [],
  env: {},
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
export function checkSettings(raw: Partial<Settings> & { timeout?: number }): Settings {
  // timeout was a wall clock and has no match in idle minutes, so an old file's is dropped.
  const { timeout: _, ...rest } = raw;
  const settings = {
    ...DEFAULTS,
    ...rest,
    tiers: { ...DEFAULTS.tiers, ...rest.tiers },
    auto: { ...DEFAULTS.auto, ...rest.auto },
  };
  for (const name of Object.keys(settings.agents))
    if (!AGENT_NAMES.includes(name))
      throw new Error(`unknown agent ${name} (known: ${AGENT_NAMES.join(", ")})`);
  if (!AGENT_NAMES.includes(settings.chat.agent))
    throw new Error(`unknown chat agent ${settings.chat.agent} (known: ${AGENT_NAMES.join(", ")})`);
  for (const preset of settings.presets)
    if (!AGENT_NAMES.includes(preset.agent))
      throw new Error(`unknown preset agent ${preset.agent} (known: ${AGENT_NAMES.join(", ")})`);
  if (Object.keys(settings.agents).length === 0)
    throw new Error("settings need at least one agent");
  if (settings.limit !== null && !(Number.isInteger(settings.limit) && settings.limit > 0))
    throw new Error(`limit wants a whole number above 0 or null, got ${settings.limit}`);
  if (settings.until !== undefined && !/^\d{1,2}:\d{2}$/.test(settings.until))
    throw new Error(`until wants HH:MM, got ${settings.until}`);
  if (!(Number.isInteger(settings.idle) && settings.idle > 0))
    throw new Error(`idle wants whole minutes above 0, got ${settings.idle}`);
  const ids = settings.presets.map(presetId);
  if (new Set(ids).size !== ids.length)
    throw new Error(`presets need distinct ids, got ${ids.join(", ")}`);
  for (const [tier, list] of Object.entries(settings.tiers)) {
    if (!(TIERS as readonly string[]).includes(tier))
      throw new Error(`unknown tier ${tier} (known: ${TIERS.join(", ")})`);
    for (const id of list)
      if (!ids.includes(id)) throw new Error(`tier ${tier} names no preset ${id}`);
  }
  if (settings.store !== "local" && settings.store !== "tasks")
    throw new Error(`store wants local or tasks, got ${String(settings.store)}`);
  for (const level of settings.auto.levels)
    if (!LEVELS.includes(level)) throw new Error(`unknown level ${level}`);
  return settings;
}

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

/** The account a preset's usage counts against: claude's, or pi's provider. */
export const poolOf = (preset: Preset) =>
  preset.pool ?? (preset.agent === "pi" ? (preset.model?.split("/")[0] ?? "pi") : preset.agent);

/** Haiku 5.5 costs more above 100k, the others above 272k, so each compacts below its step. */
export const compactAt = (preset: Preset) =>
  preset.compactAt ?? (/haiku/i.test(preset.model ?? "") ? 90_000 : 200_000);

/** A preset gets a worker by default once a tier lists it. */
export const workersOf = (preset: Preset, settings: Settings) =>
  preset.workers ??
  (Object.values(settings.tiers).some((list) => list.includes(presetId(preset))) ? 1 : 0);

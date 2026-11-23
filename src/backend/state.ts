import { execFile } from "node:child_process";
import { existsSync, openSync, closeSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { AGENT_NAMES } from "./agents.ts";
import {
  presetId,
  TIERS,
  USAGE_POOLS,
  type Candidates,
  type Item,
  type Preset,
  type Settings,
  upgradeItem,
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

export const ATTENTION = ["none", "skim", "decide"];

const DEFAULTS: Settings = {
  agents: { claude: {}, pi: {} },
  chat: { agent: "pi" },
  presets: [],
  limit: 1,
  reserves: {},
  idle: 10,
  tiers: { communicator: [], builder: [], grunt: [] },
  store: "local",
  capabilities: [],
  env: {},
  auto: { on: false, attention: ATTENTION, blueprints: [], repos: [] },
  triggers: { ci: true, label: "factory", reviews: true },
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
    auto: { ...DEFAULTS.auto, ...upgradeAuto(rest.auto) },
    triggers: { ...DEFAULTS.triggers, ...rest.triggers },
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
  for (const [pool, reserve] of Object.entries(settings.reserves)) {
    if (!(USAGE_POOLS as readonly string[]).includes(pool))
      throw new Error(
        `can't read ${pool}'s usage to keep a reserve (can: ${USAGE_POOLS.join(", ")})`,
      );
    if (!(Number.isInteger(reserve) && reserve >= 0 && reserve < 100))
      throw new Error(`reserve for ${pool} wants a whole percent from 0 to 99, got ${reserve}`);
  }
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
  if (settings.store === "tasks" && !settings.tasks?.home)
    throw new Error("store tasks wants tasks.home, the Tasks home to mirror goals into");
  for (const attention of settings.auto.attention)
    if (!ATTENTION.includes(attention)) throw new Error(`unknown attention ${attention}`);
  return settings;
}

type LegacyAuto = Partial<Settings["auto"]> & { levels?: string[]; plays?: string[] };

/** Before workwork 0.3 auto mode filtered on levels and plays, with auto for none. */
function upgradeAuto(auto: LegacyAuto = {}): Partial<Settings["auto"]> {
  const { levels, plays, ...rest } = auto;
  return {
    ...rest,
    ...(levels && { attention: levels.map((level) => (level === "auto" ? "none" : level)) }),
    ...(plays && { blueprints: plays }),
  };
}

const candidatesPath = (state: string) => join(state, "candidates.json");
const refreshLock = (state: string) => join(state, "candidates.lock");

export function readCandidates(state: string): Candidates | undefined {
  if (!existsSync(candidatesPath(state))) return undefined;
  const { at, items } = JSON.parse(readFileSync(candidatesPath(state), "utf8"));
  return { at, items: items.map(upgradeItem) };
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

export async function output(
  command: string,
  args: string[],
  cwd: string,
  input?: string,
): Promise<string> {
  const run = promisify(execFile)(command, args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  run.child.stdin!.end(input);
  const { stdout, stderr } = await run;
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

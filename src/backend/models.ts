import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Model } from "./types.ts";

/** Every model each agent offers, its short list first. */
export function agentModels(name: string): Promise<Model[]> {
  if (name === "pi") return piModels();
  if (name === "claude") return claudeModels();
  throw new Error(`unknown agent ${name}`);
}

type PiModel = {
  id: string;
  name: string;
  provider: string;
  reasoning: boolean;
  thinkingLevelMap?: { [level: string]: string | null };
};

const PI_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** Pi's scoped models (Ctrl+P in Pi, `enabledModels` in its settings) first, then all it knows. */
async function piModels(): Promise<Model[]> {
  const settings = join(
    process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
    "settings.json",
  );
  const scoped: string[] = existsSync(settings)
    ? (JSON.parse(readFileSync(settings, "utf8")).enabledModels ?? [])
    : [];
  const answer = await ask(
    "pi",
    ["--mode", "rpc", "--no-session", "--offline"],
    { type: "get_available_models" },
    (record) => record.type === "response" && record.command === "get_available_models",
  );
  const known: PiModel[] = answer.data.models;
  // In the scope's order. A pattern names provider/id, or else just the id; * matches anything.
  const scope = new Set(scoped.flatMap((each) => matches(known, each)));
  const rest = known.filter((model) => !scope.has(model));
  return [...scope, ...rest].map((model) => ({
    value: `${model.provider}/${model.id}`,
    label: model.name,
    efforts: piLevels(model),
    scoped: scope.has(model),
  }));
}

function matches(known: PiModel[], pattern: string): PiModel[] {
  const glob = new RegExp(
    `^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*")}$`,
    "i",
  );
  const full = known.filter((model) => glob.test(`${model.provider}/${model.id}`));
  return full.length > 0 ? full : known.filter((model) => glob.test(model.id));
}

/** Pi's own rule (pi-ai's getSupportedThinkingLevels): null rules a level out, xhigh and max must be named. */
function piLevels({ reasoning, thinkingLevelMap: map = {} }: PiModel): string[] {
  if (!reasoning) return ["off"];
  return PI_LEVELS.filter((level) =>
    map[level] === null ? false : level === "xhigh" || level === "max" ? level in map : true,
  );
}

/**
 * Claude Code's current models, as it tells a host that starts it. Its aliases (opus, sonnet, fable,
 * haiku) are the current ones; full ids like claude-opus-4-8 are older.
 */
async function claudeModels(): Promise<Model[]> {
  const answer = await ask(
    "claude",
    ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"],
    { type: "control_request", request_id: "models", request: { subtype: "initialize" } },
    (record) => record.type === "control_response",
  );
  if (answer.response.subtype !== "success") throw new Error(answer.response.error);
  const offered: {
    value: string;
    displayName: string;
    supportsEffort?: boolean;
    supportedEffortLevels?: string[];
  }[] = answer.response.response.models;
  return offered
    .filter((model) => model.value !== "default" && !model.value.startsWith("claude-"))
    .map((model) => ({
      value: model.value,
      label: model.displayName,
      efforts: model.supportsEffort ? (model.supportedEffortLevels ?? []) : [],
      scoped: true,
    }));
}

/** Starts an agent, sends it one request on stdin, and resolves with the record that answers it. */
function ask(
  command: string,
  args: string[],
  request: object,
  answers: (record: { type?: string; command?: string }) => boolean,
  // oxlint-disable-next-line typescript/no-explicit-any -- each caller reads its own agent's answer
): Promise<any> {
  const child = spawn(command, args, { cwd: homedir() });
  child.stdin.end(`${JSON.stringify(request)}\n`);
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) =>
      reject(new Error(`${command} exited with code ${code} before answering`)),
    );
    createInterface({ input: child.stdout }).on("line", (line) => {
      if (!line.startsWith("{")) return;
      const record = JSON.parse(line);
      if (!answers(record)) return;
      resolve(record);
      child.kill();
    });
  });
}

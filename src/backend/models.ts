import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { output } from "./state.ts";
import type { Model } from "./types.ts";

/** The short list each agent offers, rather than every model it knows. */
export function agentModels(name: string): Promise<Model[]> {
  if (name === "pi") return piModels();
  if (name === "claude") return claudeModels();
  throw new Error(`unknown agent ${name}`);
}

/** Pi's scoped models (Ctrl+P in Pi, `enabledModels` in its settings), or all it knows without them. */
async function piModels(): Promise<Model[]> {
  const settings = join(
    process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
    "settings.json",
  );
  const scoped: string[] = existsSync(settings)
    ? (JSON.parse(readFileSync(settings, "utf8")).enabledModels ?? [])
    : [];
  // A glob like anthropic/* isn't a model --model can take.
  const exact = scoped.filter((pattern) => !pattern.includes("*"));
  if (exact.length > 0) return exact.map((value) => ({ value, label: value }));
  // A table: provider, model, then details; the first line is the header.
  const table = await output("pi", ["--list-models", "--offline"], homedir());
  return table
    .split("\n")
    .slice(1)
    .flatMap((line) => {
      const [provider, model] = line.split(/\s+/);
      return model ? [{ value: `${provider}/${model}`, label: `${provider}/${model}` }] : [];
    });
}

/**
 * Claude Code's current models, as it tells a host that starts it. Its aliases (opus, sonnet, fable,
 * haiku) are the current ones; full ids like claude-opus-4-8 are older.
 */
function claudeModels(): Promise<Model[]> {
  const child = spawn(
    "claude",
    ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"],
    { cwd: homedir() },
  );
  child.stdin.end(
    `${JSON.stringify({ type: "control_request", request_id: "models", request: { subtype: "initialize" } })}\n`,
  );
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) =>
      reject(new Error(`claude exited with code ${code} before listing its models`)),
    );
    createInterface({ input: child.stdout }).on("line", (line) => {
      if (!line.includes('"control_response"')) return;
      const answer = JSON.parse(line).response;
      if (answer.subtype !== "success") reject(new Error(answer.error));
      const offered: { value: string; displayName: string }[] = answer.response.models;
      resolve(
        offered
          .filter((model) => model.value !== "default" && !model.value.startsWith("claude-"))
          .map((model) => ({ value: model.value, label: model.displayName })),
      );
      child.kill();
    });
  });
}

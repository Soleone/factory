import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { USAGE_POOLS } from "./types.ts";

/** A pool's 5-hour window: the percent used and when it resets, in epoch ms. */
export type Window = { used: number; resets: number };

// Neither endpoint is documented; both are what Claude Code's /usage and Codex's status bar read,
// and the shapes match @marckrenn/pi-sub-core's. The tokens are the ones claude and pi keep fresh.
const CLAUDE = "https://api.anthropic.com/api/oauth/usage";
const CODEX = "https://chatgpt.com/backend-api/wham/usage";

type CodexUsage = { rate_limit: { primary_window: { used_percent: number; reset_at: number } } };
type ClaudeUsage = { five_hour: { utilization: number; resets_at: string } | null };

const readJson = (...path: string[]) => JSON.parse(readFileSync(join(homedir(), ...path), "utf8"));
const piAuth = () => readJson(".pi", "agent", "auth.json");

const READERS: Record<(typeof USAGE_POOLS)[number], () => Promise<Window>> = {
  claude: () => claudeWindow(readJson(".claude", ".credentials.json").claudeAiOauth.accessToken),
  anthropic: () => claudeWindow(piAuth().anthropic.access),
  "openai-codex": async () => {
    const { access, accountId } = piAuth()["openai-codex"];
    const data = await get<CodexUsage>(CODEX, {
      Authorization: `Bearer ${access}`,
      "ChatGPT-Account-Id": accountId,
    });
    const window = data.rate_limit.primary_window;
    return { used: window.used_percent, resets: window.reset_at * 1000 };
  },
};

export const fiveHour = (pool: string): Promise<Window> => READERS[pool as keyof typeof READERS]();

async function claudeWindow(token: string): Promise<Window> {
  const data = await get<ClaudeUsage>(CLAUDE, {
    Authorization: `Bearer ${token}`,
    "anthropic-beta": "oauth-2025-04-20",
  });
  // No window while nothing was used in the last 5 hours.
  const window = data.five_hour ?? { utilization: 0, resets_at: "" };
  return { used: window.utilization, resets: Date.parse(window.resets_at) };
}

async function get<T>(url: string, headers: Record<string, string>): Promise<T> {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return (await response.json()) as T;
}

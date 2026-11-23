import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { USAGE_POOLS, Usage, UsageWindow } from "./types.ts";

// Neither endpoint is documented; both are what Claude Code's /usage and Codex's status bar read,
// and the shapes match @marckrenn/pi-sub-core's. The tokens are the ones claude and pi keep fresh.
const CLAUDE = "https://api.anthropic.com/api/oauth/usage";
const CODEX = "https://chatgpt.com/backend-api/wham/usage";
const MINUTE = 60_000;

type CodexWindow = { used_percent: number; reset_at: number } | null;
type CodexUsage = { rate_limit: { primary_window: CodexWindow; secondary_window: CodexWindow } };
type ClaudeWindow = { utilization: number; resets_at: string | null } | null;
type ClaudeUsage = { five_hour: ClaudeWindow; seven_day: ClaudeWindow };

const readJson = (...path: string[]) => JSON.parse(readFileSync(join(homedir(), ...path), "utf8"));
const piAuth = () => readJson(".pi", "agent", "auth.json");

const READERS: Record<(typeof USAGE_POOLS)[number], () => Promise<Usage>> = {
  claude: () => claudeUsage(readJson(".claude", ".credentials.json").claudeAiOauth.accessToken),
  anthropic: () => claudeUsage(piAuth().anthropic.access),
  "openai-codex": async () => {
    const { access, accountId } = piAuth()["openai-codex"];
    const data = await get<CodexUsage>(CODEX, {
      Authorization: `Bearer ${access}`,
      "ChatGPT-Account-Id": accountId,
    });
    const window = (w: CodexWindow): UsageWindow =>
      w ? { used: w.used_percent, resets: w.reset_at * 1000 } : { used: 0 };
    return {
      fiveHour: window(data.rate_limit.primary_window),
      sevenDay: window(data.rate_limit.secondary_window),
    };
  },
};

const usage = (pool: string): Promise<Usage> => READERS[pool as keyof typeof READERS]();
export const fiveHour = async (pool: string): Promise<UsageWindow> => (await usage(pool)).fiveHour;

async function claudeUsage(token: string): Promise<Usage> {
  const data = await get<ClaudeUsage>(CLAUDE, {
    Authorization: `Bearer ${token}`,
    "anthropic-beta": "oauth-2025-04-20",
  });
  // No window while nothing was used in it.
  const window = (w: ClaudeWindow): UsageWindow =>
    w?.resets_at ? { used: w.utilization, resets: Date.parse(w.resets_at) } : { used: 0 };
  return { fiveHour: window(data.five_hour), sevenDay: window(data.seven_day) };
}

/** The last usage read of each pool asked for, read again in the background once a minute old. */
export function usageCache() {
  const cache = new Map<string, { at: number; usage?: Usage }>();
  return (pools: string[]): Record<string, Usage> => {
    const read: Record<string, Usage> = {};
    for (const pool of pools) {
      const entry = cache.get(pool);
      if (!entry || Date.now() - entry.at > MINUTE) {
        const next = { at: Date.now(), usage: entry?.usage };
        cache.set(pool, next);
        usage(pool).then(
          (fresh) => (next.usage = fresh),
          (error: Error) => console.error(`factory: can't read ${pool}'s usage: ${error.message}`),
        );
      }
      const known = cache.get(pool)!.usage;
      if (known) read[pool] = known;
    }
    return read;
  };
}

async function get<T>(url: string, headers: Record<string, string>): Promise<T> {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return (await response.json()) as T;
}

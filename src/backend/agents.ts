import type { Outcome, Tuning } from "./types.ts";

/** A headless coding agent: how to start it (the prompt goes on stdin) and what its usage limit looks like. */
export type Agent = { name: string; command: string; args: string[]; limit: RegExp };

// Taken from the installed tools, not guessed: Claude Code 2.1 prints "You've hit your session limit ·
// resets 3pm (Europe/Berlin)" (also weekly, Opus, Sonnet, Fable, monthly spend) and older versions
// "Claude AI usage limit reached|<epoch>"; pi's openai-codex provider prints "You have hit your ChatGPT
// usage limit (plus plan). Try again in ~42 min." or the raw usage_limit_reached error.
const LIMITS: Record<string, RegExp> = {
  claude:
    /usage limit|You've hit your [\w' ]*limit|You've reached your [\w ]*limit|rate_limit_error/i,
  pi: /usage limit|usage_limit_reached|usage_not_included|rate_limit_exceeded/i,
};

export const AGENT_NAMES = Object.keys(LIMITS);

/** What each agent takes for effort: claude's --effort, pi's --thinking. */
export const EFFORTS: Record<string, string[]> = {
  claude: ["low", "medium", "high", "xhigh", "max"],
  pi: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
};

export function agent(name: string, { model, effort }: Tuning = {}): Agent {
  const pick = model ? ["--model", model] : [];
  if (name === "claude")
    return {
      name,
      command: "claude",
      args: [
        "-p",
        "--permission-mode",
        "bypassPermissions",
        "--output-format",
        "json",
        ...pick,
        ...(effort ? ["--effort", effort] : []),
      ],
      limit: LIMITS.claude,
    };
  if (name === "pi")
    return {
      name,
      command: "pi",
      args: ["-p", ...pick, ...(effort ? ["--thinking", effort] : [])],
      limit: LIMITS.pi,
    };
  throw new Error(`unknown agent ${name} (known: ${AGENT_NAMES.join(", ")})`);
}

/**
 * How the Plan chat starts an agent: Pi in RPC mode, Claude Code streaming JSON both ways (chat.ts
 * reads each). Only tools for looking and running commands; it changes the queue through the
 * factory CLI. Claude Code's are bypassed like a run's, since nobody is there to answer a prompt.
 */
export function chatAgent(
  name: string,
  { model, effort }: Tuning,
  context: string,
): { command: string; args: string[] } {
  const pick = model ? ["--model", model] : [];
  if (name === "claude")
    return {
      command: "claude",
      args: [
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--replay-user-messages",
        "--no-session-persistence",
        "--permission-mode",
        "bypassPermissions",
        "--tools",
        "Read,Bash,Grep,Glob",
        "--append-system-prompt",
        context,
        ...pick,
        ...(effort ? ["--effort", effort] : []),
      ],
    };
  if (name === "pi")
    return {
      command: "pi",
      args: [
        "--mode",
        "rpc",
        "--no-session",
        "--tools",
        "read,bash,grep,find,ls",
        "--append-system-prompt",
        context,
        ...pick,
        ...(effort ? ["--thinking", effort] : []),
      ],
    };
  throw new Error(`unknown agent ${name} (known: ${AGENT_NAMES.join(", ")})`);
}

/** Only the end of the log decides: the agent's own work earlier on may mention limits too. */
export function classify(agent: Agent, code: number, log: string): Exclude<Outcome, "timeout"> {
  const tail = log.slice(-8000);
  // claude --output-format json can report an error with exit 0.
  if (code === 0 && !/"is_error":\s*true/.test(tail)) return "done";
  return agent.limit.test(tail) ? "limited" : "failed";
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000 };

/** When a limit message says the limit resets, in epoch ms; undefined when it doesn't say. */
export function resetTime(text: string, now: number): number | undefined {
  const epoch = /limit reached\|(\d{10})|"resets_at"\s*:\s*(\d{10})/.exec(text);
  if (epoch) return Number(epoch[1] ?? epoch[2]) * 1000;
  const seconds = /"?resets_in_seconds"?\s*[:=]\s*(\d+)/.exec(text);
  if (seconds) return now + Number(seconds[1]) * 1000;
  const after = /try again in ~?(\d+)\s*(s|m|h)/i.exec(text);
  if (after) return now + Number(after[1]) * UNIT_MS[after[2].toLowerCase()];
  const clock =
    /resets (?:at )?(?:([A-Z][a-z]{2}) (\d{1,2}),? )?(\d{1,2})(?::(\d{2}))?\s*([ap]m)(?: \(([^)]+)\))?/i.exec(
      text,
    );
  if (!clock) return undefined;
  const [, month, day, hour, minute, half, zone] = clock;
  const hour24 = (Number(hour) % 12) + (half.toLowerCase() === "pm" ? 12 : 0);
  try {
    return nextWallClock(now, zone, hour24, Number(minute ?? 0), month, day);
  } catch (error) {
    // A time zone this node doesn't know: the caller falls back to its default wait.
    if (error instanceof RangeError) return undefined;
    throw error;
  }
}

/** The first instant after now when the clock in zone (default: local) shows hour:minute, on month/day if given. */
function nextWallClock(
  now: number,
  zone: string | undefined,
  hour: number,
  minute: number,
  month?: string,
  day?: string,
): number {
  const today = wallClock(now, zone);
  const monthIndex = month ? MONTHS.indexOf(month.slice(0, 3)) : today.month;
  const date = day ? Number(day) : today.day;
  for (let step = 0; step < 2; step++) {
    const target = day
      ? instant(zone, today.year + step, monthIndex, date, hour, minute)
      : instant(zone, today.year, monthIndex, date + step, hour, minute);
    if (target > now) return target;
  }
  throw new RangeError("no future reset time");
}

function instant(zone: string | undefined, ...fields: [number, number, number, number, number]) {
  const guess = Date.UTC(...fields);
  // Correct by the zone's offset twice so a DST switch between guess and answer lands right.
  const first = guess - offset(guess, zone);
  return guess - offset(first, zone);
}

function offset(time: number, zone: string | undefined): number {
  const clock = wallClock(time, zone);
  const wall = Date.UTC(clock.year, clock.month, clock.day, clock.hour, clock.minute);
  return Math.round((wall - time) / 60_000) * 60_000;
}

function wallClock(time: number, zone: string | undefined) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
    })
      .formatToParts(new Date(time))
      .map((part) => [part.type, Number(part.value)]),
  );
  return {
    year: parts.year,
    month: parts.month - 1,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
  };
}

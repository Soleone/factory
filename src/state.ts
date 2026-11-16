import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Outcome } from "./agents.ts";

export const STATE = process.env.DATA
  ? join(process.env.DATA, "apps", "factory")
  : join(homedir(), ".local", "share", "factory");

/** A workwork candidate, as `workwork --json` prints it. */
export type Item = { repo: string; label: string; id: string; play: string; level: string };

/** One finished attempt at an item. `worktree` is set when it was kept because it holds unpushed work. */
export type Entry = {
  run: string;
  id: string;
  repo: string;
  play: string;
  level: string;
  agent: string;
  start: string;
  end: string;
  outcome: Outcome;
  url?: string;
  log: string;
  worktree?: string;
  error?: string;
};

export const key = (item: { repo: string; id: string }) => `${item.repo} ${item.id}`;

export function readLedger(state: string): Entry[] {
  const path = join(state, "ledger.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export function appendLedger(state: string, entry: Entry): void {
  appendFileSync(join(state, "ledger.jsonl"), `${JSON.stringify(entry)}\n`);
}

/** What the ledger says about each item: finished for good, or which agents already failed it. */
export function replay(ledger: Entry[]): {
  finished: Set<string>;
  failedBy: Map<string, string[]>;
} {
  const finished = new Set<string>();
  const failedBy = new Map<string, string[]>();
  for (const entry of ledger) {
    if (entry.outcome === "done") finished.add(key(entry));
    if (entry.outcome !== "failed" && entry.outcome !== "timeout") continue;
    const agents = [...(failedBy.get(key(entry)) ?? []), entry.agent];
    failedBy.set(key(entry), agents);
    if (agents.length >= 2) finished.add(key(entry));
  }
  return { finished, failedBy };
}

const LEVELS = ["auto", "skim", "decide"];

/** Cheapest attention first, and within a level one item per repo in turn so no repo takes the night. */
export function order(items: Item[], levels: string[]): Item[] {
  return LEVELS.filter((level) => levels.includes(level)).flatMap((level) => {
    const byRepo = new Map<string, Item[]>();
    for (const item of items.filter((item) => item.level === level))
      byRepo.set(item.repo, [...(byRepo.get(item.repo) ?? []), item]);
    const queues = [...byRepo.values()];
    const turns: Item[] = [];
    for (let round = 0; queues.some((queue) => queue.length > round); round++)
      for (const queue of queues) if (queue[round]) turns.push(queue[round]);
    return turns;
  });
}

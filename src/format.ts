import type { Worker } from "./backend/types.ts";

export const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export function ago(iso: string): string {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}

export const minutesSince = (iso: string) => Math.round((Date.now() - Date.parse(iso)) / 60_000);

export const repoName = (path: string) => path.split("/").filter(Boolean).at(-1) ?? path;

/** workwork titles like "the whole repo" only make sense with the repo in front. */
export const itemTitle = (item: { repo: string; title: string; id: string }) =>
  `${repoName(item.repo)}: ${item.title || item.id}`;

/** Run ids are ISO times without colons: 2026-11-16T013000. */
export const runStart = (run: string) => run.replace(/T(\d\d)(\d\d)(\d\d)$/, "T$1:$2:$3Z");

type BadgeVariant = "default" | "secondary" | "destructive" | "outline" | "accent";

export const WORKER_BADGE: Record<Worker["state"], BadgeVariant> = {
  working: "default",
  idle: "secondary",
  sleeping: "outline",
  stopped: "outline",
};

/** Model and effort as one short line, e.g. "opus, high"; empty when both are the agent's default. */
export const tuning = ({ model, effort }: { model?: string; effort?: string }) =>
  [model, effort].filter(Boolean).join(", ");

/** An agent with its model and effort, e.g. "pi luna-6, max". */
export const pinName = (pin: { agent: string; model?: string; effort?: string }) =>
  [pin.agent, tuning(pin)].filter(Boolean).join(" ");

/** How the page names an agent: claude as Claude, pi as Pi. */
export const agentName = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);

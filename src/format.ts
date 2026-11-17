import type { Job, Outcome, Worker } from "./backend/types.ts";

export const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export const day = (iso: string) =>
  new Date(iso).toLocaleString([], {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

export function ago(iso: string): string {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}

export const minutes = (start: string, end: string) =>
  `${Math.max(1, Math.round((Date.parse(end) - Date.parse(start)) / 60_000))} min`;

const repoName = (path: string) => path.split("/").filter(Boolean).at(-1) ?? path;

/** workwork titles like "the whole repo" only make sense with the repo in front. */
export const itemTitle = (item: { repo: string; title: string }) =>
  `${repoName(item.repo)}: ${item.title}`;

/** Run ids are ISO times without colons: 2026-11-16T013000. */
export const runStart = (run: string) => run.replace(/T(\d\d)(\d\d)(\d\d)$/, "T$1:$2:$3Z");

type BadgeVariant = "default" | "secondary" | "destructive" | "outline";

export const OUTCOME_BADGE: Record<Outcome, BadgeVariant> = {
  done: "secondary",
  failed: "destructive",
  timeout: "destructive",
  limited: "outline",
};

export const WORKER_BADGE: Record<Worker["state"], BadgeVariant> = {
  working: "default",
  idle: "secondary",
  sleeping: "outline",
  stopped: "outline",
};

export const JOB_BADGE: Record<Job["state"], BadgeVariant> = {
  queued: "outline",
  running: "default",
  done: "secondary",
  failed: "destructive",
  removed: "outline",
};

/** Model and effort as one short line, e.g. "opus, high"; empty when both are the agent's default. */
export const tuning = ({ model, effort }: { model?: string; effort?: string }) =>
  [model, effort].filter(Boolean).join(", ");

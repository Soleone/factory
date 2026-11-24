import { basename } from "node:path";
import { inbox, type InboxItem } from "../inbox.ts";
import { prUrl, type Item, type Snapshot } from "./types.ts";

const KIND: Record<InboxItem["kind"], string> = {
  ask: "question",
  checkpoint: "approval",
  failed: "failed",
  review: "PR",
  assume: "assumption",
  unverified: "unverified",
};

/** The page's Inbox as text: the same rows, groups, order and counts, from the same snapshot. */
export function inboxText(snapshot: Pick<Snapshot, "jobs" | "prs">): string {
  const { stopped, ready } = inbox(snapshot);
  if (stopped.length + ready.length === 0)
    return "Nothing waits on you: questions, approvals and PRs to review show up here as agents get to them.";
  const group = (heading: string, items: InboxItem[]) =>
    [`${heading} (${items.length})`, ...(items.length ? items.map(row) : ["  nothing"])].join("\n");
  return [group("Work stopped until you act", stopped), group("Ready when you are", ready)].join(
    "\n\n",
  );
}

function row(item: InboxItem): string {
  const { job } = item;
  const url = prUrl(job);
  const lines = [
    `  ${KIND[item.kind].padEnd(10)} ${taskTitle(job.item)}`,
    `             job ${job.id}${url ? `  ${url}` : ""}`,
  ];
  const context = contextOf(item);
  if (context) lines.push(`             ${context}`);
  return lines.join("\n");
}

function contextOf(item: InboxItem): string | undefined {
  switch (item.kind) {
    case "ask":
      return `asks: ${item.note.text}`;
    case "checkpoint":
      return item.job.why ?? "waiting for your approval";
    case "failed":
      return item.job.attempts.at(-1)?.error?.split("\n")[0];
    case "review":
      return undefined;
    case "assume":
      return `assumed ${item.note.assumed}, asked: ${item.note.text}`;
    case "unverified":
      return `not verified: ${item.need}`;
  }
}

/**
 * The repo, then the title. A workwork id is `blueprint/target`, and its titles ("over 500 lines",
 * "the whole repo", or none) only make sense with the blueprint and target in front.
 */
export function taskTitle(item: Item): string {
  const repo = basename(item.repo);
  const prefix = `${item.blueprint}/`;
  if (!item.id.startsWith(prefix)) return `${repo}: ${item.title || item.id}`;
  const target = item.id.slice(prefix.length);
  const what = target === "." ? item.blueprint : `${item.blueprint} ${target}`;
  return `${repo}: ${item.title ? `${what}: ${item.title}` : what}`;
}

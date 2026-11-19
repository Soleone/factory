import {
  CircleCheckIcon,
  CircleDashedIcon,
  CircleHelpIcon,
  CircleIcon,
  CircleXIcon,
  GitMergeIcon,
  LoaderCircleIcon,
} from "lucide-react";
import Markdown from "markdown-to-jsx/react";
import { useEffect, useState, type ReactNode } from "react";
import { api, type Act } from "@/api";
import { dayOf, jobEntries } from "@/ActivityView";
import { prUrl, type Item, type Job, type Snapshot } from "@/backend/types.ts";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { clock, itemTitle, minutesSince } from "@/format";
import { Answer } from "@/JobNotes";
import { MARKDOWN, SCROLL } from "@/PrReview";
import { PrLine } from "@/ResultsView";

/** From `workwork --help`. */
const LEVELS: Record<string, string> = {
  auto: "a check defines correct, so a digest is enough",
  skim: "same behavior and a small diff, to skim and accept",
  decide: "changes behavior or needs your product judgment",
};

/** Where a task is in its life, from a workwork candidate to a merged PR. */
export type TaskState = Job["state"] | "candidate" | "merged";

const ICONS = {
  candidate: { Icon: CircleDashedIcon, className: "text-muted-foreground" },
  queued: { Icon: CircleIcon, className: "text-muted-foreground" },
  running: { Icon: LoaderCircleIcon, className: "animate-spin text-primary" },
  blocked: { Icon: CircleHelpIcon, className: "text-(--om-accent)" },
  done: { Icon: CircleCheckIcon, className: "text-success" },
  failed: { Icon: CircleXIcon, className: "text-destructive" },
  removed: { Icon: CircleXIcon, className: "text-muted-foreground" },
  merged: { Icon: GitMergeIcon, className: "text-success" },
};

/** The same mark for a task's state on every tab. */
export function StateIcon({ state }: { state: TaskState }) {
  const { Icon, className } = ICONS[state];
  return <Icon role="img" aria-label={state} className={`size-4 shrink-0 ${className}`} />;
}

export function taskState(job: Job | undefined, prs: Snapshot["prs"]): TaskState {
  if (!job) return "candidate";
  const url = prUrl(job);
  return url && prs[url]?.state === "MERGED" ? "merged" : job.state;
}

/**
 * A task's title, opening what it was asked to do and, once it is a job, what happened to it since.
 * The same pop-up from every tab; `actions` are the row's own buttons.
 */
export function TaskDetails({
  item,
  job,
  play,
  snapshot,
  act,
  actions,
}: {
  item: Item;
  job?: Job;
  /** What the item's play does, once workwork has said. */
  play?: string;
  snapshot: Snapshot;
  act: Act;
  actions?: ReactNode;
}) {
  return (
    <Dialog>
      <DialogTrigger
        render={
          <button
            type="button"
            className="cursor-pointer truncate text-left underline-offset-4 hover:underline"
          />
        }
      >
        {itemTitle(item)}
      </DialogTrigger>
      <DialogContent className={job ? "sm:max-w-5xl" : "sm:max-w-3xl"}>
        <DialogHeader className="mr-8">
          <div className="flex items-center gap-2">
            <StateIcon state={taskState(job, snapshot.prs)} />
            <DialogTitle>{itemTitle(item)}</DialogTitle>
          </div>
          <DialogDescription>
            {item.label} · {item.play} · {item.level}
            {LEVELS[item.level] && `: ${LEVELS[item.level]}`}
          </DialogDescription>
        </DialogHeader>
        <div className={job ? "grid gap-4 md:grid-cols-[3fr_2fr]" : undefined}>
          <div className="flex min-w-0 flex-col gap-2">
            {play && <p className="text-sm">{play}</p>}
            <Task item={item} written={job?.prompt} />
          </div>
          {job && <Story job={job} snapshot={snapshot} act={act} />}
        </div>
        {actions && <DialogFooter>{actions}</DialogFooter>}
      </DialogContent>
    </Dialog>
  );
}

/** The prompt factory wrote itself, or the one workwork writes for the candidate. */
function Task({ item, written }: { item: Item; written?: string }) {
  const [prompt, setPrompt] = useState(written);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (written) return;
    let current = true;
    api.prompt(item).then(
      (loaded) => current && setPrompt(loaded),
      (failure: Error) => current && setError(failure.message),
    );
    return () => {
      current = false;
    };
  }, [item, written]);

  if (error)
    return (
      <p role="status" className="text-destructive">
        Could not load the task: {error}
      </p>
    );
  if (prompt === undefined)
    return (
      <p role="status" className="flex items-center gap-2 text-muted-foreground">
        <Spinner /> Asking workwork…
      </p>
    );
  return (
    <div tabIndex={0} className={`${SCROLL} flex flex-col gap-2 font-sans text-sm wrap-anywhere`}>
      {/* The coding standard every prompt ends with says nothing about this task. */}
      <Markdown options={MARKDOWN}>{prompt.split("\n## Standard")[0]}</Markdown>
    </div>
  );
}

/** What needs attention now, if anything, over everything that happened, newest first. */
function Story({ job, snapshot, act }: { job: Job; snapshot: Snapshot; act: Act }) {
  const { status, prs } = snapshot;
  const worker = status?.workers.find((each) => each.job === job.id);
  const question =
    job.state === "blocked" ? job.notes.findLast((note) => note.kind === "ask") : undefined;
  const url = prUrl(job);
  const entries = jobEntries(job).sort((a, b) => b.at.localeCompare(a.at));
  const days = new Map<string, typeof entries>();
  for (const entry of entries) {
    const day = dayOf(entry.at);
    days.set(day, [...(days.get(day) ?? []), entry]);
  }

  return (
    <div className="flex min-w-0 flex-col gap-3 text-sm">
      {worker && status && (
        <Now>
          {worker.agent} working, {minutesSince(worker.since)} of {status.timeout} min
          <progress
            className="h-1.5 w-full accent-primary"
            max={status.timeout}
            value={minutesSince(worker.since)}
          />
        </Now>
      )}
      {question && <Answer job={job} question={question} act={act} />}
      {url && (
        <Now>
          <PrLine jobId={job.id} url={url} pr={prs[url]} />
        </Now>
      )}
      <div className="flex max-h-[50dvh] flex-col gap-3 overflow-auto">
        {[...days].map(([day, dayEntries]) => (
          <section key={day} className="flex flex-col gap-1.5">
            <h3 className="text-xs font-medium text-muted-foreground">{day}</h3>
            <ol className="flex flex-col gap-1.5">
              {dayEntries.map((entry) => (
                <li
                  key={`${entry.at} ${entry.text}`}
                  className="grid grid-cols-[4.5rem_1fr] gap-x-2"
                >
                  <time
                    dateTime={entry.at}
                    className="whitespace-nowrap text-muted-foreground tabular-nums"
                  >
                    {clock(entry.at)}
                  </time>
                  <span className={`wrap-anywhere ${entry.tone ?? ""}`}>{entry.text}</span>
                </li>
              ))}
            </ol>
          </section>
        ))}
      </div>
    </div>
  );
}

function Now({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-2 rounded-md border p-2">{children}</div>;
}

import {
  CircleCheckIcon,
  CircleDashedIcon,
  CircleHelpIcon,
  CircleIcon,
  CircleXIcon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestIcon,
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
import { clock, minutesSince, repoName } from "@/format";
import { AttemptFile } from "@/AttemptFile";
import { Answer, Outcome } from "@/JobNotes";
import { MARKDOWN } from "@/PrReview";
import { PrLine, TrainLine } from "@/ResultsView";

/** From `workwork --help`. */
const LEVELS: Record<string, string> = {
  auto: "a check defines correct, so a digest is enough",
  skim: "same behavior and a small diff, to skim and accept",
  decide: "changes behavior or needs your product judgment",
};

/** Where a task is in its life, from a workwork candidate to a merged PR. */
export type TaskState = Job["state"] | "candidate" | "review" | "merged" | "closed";

const STATES = {
  candidate: {
    Icon: CircleDashedIcon,
    icon: "text-muted-foreground",
    pill: "bg-muted text-muted-foreground",
  },
  queued: {
    Icon: CircleIcon,
    icon: "text-muted-foreground",
    pill: "bg-muted text-muted-foreground",
  },
  running: {
    Icon: LoaderCircleIcon,
    icon: "animate-spin text-primary",
    pill: "bg-primary/15 text-primary",
  },
  blocked: {
    Icon: CircleHelpIcon,
    icon: "text-warning",
    pill: "bg-warning text-background",
  },
  review: { Icon: GitPullRequestIcon, icon: "text-primary", pill: "bg-primary/15 text-primary" },
  done: { Icon: CircleCheckIcon, icon: "text-success", pill: "bg-success/15 text-success" },
  merged: { Icon: GitMergeIcon, icon: "text-success", pill: "bg-success/15 text-success" },
  failed: {
    Icon: CircleXIcon,
    icon: "text-destructive",
    pill: "bg-destructive/15 text-destructive",
  },
  closed: {
    Icon: GitPullRequestClosedIcon,
    icon: "text-muted-foreground",
    pill: "bg-muted text-muted-foreground",
  },
  removed: {
    Icon: CircleXIcon,
    icon: "text-muted-foreground",
    pill: "bg-muted text-muted-foreground",
  },
};

const LABELS: Partial<Record<TaskState, string>> = {
  blocked: "waiting for you",
  review: "needs review",
};

/** The same mark for a task's state on every tab. */
export function StateIcon({ state }: { state: TaskState }) {
  const { Icon, icon } = STATES[state];
  return <Icon role="img" aria-label={state} className={`size-4 shrink-0 ${icon}`} />;
}

/** The state in words, colored like its icon; `label` says more where the row knows more. */
export function StatePill({ state, label }: { state: TaskState; label?: string }) {
  return (
    <span
      className={`inline-flex h-5 items-center rounded-full px-2 text-xs font-medium whitespace-nowrap ${STATES[state].pill}`}
    >
      {label ?? LABELS[state] ?? state}
    </span>
  );
}

/** A PR not fetched yet counts as open, so a finished job reads as waiting for review. */
export function taskState(job: Job | undefined, prs: Snapshot["prs"]): TaskState {
  if (!job) return "candidate";
  const url = prUrl(job);
  if (!url || job.state !== "done") return job.state;
  const pr = prs[url]?.state;
  return pr === "MERGED" ? "merged" : pr === "CLOSED" ? "closed" : "review";
}

/** A muted repo before the title, as the same name reads in every list. */
function TaskTitle({ item }: { item: Item }) {
  return (
    <>
      <span className="font-normal text-muted-foreground">{repoName(item.repo)}:</span>{" "}
      {item.title || item.id}
    </>
  );
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
  const state = taskState(job, snapshot.prs);
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
        <TaskTitle item={item} />
      </DialogTrigger>
      <DialogContent className={job ? "sm:max-w-5xl" : "sm:max-w-3xl"}>
        <DialogHeader className="mr-8">
          <div className="flex items-start gap-3">
            <span className="mt-0.5">
              <StateIcon state={state} />
            </span>
            <div className="flex min-w-0 flex-col gap-2">
              <DialogTitle>
                <TaskTitle item={item} />
              </DialogTitle>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground">
                <StatePill state={state} />
                <DialogDescription>
                  {item.label} · {item.play} · {item.level}
                </DialogDescription>
              </div>
            </div>
          </div>
        </DialogHeader>
        {job ? (
          <div className="-mx-4 -mb-4 grid border-t md:max-h-[65dvh] md:grid-cols-[3fr_2fr]">
            <div className="flex min-w-0 flex-col gap-3 overflow-auto p-4">
              <Label>The task</Label>
              <Task item={item} jobId={job.id} />
              <About item={item} play={play} />
            </div>
            <div className="flex min-w-0 flex-col gap-3 overflow-auto bg-muted/30 p-4 md:border-l">
              <Story job={job} snapshot={snapshot} act={act} />
            </div>
          </div>
        ) : (
          <div className="flex max-h-[65dvh] flex-col gap-3 overflow-auto">
            <Task item={item} />
            <About item={item} play={play} />
          </div>
        )}
        {actions && <DialogFooter>{actions}</DialogFooter>}
      </DialogContent>
    </Dialog>
  );
}

/** The job's prompt, or the one workwork writes for the candidate. */
function Task({ item, jobId }: { item: Item; jobId?: string }) {
  const [prompt, setPrompt] = useState<string>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let current = true;
    (jobId ? api.jobPrompt(jobId) : api.prompt(item)).then(
      (loaded) => current && setPrompt(loaded),
      (failure: Error) => current && setError(failure.message),
    );
    return () => {
      current = false;
    };
  }, [item, jobId]);

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
    <div className="flex flex-col gap-2 text-sm wrap-anywhere">
      {/* The title and facts above already say what the prompt's header does, and the coding
      standard every prompt ends with says nothing about this task. */}
      <Markdown options={MARKDOWN}>
        {prompt.split("\n## Standard")[0].replace(/^# [^]*?(?=^## )/m, "")}
      </Markdown>
    </div>
  );
}

/** What needs attention now, if anything, over everything that happened, newest first. */
function Story({ job, snapshot, act }: { job: Job; snapshot: Snapshot; act: Act }) {
  const { status, prs, train } = snapshot;
  const last = job.attempts.at(-1);
  const queued = new Set(
    snapshot.jobs
      .filter((each) => each.state !== "removed" && each.item.play === "followup")
      .map((each) => each.item.title),
  );
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
    <>
      {worker && status && (
        <Now className="border-primary/40">
          <span className="flex items-center gap-2 font-medium">
            <StateIcon state="running" />
            {worker.id} working, {minutesSince(worker.since)} min
          </span>
          {worker.activity && <span>{worker.activity}</span>}
        </Now>
      )}
      {question && <Answer job={job} question={question} act={act} />}
      {last?.error && (
        <Now className="border-destructive/40 text-destructive">{last.error.split("\n")[0]}</Now>
      )}
      {url && (
        <Now className={prs[url]?.state === "MERGED" ? "border-success/40" : ""}>
          <PrLine jobId={job.id} url={url} pr={prs[url]} />
          <TrainLine car={train[job.id]} />
        </Now>
      )}
      <Outcome job={job} act={act} queued={queued} />
      <Label>Log</Label>
      <div className="flex flex-col gap-3 text-sm">
        {[...days].map(([day, dayEntries]) => (
          <section key={day} className="flex flex-col gap-1.5">
            <h4 className="text-xs text-muted-foreground">{day}</h4>
            <ol className="flex flex-col">
              {dayEntries.map((entry) => (
                <li
                  key={`${entry.at} ${entry.text}`}
                  className="group grid grid-cols-[4.5rem_0.75rem_1fr] gap-x-2"
                >
                  <time
                    dateTime={entry.at}
                    className="text-right whitespace-nowrap text-muted-foreground tabular-nums"
                  >
                    {clock(entry.at)}
                  </time>
                  {/* The rail runs from the first dot of the day to the last. */}
                  <span
                    aria-hidden
                    className={`relative flex justify-center before:absolute before:inset-y-0 before:w-px before:bg-border group-first:before:top-2 group-last:before:bottom-auto group-last:before:h-2 ${entry.tone ?? "text-muted-foreground"}`}
                  >
                    <span className="relative mt-1.5 size-2 rounded-full border-2 border-current bg-popover" />
                  </span>
                  <span className={`pb-3 wrap-anywhere ${entry.tone ?? ""}`}>
                    {entry.text}{" "}
                    {entry.ended && (
                      <AttemptFile log={entry.ended.log} agent={entry.ended.agent} kind="log" />
                    )}
                  </span>
                </li>
              ))}
            </ol>
          </section>
        ))}
      </div>
    </>
  );
}

function Now({ className, children }: { className: string; children: ReactNode }) {
  return (
    <div className={`flex flex-col gap-2 rounded-md border bg-popover p-2 text-sm ${className}`}>
      {children}
    </div>
  );
}

function Label({ children }: { children: ReactNode }) {
  return <h3 className="text-xs font-medium text-muted-foreground">{children}</h3>;
}

/** What the play and the review level mean, for whoever decides on the result. */
function About({ item, play }: { item: Item; play?: string }) {
  return (
    <p className="text-xs text-muted-foreground">
      {play && (
        <>
          <span className="font-medium text-foreground">{item.play}</span>: {play}{" "}
        </>
      )}
      {LEVELS[item.level] && (
        <>
          <span className="font-medium text-foreground">{item.level}</span>: {LEVELS[item.level]}.
        </>
      )}
    </p>
  );
}

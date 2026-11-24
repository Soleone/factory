import {
  CircleCheckIcon,
  CircleDashedIcon,
  CircleHelpIcon,
  CircleIcon,
  CircleMinusIcon,
  CircleXIcon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestIcon,
  LoaderCircleIcon,
} from "lucide-react";
import Markdown from "markdown-to-jsx/react";
import { useEffect, useState, type ReactNode } from "react";
import { api, type Act } from "@/api";
import { prUrl, type Item, type Job, type Snapshot } from "@/backend/types.ts";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { AnchoredDialogContent, TabbedDialogContent } from "@/components/variants/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { repoName } from "@/format";
import { JobDetails } from "@/JobDetails";
import { MARKDOWN } from "@/PrReview";

/** From `workwork --help`. */
export const ATTENTION: Record<string, string> = {
  none: "a check defines correct, so a digest is enough",
  skim: "same behavior and a small diff, to skim and accept",
  decide: "changes behavior or needs your product judgment",
};

/** Where a task is in its life, from a workwork candidate to a merged PR. */
export type TaskState = Job["state"] | "candidate" | "review" | "merged" | "closed" | "unchanged";

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
  // Neutral, so yellow stays for what blocks work: a question waiting for you.
  review: { Icon: GitPullRequestIcon, icon: "text-foreground", pill: "bg-muted text-foreground" },
  done: { Icon: CircleCheckIcon, icon: "text-success", pill: "bg-success/15 text-success" },
  unchanged: {
    Icon: CircleMinusIcon,
    icon: "text-muted-foreground",
    pill: "bg-muted text-muted-foreground",
  },
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
  unchanged: "no change",
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

/**
 * A PR not fetched yet counts as open, so a finished job reads as waiting for review. A done job
 * with no PR and no kept branch changed nothing; goals and their nodes merge without one, so they stay done.
 */
export function taskState(job: Job | undefined, prs: Snapshot["prs"]): TaskState {
  if (!job) return "candidate";
  if (job.state !== "done") return job.state;
  const url = prUrl(job);
  if (!url) return job.goal || job.of || job.attempts.at(-1)?.branch ? "done" : "unchanged";
  const pr = prs[url]?.state;
  return pr === "MERGED" ? "merged" : pr === "CLOSED" ? "closed" : "review";
}

/** A muted repo before the title, as the same name reads in every list; `bare` where the repo goes without saying. */
function TaskTitle({ item, bare }: { item: Item; bare?: boolean }) {
  return (
    <>
      {!bare && <span className="font-normal text-muted-foreground">{repoName(item.repo)}: </span>}
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
  blueprint,
  snapshot,
  act,
  actions,
  bare,
}: {
  item: Item;
  job?: Job;
  /** Without the repo, as inside a goal, where every node shares it. */
  bare?: boolean;
  /** What the item's blueprint does, once workwork has said. */
  blueprint?: string;
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
        <TaskTitle item={item} bare={bare} />
      </DialogTrigger>
      {job ? (
        // A fixed height, so switching tabs doesn't make the dialog jump.
        <TabbedDialogContent className="h-[min(48rem,calc(100dvh-8rem))] sm:max-w-5xl">
          <JobDetails
            item={item}
            job={job}
            blueprint={blueprint}
            snapshot={snapshot}
            act={act}
            actions={actions}
          />
        </TabbedDialogContent>
      ) : (
        <AnchoredDialogContent className="sm:max-w-3xl">
          <TaskHeader item={item} state="candidate" />
          <div className="flex max-h-[65dvh] flex-col gap-3 overflow-auto">
            <Task item={item} />
            <About item={item} blueprint={blueprint} />
          </div>
          {actions && <DialogFooter>{actions}</DialogFooter>}
        </AnchoredDialogContent>
      )}
    </Dialog>
  );
}

/** The state, title and what kind of task it is; `children` go at the end of the facts line. */
export function TaskHeader({
  item,
  state,
  children,
}: {
  item: Item;
  state: TaskState;
  children?: ReactNode;
}) {
  return (
    <DialogHeader className="mr-8">
      <div className="flex items-start gap-3">
        <span className="mt-0.5">
          <StateIcon state={state} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <DialogTitle>
            <TaskTitle item={item} />
          </DialogTitle>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground">
            <StatePill state={state} />
            <DialogDescription>
              {item.label} · {item.blueprint} · {item.attention}
            </DialogDescription>
            {children}
          </div>
        </div>
      </div>
    </DialogHeader>
  );
}

/** The job's prompt, or the one workwork writes for the candidate. */
export function Task({ item, jobId }: { item: Item; jobId?: string }) {
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
        {prompt.split("\n## Standard")[0].replace(/^# workwork[^]*?(?=^## )/m, "")}
      </Markdown>
    </div>
  );
}

/** Answers the assumption at index among the job's notes. */
export function AssumeAnswer({ job, index, act }: { job: Job; index: number; act: Act }) {
  const [text, setText] = useState("");
  return (
    <form
      className="flex gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void act(() => api.answer(job.id, text, index));
      }}
    >
      <Input
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder="Your answer"
      />
      <Button type="submit" size="sm" variant="outline" disabled={!text.trim()}>
        Answer
      </Button>
    </form>
  );
}

/** What the blueprint and the review attention mean, for whoever decides on the result. */
export function About({ item, blueprint }: { item: Item; blueprint?: string }) {
  return (
    <p className="text-xs text-muted-foreground">
      {blueprint && (
        <>
          <span className="font-medium text-foreground">{item.blueprint}</span>: {blueprint}{" "}
        </>
      )}
      {ATTENTION[item.attention] && (
        <>
          <span className="font-medium text-foreground">{item.attention}</span>:{" "}
          {ATTENTION[item.attention]}.
        </>
      )}
    </p>
  );
}

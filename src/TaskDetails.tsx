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
import { dayOf, EntryMark, jobEntries, StepNumber } from "@/ActivityView";
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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { clock, minutesSince, repoName } from "@/format";
import { AttemptFile } from "@/AttemptFile";
import { Answer, Outcome } from "@/JobNotes";
import { MARKDOWN } from "@/PrReview";
import { PrLine, TrainLine } from "@/ResultsView";

/** From `workwork --help`. */
const ATTENTION: Record<string, string> = {
  none: "a check defines correct, so a digest is enough",
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
        <TaskTitle item={item} bare={bare} />
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
                  {item.label} · {item.blueprint} · {item.attention}
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
              <About item={item} blueprint={blueprint} />
            </div>
            <div className="flex min-w-0 flex-col gap-3 overflow-auto bg-muted/30 p-4 md:border-l">
              <Story job={job} snapshot={snapshot} act={act} />
            </div>
          </div>
        ) : (
          <div className="flex max-h-[65dvh] flex-col gap-3 overflow-auto">
            <Task item={item} />
            <About item={item} blueprint={blueprint} />
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
        {prompt.split("\n## Standard")[0].replace(/^# workwork[^]*?(?=^## )/m, "")}
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
      .filter((each) => each.state !== "removed" && each.item.blueprint === "followup")
      .map((each) => each.item.title),
  );
  const worker = status?.workers.find((each) => each.job === job.id);
  const step = job.notes.findLast(
    (note) => note.kind === "step" && note.attempt === job.attempts.length + 1,
  );
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
          {step && (
            <span>
              {step.text}
              {step.of ? ` (${step.done ?? 0}/${step.of})` : ""}
            </span>
          )}
          <span className="text-muted-foreground">
            {[worker.activity, worker.context && `${Math.round(worker.context / 1000)}k context`]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </Now>
      )}
      <Facts job={job} act={act} />
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
                  className="group grid grid-cols-[4.5rem_1rem_1fr] gap-x-2"
                >
                  <time
                    dateTime={entry.at}
                    className="text-right whitespace-nowrap text-muted-foreground tabular-nums"
                  >
                    {clock(entry.at)}
                  </time>
                  {/* The rail runs from under each mark to the next one, and stops at the day's last. */}
                  <span className="relative flex justify-center pt-0.5 before:absolute before:top-5.5 before:bottom-0.5 before:w-px before:bg-border group-last:before:hidden">
                    <EntryMark entry={entry} />
                  </span>
                  <span className={`pb-3 wrap-anywhere ${entry.tone ?? ""}`}>
                    {entry.step && <StepNumber step={entry.step} />}
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

/** What the job is held to and what's left for the user to check, for jobs that have any. */
function Facts({ job, act }: { job: Job; act: Act }) {
  const assumed = job.notes.flatMap((note, index) =>
    note.kind === "assume" &&
    !job.notes.some((other) => other.kind === "answer" && other.re === index)
      ? [note]
      : [],
  );
  const facts = [
    job.tier && `tier ${job.tier}${job.escalations ? `, moved up ${job.escalations}×` : ""}`,
    job.gates.length > 0 && `gates ${job.gates.map((gate) => `\`${gate}\``).join(", ")}`,
    job.touches && `touches ${job.touches.length ? job.touches.join(", ") : "anything"}`,
    job.needs.length > 0 && `needs ${job.needs.join(", ")}`,
  ].filter(Boolean);
  if (facts.length === 0 && job.unverified.length === 0 && assumed.length === 0) return null;
  return (
    <div className="flex flex-col gap-2 text-sm">
      {facts.length > 0 && <p className="text-xs text-muted-foreground">{facts.join(" · ")}</p>}
      {job.unverified.map((need) => (
        <Now key={need} className="border-warning/40">
          <span className="flex flex-wrap items-center gap-2">
            <span className="flex-1">Not verified: {need}</span>
            <Button size="sm" variant="outline" onClick={() => act(() => api.verify(job.id, need))}>
              Checked
            </Button>
          </span>
        </Now>
      ))}
      {assumed.map((note) => (
        <Now key={note.at} className="border-warning/40">
          <span>
            Assumed <strong>{note.assumed}</strong>, asked: {note.text}
          </span>
          <span className="flex gap-2">
            <Button size="sm" onClick={() => act(() => api.answer(job.id, "fine"))}>
              Fine
            </Button>
            <span className="text-xs text-muted-foreground">or answer below to queue a change</span>
          </span>
          <AssumeAnswer job={job} act={act} />
        </Now>
      ))}
    </div>
  );
}

function AssumeAnswer({ job, act }: { job: Job; act: Act }) {
  const [text, setText] = useState("");
  return (
    <form
      className="flex gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void act(() => api.answer(job.id, text));
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

/** What the blueprint and the review attention mean, for whoever decides on the result. */
function About({ item, blueprint }: { item: Item; blueprint?: string }) {
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

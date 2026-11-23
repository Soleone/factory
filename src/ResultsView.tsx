import {
  ChevronDownIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleIcon,
  CircleXIcon,
  GitPullRequestIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { api, type Act } from "@/api";
import { dayOf } from "@/ActivityView";
import { PrReview } from "@/PrReview";
import {
  canMerge,
  canRebase,
  itemKey,
  onTrain,
  prUrl,
  type Attempt,
  type Job,
  type Pr,
  type Snapshot,
  type TrainCar,
} from "@/backend/types.ts";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { NeutralCheckbox } from "@/components/variants/checkbox";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { ItemGroup } from "@/components/ui/item";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/soleone/tooltip/tooltip";
import { agentName, clock, itemTitle } from "@/format";
import { Answer } from "@/JobNotes";
import { Row } from "@/Row";
import { ATTENTION, StatePill, TaskDetails, taskState, type TaskState } from "@/TaskDetails";

type Prs = Snapshot["prs"];

const CHECKS = {
  passing: { label: "checks passing", Icon: CircleCheckIcon, className: "text-success" },
  failing: { label: "checks failing", Icon: CircleXIcon, className: "text-destructive" },
  pending: { label: "checks running", Icon: CircleDashedIcon, className: undefined },
  none: { label: "no checks", Icon: CircleIcon, className: undefined },
};

function canDismiss(job: Job) {
  return job.state === "done" || job.state === "failed" || job.state === "blocked";
}

const hasBranch = (job: Job) => job.attempts.some((attempt) => attempt.branch);

/** What waits on the user is in the Inbox; here everything is history, running or finished. */
function sectionOf(state: TaskState) {
  return state === "queued" || state === "running" || state === "blocked" ? "running" : "finished";
}

const SEEN = "factory.results.seen";

/** When the user last looked at the results, in this browser; empty the first time. */
function useLastSeen(): string {
  const [seen] = useState(() => {
    try {
      return localStorage.getItem(SEEN) ?? "";
    } catch {
      return "";
    }
  });
  useEffect(() => {
    const save = () => {
      try {
        localStorage.setItem(SEEN, new Date().toISOString());
      } catch {
        // Private windows may refuse storage; every result then just looks seen.
      }
    };
    save();
    return save;
  }, []);
  return seen;
}

/** What the train can try: it waits for running checks and rebases conflicts, but can't fix the rest. */
export function canBoard(job: Job, prs: Prs, train: Snapshot["train"]) {
  const url = prUrl(job);
  const pr = url ? prs[url] : undefined;
  return (
    pr?.state === "OPEN" &&
    !pr.draft &&
    pr.checks !== "failing" &&
    !(pr.conflicts && pr.fork) &&
    !onTrain(train[job.id])
  );
}

function dayLabel(iso: string) {
  const day = new Date(iso).toDateString();
  if (day === new Date().toDateString()) return "Today";
  if (day === new Date(Date.now() - 86_400_000).toDateString()) return "Yesterday";
  return dayOf(iso);
}

const lastEnd = (job: Job) => job.attempts.at(-1)!.end;

/** Running results, then finished ones, each by day. */
export function ResultsView({
  snapshot,
  act,
  onAsk,
}: {
  snapshot: Snapshot;
  act: Act;
  onAsk: (question: string) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [dismissing, setDismissing] = useState(false);
  const seen = useLastSeen();
  const { prs, train } = snapshot;
  const jobs = snapshot.jobs
    .filter((job) => job.state !== "removed" && job.attempts.length > 0)
    .sort((a, b) => b.attempts.at(-1)!.start.localeCompare(a.attempts.at(-1)!.start));
  const [finishedOpen, setFinishedOpen] = useState(true);
  if (jobs.length === 0)
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>Nothing done yet</EmptyTitle>
          <EmptyDescription>
            What the agents did shows up here, with their PRs to review and merge.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );

  const sections = { running: [] as Job[], finished: [] as Job[] };
  for (const job of jobs) sections[sectionOf(taskState(job, prs))].push(job);
  const selection = jobs.filter((job) => canDismiss(job) && selected.has(job.id));
  const boarding = selection.filter((job) => canBoard(job, prs, train));

  const select = (ids: string[], checked: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      for (const id of ids) {
        if (checked) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  };

  const dismissSelected = async () => {
    if (
      selection.some(hasBranch) &&
      !window.confirm("Dismiss selected results and delete their unpushed branches?")
    )
      return;

    setDismissing(true);
    try {
      await act(async () => {
        const outcomes = await Promise.allSettled(selection.map((job) => api.remove(job.id)));
        const failure = outcomes.find((outcome) => outcome.status === "rejected");
        if (failure) throw failure.reason;
      });
      setSelected(new Set());
    } finally {
      setDismissing(false);
    }
  };

  const merge = (merging: Job[]) => {
    if (mergeTrain(merging, act)) setSelected(new Set());
  };

  const list = (shown: Job[]) => {
    const days = new Map<string, Job[]>();
    for (const job of shown) {
      const day = dayLabel(lastEnd(job));
      days.set(day, [...(days.get(day) ?? []), job]);
    }
    return [...days].map(([day, dayJobs]) => (
      <div key={day} className="flex flex-col gap-2">
        <h3 className="px-3 text-xs text-muted-foreground">{day}</h3>
        <ItemGroup>
          {dayJobs.map((job) => (
            <Result
              key={job.id}
              job={job}
              snapshot={snapshot}
              act={act}
              car={train[job.id]}
              onAsk={onAsk}
              asked={snapshot.settings.chat.agent}
              unread={seen !== "" && lastEnd(job) > seen}
              reviewer={reviewerOf(job, snapshot)}
              disabled={dismissing && selected.has(job.id)}
              leading={
                canDismiss(job) && (
                  <NeutralCheckbox
                    aria-label={`Select ${itemTitle(job.item)}`}
                    checked={selected.has(job.id)}
                    disabled={dismissing}
                    onCheckedChange={(checked) => select([job.id], checked)}
                  />
                )
              }
            />
          ))}
        </ItemGroup>
      </div>
    ));
  };

  /** A section's title with a checkbox that selects all of its dismissible results. */
  const heading = (title: string, shown: Job[]) => {
    const ids = shown.filter(canDismiss).map((job) => job.id);
    const all = ids.length > 0 && ids.every((id) => selected.has(id));
    return (
      <span className="flex items-center gap-3">
        {ids.length > 0 && (
          <NeutralCheckbox
            aria-label={all ? `Clear ${title}` : `Select all in ${title}`}
            checked={all}
            disabled={dismissing}
            onCheckedChange={(checked) => select(ids, checked)}
          />
        )}
        <h2 className="text-sm font-medium">
          {title} <span className="font-normal text-muted-foreground">{shown.length}</span>
        </h2>
      </span>
    );
  };

  return (
    <div className="flex flex-col gap-6 pt-2">
      {selection.length > 0 && (
        <div
          role="group"
          aria-label="Batch actions"
          className="sticky top-0 z-10 flex flex-wrap items-center gap-2 rounded-lg border bg-background px-3 py-2"
        >
          <span className="text-sm font-medium">{selection.length} selected</span>
          <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
            Clear
          </Button>
          <div className="flex items-center gap-2 sm:ml-auto">
            <Button variant="outline" size="sm" disabled={dismissing} onClick={dismissSelected}>
              {dismissing ? "Dismissing…" : "Dismiss"}
            </Button>
            {boarding.length > 0 && (
              <MergeButton disabled={dismissing} onClick={() => merge(boarding)}>
                Merge {boarding.length < selection.length && `(${boarding.length})`}
              </MergeButton>
            )}
          </div>
        </div>
      )}
      {sections.running.length > 0 && (
        <section className="flex flex-col gap-3">
          <div className="flex min-h-8 items-center px-3">
            {heading("In progress", sections.running)}
          </div>
          {list(sections.running)}
        </section>
      )}
      {sections.finished.length > 0 && (
        <Collapsible open={finishedOpen} onOpenChange={setFinishedOpen}>
          <section className="flex flex-col gap-3">
            <div className="flex min-h-8 items-center gap-2 px-3">
              {heading("Finished", sections.finished)}
              <CollapsibleTrigger
                render={<Button variant="ghost" size="icon-sm" />}
                aria-label={finishedOpen ? "Hide finished" : "Show finished"}
              >
                <ChevronDownIcon
                  aria-hidden="true"
                  className={`transition-transform ${finishedOpen ? "" : "-rotate-90"}`}
                />
              </CollapsibleTrigger>
            </div>
            <CollapsibleContent>
              <div className="flex flex-col gap-3">{list(sections.finished)}</div>
            </CollapsibleContent>
          </section>
        </Collapsible>
      )}
    </div>
  );
}

/** Puts PRs on the merge train after the user agrees; says whether they did. */
export function mergeTrain(merging: Job[], act: Act) {
  const count = merging.length === 1 ? "1 PR" : `${merging.length} PRs`;
  if (
    !window.confirm(
      `Merge ${count} one after another? Conflicting ones get rebased; ones that still conflict are skipped.`,
    )
  )
    return false;
  void act(() => api.mergeTrain(merging.map((job) => job.id)));
  return true;
}

/** Another agent to review the job's PR, unless it is a review or has one already. */
export function reviewerOf(job: Job, snapshot: Snapshot) {
  if (job.item.blueprint === "review") return undefined;
  const reviewed = snapshot.jobs.some(
    (other) =>
      other.state !== "removed" &&
      other.item.blueprint === "review" &&
      itemKey(other.item) === itemKey(job.item),
  );
  if (reviewed) return undefined;
  return Object.keys(snapshot.settings.agents).find((agent) => agent !== job.agent);
}

export function MergeButton({
  className,
  disabled,
  onClick,
  children,
}: {
  className?: string;
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      {/* A disabled button ignores the pointer, so the wrapper shows the hint. */}
      <TooltipTrigger render={<span className={className} />}>
        <Button variant="outline" size="sm" disabled={disabled} onClick={onClick}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>Merges one after another per repo, smallest first</TooltipContent>
    </Tooltip>
  );
}

export function Result({
  job,
  snapshot,
  act,
  car,
  onAsk,
  asked,
  unread,
  reviewer,
  disabled: dismissing,
  leading,
  holding,
}: {
  job: Job;
  snapshot: Snapshot;
  act: Act;
  car?: TrainCar;
  onAsk: (question: string) => void;
  /** The agent the Plan chat talks to. */
  asked: string;
  /** It ended since the user last looked. */
  unread: boolean;
  /** Another agent to review its PR, unless it has a review already. */
  reviewer?: string;
  disabled: boolean;
  /** A checkbox to select it, or an icon for what it waits on. */
  leading: ReactNode;
  /** Unfinished jobs that wait for this one. */
  holding?: number;
}) {
  const [pending, setPending] = useState<"merge" | "rebase" | "close">();
  const last = job.attempts.at(-1)!;
  const url = prUrl(job);
  const pr = url ? snapshot.prs[url] : undefined;
  const state = taskState(job, snapshot.prs);
  const open = pr?.state === "OPEN";
  const disabled = dismissing || pending !== undefined || onTrain(car);
  const primary = pr && (canRebase(pr) ? "rebase" : canMerge(pr) ? "merge" : undefined);
  const question =
    car?.step === "skipped"
      ? `The merge train skipped ${url}, "${itemTitle(job.item)}": ${car.reason}. Why, and what should I do about it?`
      : job.state === "failed"
        ? `Job ${job.id}, "${itemTitle(job.item)}" (workwork ${job.item.id} in ${job.item.repo}), failed${last.error ? `: ${last.error}` : ""}. Its log is ${last.log}. Why did it fail, and should I retry it, pin another agent, or drop it?`
        : undefined;

  async function changePr(action: NonNullable<typeof pending>) {
    setPending(action);
    try {
      await act(() => api[action](job.id));
    } finally {
      setPending(undefined);
    }
  }

  const pendingLabel = { merge: "Merging…", rebase: "Rebasing…", close: "Closing…" };
  const primaryButton = primary && (
    <Button variant="outline" size="sm" disabled={disabled} onClick={() => changePr(primary)}>
      {pending ? pendingLabel[pending] : primary === "rebase" ? "Rebase" : "Merge"}
    </Button>
  );
  const retry = job.state === "failed" && (
    <Button
      variant="outline"
      size="sm"
      disabled={disabled}
      onClick={() => act(() => api.retry(job.id))}
    >
      Retry
    </Button>
  );
  const dismiss = () => {
    if (hasBranch(job) && !window.confirm("Dismiss this result and delete its unpushed branch?"))
      return;
    void act(() => api.remove(job.id));
  };
  const ask =
    job.state === "blocked" ? job.notes.findLast((note) => note.kind === "ask") : undefined;

  return (
    <Row
      leading={
        <>
          {/* A bar along the row's left edge marks what ended since the last visit. */}
          {unread && <span aria-hidden className="absolute inset-y-0 left-0 w-1 bg-foreground" />}
          {leading || <span className="size-4" />}
        </>
      }
      title={
        <>
          {unread && <span className="sr-only">New: </span>}
          <TaskDetails
            item={pr ? { ...job.item, title: pr.title } : job.item}
            job={job}
            snapshot={snapshot}
            act={act}
            actions={
              <>
                {canDismiss(job) && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="sm:mr-auto"
                    disabled={disabled}
                    onClick={dismiss}
                  >
                    Dismiss
                  </Button>
                )}
                {open && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={disabled}
                    onClick={() => changePr("close")}
                  >
                    {pending === "close" ? pendingLabel.close : "Close PR"}
                  </Button>
                )}
                {open && reviewer && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={disabled}
                    onClick={() => act(() => api.review(job.id, reviewer))}
                  >
                    Review with {agentName(reviewer)}
                  </Button>
                )}
                {question && (
                  <Button variant="outline" size="sm" onClick={() => onAsk(question)}>
                    Ask {agentName(asked)}
                  </Button>
                )}
                {retry}
                {primaryButton}
              </>
            }
          />
        </>
      }
      meta={
        <span className="flex min-w-0 items-center gap-2">
          <StatePill
            state={state}
            label={state === "failed" && last.outcome !== "failed" ? last.outcome : undefined}
          />
          <Facts job={job} last={last} pr={pr} url={url} car={car} />
          {holding ? (
            <span className="shrink-0 text-warning">
              holds {holding} {holding === 1 ? "job" : "jobs"}
            </span>
          ) : null}
        </span>
      }
      below={ask && <Answer job={job} question={ask} act={act} />}
    >
      {primaryButton}
      {retry}
      {canDismiss(job) && (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Dismiss ${itemTitle(job.item)}`}
                disabled={disabled}
                onClick={dismiss}
              />
            }
          >
            <XIcon aria-hidden="true" />
          </TooltipTrigger>
          <TooltipContent>
            {job.attempts.some((attempt) => attempt.branch)
              ? "Dismiss: hide from results and delete its unpushed branch"
              : "Dismiss: hide from results, its PR stays as it is"}
          </TooltipContent>
        </Tooltip>
      )}
    </Row>
  );
}

/** The one line a result needs to be triaged; everything else waits in its pop-up. */
function Facts({
  job,
  last,
  pr,
  url,
  car,
}: {
  job: Job;
  last: Attempt;
  pr?: Pr;
  url?: string;
  car?: TrainCar;
}) {
  const result = job.notes.findLast((note) => note.kind === "result");
  const checks = pr?.state === "OPEN" && pr.checks !== "none" && CHECKS[pr.checks];
  const facts: ReactNode[] = url
    ? [
        pr?.state === "OPEN" && (
          <Attention key="attention" level={pr.attention ?? job.item.attention} />
        ),
        pr && (
          <>
            <span className="text-success">+{pr.additions}</span>{" "}
            <span className="text-destructive">−{pr.deletions}</span>
          </>
        ),
        checks && (
          <span key="checks" className={checks.className}>
            {checks.label}
          </span>
        ),
        pr?.state === "OPEN" && pr.conflicts && (
          <span key="conflicts" className="text-destructive">
            conflicts
          </span>
        ),
        pr?.draft && "draft",
        car && <TrainLine key="train" car={car} />,
        <a key="pr" href={url} target="_blank" rel="noreferrer" className="hover:underline">
          #{url.split("/").at(-1)}
        </a>,
      ]
    : [job.state === "failed" && job.attempts.length > 1 && `${job.attempts.length} attempts`];
  // Free text goes last, so truncating it never hides who ran the job or when.
  const text =
    job.state === "failed"
      ? last.error && (
          <span key="error" className="text-destructive">
            {last.error.split("\n")[0]}
          </span>
        )
      : !url && job.state === "done" && (result?.text ?? "nothing to change");
  return (
    <span className="min-w-0 truncate">
      {[...facts, agentName(last.agent), clock(last.end), text]
        .filter(Boolean)
        .map((fact, index) => (
          <span key={index}>
            {index > 0 && " · "}
            {fact}
          </span>
        ))}
    </span>
  );
}

/** How much of the user's attention a PR asks for, explained on hover. */
function Attention({ level }: { level: string }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="underline decoration-dotted underline-offset-2" />}>
        {level}
      </TooltipTrigger>
      <TooltipContent>Attention: {ATTENTION[level] ?? level}</TooltipContent>
    </Tooltip>
  );
}

const TRAIN_STEP = {
  queued: "on the merge train",
  waiting: "merge train: waiting for checks",
  rebasing: "merge train: rebasing",
  merging: "merge train: merging",
  merged: undefined,
};

/** Where the merge train is with a PR, if it is on one. */
export function TrainLine({ car }: { car?: TrainCar }) {
  if (car?.step === "skipped")
    return (
      <span className="text-destructive">
        merge train skipped it: {car.reason.replaceAll("\n", " ")}
      </span>
    );
  return car && TRAIN_STEP[car.step] ? <span>{TRAIN_STEP[car.step]}</span> : null;
}

export function PrLine({ jobId, url, pr }: { jobId: string; url: string; pr?: Pr }) {
  const checks = pr?.state === "OPEN" && CHECKS[pr.checks];
  return (
    <span className="flex flex-wrap items-center gap-x-3">
      <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1">
        <GitPullRequestIcon className="size-3.5" aria-hidden="true" />
        {url.replace("https://github.com/", "")}
      </a>
      {pr ? (
        <>
          {checks && (
            <span className={`inline-flex items-center gap-1 ${checks.className ?? ""}`}>
              <checks.Icon className="size-3.5" aria-hidden="true" />
              {checks.label}
            </span>
          )}
          {pr.draft && <span>draft</span>}
          {pr.state === "OPEN" && pr.conflicts === null && <span>checking mergeability…</span>}
          {pr.state === "OPEN" && pr.conflicts && (
            <span className="text-destructive">
              {pr.fork ? "conflicts · resolve in fork" : "conflicts"}
            </span>
          )}
          <span>
            <span className="text-success">+{pr.additions}</span>{" "}
            <span className="text-destructive">−{pr.deletions}</span> in {pr.files.length}{" "}
            {pr.files.length === 1 ? "file" : "files"}
          </span>
          <PrReview jobId={jobId} url={url} pr={pr} />
        </>
      ) : (
        <span>asking GitHub…</span>
      )}
    </span>
  );
}

import {
  ChevronDownIcon,
  CodeIcon,
  EyeIcon,
  GitBranchIcon,
  GitMergeIcon,
  ImageIcon,
  ListTreeIcon,
  RotateCcwIcon,
  ScaleIcon,
  ScanSearchIcon,
  TargetIcon,
  WrenchIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { confirm } from "@/Confirm";
import { api, type Act } from "@/api";
import {
  canMerge,
  canRebase,
  conflictsJob,
  onTrain,
  prUrl,
  reviewTier,
  type Attempt,
  type Job,
  type Pr,
  type Snapshot,
  type TrainCar,
} from "@/backend/types.ts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DialogClose } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/soleone/tooltip/tooltip";
import { agentName, clock, itemTitle } from "@/format";
import { Answer } from "@/JobNotes";
import { CHECKS, TrainLine } from "@/PullRequest";
import { Thumbnails } from "@/Images";
import { Row } from "@/Row";
import { ATTENTION, StatePill, stateTone, TaskDetails, taskState } from "@/TaskDetails";
import { WorkerName } from "@/WorkerName";

const PEEK = "factory.results.peek";

/** The one result whose peek is open, remembered in this browser for coming back. */
export function usePeek() {
  const [peek, setPeek] = useState(() => {
    try {
      return localStorage.getItem(PEEK) ?? undefined;
    } catch {
      return undefined;
    }
  });
  useEffect(() => {
    try {
      if (peek) localStorage.setItem(PEEK, peek);
      else localStorage.removeItem(PEEK);
    } catch {
      // Private windows may refuse storage; the peek is then just forgotten.
    }
  }, [peek]);
  // A peek closing as another opens must not close the new one.
  return (id: string) => ({
    peeking: peek === id,
    onPeek: (open: boolean) =>
      setPeek((current) => (open ? id : current === id ? undefined : current)),
  });
}

export function canDismiss(job: Job) {
  return job.state === "done" || job.state === "failed" || job.state === "blocked";
}

/** What dismissing deletes besides the result, if anything. */
export function dismissLoses(job: Job) {
  if (job.image) return "its images";
  if (job.attempts.some((attempt) => attempt.branch)) return "its unpushed branch";
}

/** The role to review the job's PR, unless it is a review or a fix of one, or has one already. */
export function reviewerOf(job: Job, snapshot: Snapshot) {
  if (job.item.blueprint === "review" || job.branchOf) return undefined;
  if (snapshot.reviewed.includes(job.id)) return undefined;
  return reviewTier(job);
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
  peeking,
  onPeek,
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
  /** A checkbox to select it; false keeps its room on a row that can't be selected. */
  leading?: ReactNode;
  /** Unfinished jobs that wait for this one. */
  holding?: number;
  /** Its peek is the one open in the list. */
  peeking: boolean;
  onPeek: (open: boolean) => void;
}) {
  const [pending, setPending] = useState<"merge" | "rebase" | "close">();
  // A goal runs no attempt of its own, yet the Inbox lists its final PR.
  const last = job.attempts.at(-1);
  const url = prUrl(job);
  const pr = url ? snapshot.prs[url] : undefined;
  const state = taskState(job, snapshot.prs);
  const open = pr?.state === "OPEN";
  const disabled = dismissing || pending !== undefined || onTrain(car);
  const resolving = conflictsJob(job, snapshot.jobs);
  const primary =
    pr && !resolving && (canRebase(pr) ? "rebase" : canMerge(pr) ? "merge" : undefined);
  const question =
    car?.step === "skipped"
      ? `The merge train skipped ${url}, "${itemTitle(job.item)}": ${car.reason}. Why, and what should I do about it?`
      : job.state === "failed"
        ? `Job ${job.id}, "${itemTitle(job.item)}" (workwork ${job.item.id} in ${job.item.repo}), failed${last?.error ? `: ${last.error}` : ""}.${last ? ` Its log is ${last.log}.` : ""} Why did it fail, and should I retry it, pin another agent, or drop it?`
        : undefined;

  async function changePr(action: NonNullable<typeof pending>) {
    setPending(action);
    try {
      // A failure stays on the job and shows on this row, so it needs no banner.
      await act(() => api[action](job.id).catch(() => undefined));
    } finally {
      setPending(undefined);
    }
  }

  const pendingLabel = { merge: "Merging…", rebase: "Rebasing…", close: "Closing…" };
  // Filled in the details footer, where it's the one thing to do; outlined in the busy row.
  const primaryButton = (variant: "default" | "outline") => {
    if (!primary) return null;
    const label = (
      <>
        {primary === "rebase" ? (
          <GitBranchIcon data-icon="inline-start" />
        ) : (
          <GitMergeIcon data-icon="inline-start" />
        )}
        <span data-label>
          {pending ? pendingLabel[pending] : primary === "rebase" ? "Rebase" : "Merge"}
        </span>
      </>
    );
    const props = { variant, size: "sm" as const, disabled, onClick: () => changePr(primary) };
    return variant === "default" && primary === "merge" ? (
      <DialogClose disabled={disabled} render={<Button {...props} />}>
        {label}
      </DialogClose>
    ) : (
      <Button {...props}>{label}</Button>
    );
  };
  const retry = (job.state === "failed" || (job.image && job.state === "done")) && (
    <Button
      variant="outline"
      size="sm"
      disabled={disabled}
      onClick={() => act(() => api.retry(job.id))}
    >
      <RotateCcwIcon data-icon="inline-start" />
      <span data-label>{job.image ? "Regenerate" : "Retry"}</span>
    </Button>
  );
  const loses = dismissLoses(job);
  const dismiss = async () => {
    if (
      loses &&
      !(await confirm({
        title: "Dismiss this result?",
        description: `This deletes ${loses} too.`,
        action: "Dismiss",
        destructive: true,
      }))
    )
      return;
    void act(() => api.remove(job.id));
  };
  const ask =
    job.state === "blocked" ? job.notes.findLast((note) => note.kind === "ask") : undefined;
  const note = job.notes.findLast((each) => each.kind === "result")?.text;
  const brief = job.attempts.findLast((attempt) => attempt.brief)?.brief;
  const title = pr ? pr.title : job.item.title || job.item.id;
  const peek = ask ? (
    <Answer job={job} question={ask} act={act} />
  ) : job.image && job.state === "done" ? (
    <>
      <Thumbnails job={job} size="size-28" />
      {brief && <p className="text-muted-foreground">{brief}</p>}
    </>
  ) : job.state === "failed" && last?.error ? (
    <>
      <pre className="overflow-x-auto rounded-md bg-destructive/10 px-2 py-1.5 font-mono text-xs text-destructive">
        {last.error}
      </pre>
      {question && (
        <Button variant="outline" size="sm" className="self-start" onClick={() => onAsk(question)}>
          Ask {agentName(asked)} why
        </Button>
      )}
    </>
  ) : (
    note && <p>{note}</p>
  );

  return (
    <Row
      marked={unread || (job.prError && !job.prError.seen)}
      leading={
        <span className="flex items-center gap-2.5">
          {leading === false ? <span className="size-4" /> : leading}
          <KindIcon job={job} className={`size-4 ${stateTone(state)}`} />
        </span>
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
                    onClick={() => act(() => api.review(job.id))}
                  >
                    Review as {reviewer}
                  </Button>
                )}
                {question && (
                  <Button variant="outline" size="sm" onClick={() => onAsk(question)}>
                    Ask {agentName(asked)}
                  </Button>
                )}
                {retry}
                {primaryButton("default")}
              </>
            }
          />
        </>
      }
      meta={
        <span className="flex min-w-0 items-center gap-2">
          {state === "review" && open ? (
            <ReviewPill level={pr.attention ?? job.item.attention} />
          ) : (
            <StatePill
              state={state}
              label={
                state === "failed" && last && last.outcome !== "failed" ? last.outcome : undefined
              }
            />
          )}
          <Outcome
            job={job}
            last={last}
            pr={pr}
            url={url}
            car={car}
            resolving={resolving}
            act={act}
          />
          {holding ? (
            <span className="shrink-0 text-warning">
              holds {holding} {holding === 1 ? "job" : "jobs"}
            </span>
          ) : null}
        </span>
      }
    >
      {/* Every slot keeps its width on every row, so the columns line up down the list. */}
      <span className="flex w-7 justify-center">
        {peek && (
          <Peek open={peeking} onOpenChange={onPeek}>
            <p className="font-medium">{title}</p>
            {peek}
          </Peek>
        )}
      </span>
      <span className="w-32 text-sm text-muted-foreground max-sm:hidden">
        {last && <WorkerName of={{ agent: last.agent, model: last.model }} />}
      </span>
      <span className="w-16 text-right text-sm whitespace-nowrap text-muted-foreground tabular-nums max-sm:hidden">
        {last && clock(last.end)}
      </span>
      {/* On a phone the action is its icon alone, so the title keeps room. */}
      <span className="flex w-30 justify-end max-sm:w-8 max-sm:**:data-label:sr-only">
        {primaryButton("outline") || retry}
      </span>
      <span className="flex w-7 justify-center">
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
              {loses
                ? `Dismiss: hide from results and delete ${loses}`
                : "Dismiss: hide from results, its PR stays as it is"}
            </TooltipContent>
          </Tooltip>
        )}
      </span>
    </Row>
  );
}

/** What kind of work a job is, as the icon that leads its row. */
function KindIcon({ job, className }: { job: Job; className: string }) {
  const Icon = job.image
    ? ImageIcon
    : job.goal
      ? TargetIcon
      : job.item.blueprint === "review"
        ? ScanSearchIcon
        : job.branchOf
          ? WrenchIcon
          : job.of
            ? ListTreeIcon
            : CodeIcon;
  return <Icon aria-hidden="true" className={className} />;
}

/**
 * A result's extra content, a question, its images or its error, floating over the list from a
 * chevron, so the row never changes height. Left or Right closes it again, like Escape.
 */
function Peek({
  open,
  onOpenChange,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger
        data-peek
        render={
          <Button variant="ghost" size="icon-sm" aria-label={open ? "Show less" : "Show more"} />
        }
      >
        <ChevronDownIcon
          aria-hidden="true"
          className={`transition-transform ${open ? "rotate-180" : ""}`}
        />
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-[min(36rem,calc(100vw-2rem))]"
        onKeyDown={(event) => {
          const target = event.target as HTMLElement;
          if (target.closest("input, textarea")) return;
          if (event.key === "ArrowLeft" || event.key === "ArrowRight") onOpenChange(false);
        }}
      >
        <div className="flex flex-col gap-3">{children}</div>
      </PopoverContent>
    </Popover>
  );
}

/** What a result came to, in one order for every kind: the deciding fact first, free text last. */
function Outcome({
  job,
  last,
  pr,
  url,
  car,
  resolving,
  act,
}: {
  job: Job;
  last?: Attempt;
  pr?: Pr;
  url?: string;
  car?: TrainCar;
  /** The job resolving its PR's conflicts. */
  resolving?: Job;
  act: Act;
}) {
  const result = job.notes.findLast((note) => note.kind === "result");
  const ask =
    job.state === "blocked" ? job.notes.findLast((note) => note.kind === "ask") : undefined;
  const checks = pr?.state === "OPEN" && pr.checks !== "none" && CHECKS[pr.checks];
  const images = job.attempts.flatMap((attempt) => attempt.images ?? []).length;
  const facts: ReactNode[] = url
    ? [
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
        pr?.state === "OPEN" &&
          pr.conflicts &&
          (resolving ? (
            <span key="conflicts" className="text-warning">
              {resolving.state === "running"
                ? "agent resolving conflicts"
                : "conflicts: agent queued"}
            </span>
          ) : (
            <span key="conflicts" className="text-destructive">
              conflicts
            </span>
          )),
        pr?.draft && "draft",
        car && <TrainLine key="train" car={car} />,
        job.prError && <PrErrorFact key="error" job={job} url={url} act={act} />,
        <a key="pr" href={url} target="_blank" rel="noreferrer" className="hover:underline">
          #{url.split("/").at(-1)}
        </a>,
      ]
    : [job.state === "failed" && job.attempts.length > 1 && `${job.attempts.length} attempts`];
  // Free text goes last, so truncating it never hides a number.
  const text = ask
    ? `${agentName(job.agent ?? "agent")} asks: ${ask.text}`
    : job.state === "failed"
      ? last?.error && (
          <span key="error" className="text-destructive">
            {last.error.split("\n")[0]}
          </span>
        )
      : job.image
        ? job.state === "done" && `${images} ${images === 1 ? "image" : "images"}`
        : !url && job.state === "done" && (result?.text ?? "nothing to change");
  return (
    <>
      {job.image && job.state === "done" && <Thumbnails job={job} size="size-4.5" />}
      <span className="min-w-0 truncate">
        {[...facts, text].filter(Boolean).map((fact, index) => (
          <span key={index}>
            {index > 0 && " · "}
            {fact}
          </span>
        ))}
      </span>
    </>
  );
}

/**
 * A failed merge, rebase or close, among the row's facts: loud until opened, since it may have failed
 * after the user moved on, then plain red. Either opens the full message.
 */
function PrErrorFact({ job, url, act }: { job: Job; url: string; act: Act }) {
  const error = job.prError!;
  const label = `${error.action} failed`;
  return (
    <Popover onOpenChange={(open) => open && !error.seen && void act(() => api.seePrError(job.id))}>
      <PopoverTrigger
        render={
          error.seen ? (
            <button
              type="button"
              className="cursor-pointer text-destructive underline decoration-dotted underline-offset-3"
            />
          ) : (
            <Badge variant="destructive" render={<button type="button" />} />
          )
        }
      >
        {label}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(28rem,calc(100vw-2rem))]">
        <div className="flex flex-col gap-3 text-sm">
          <p className="font-medium text-destructive first-letter:uppercase">{label}</p>
          <p className="wrap-anywhere whitespace-pre-line">{error.text}</p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => act(() => api.clearPrError(job.id))}>
              Dismiss error
            </Button>
            <Button
              variant="outline"
              size="sm"
              nativeButton={false}
              render={<a href={url} target="_blank" rel="noreferrer" />}
            >
              Open on GitHub
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

const ATTENTION_LOOK: Record<string, { Icon: typeof EyeIcon; className: string }> = {
  skim: { Icon: EyeIcon, className: "bg-muted text-foreground" },
  // Outlined, so it stays apart from the filled yellow of a question waiting for you.
  decide: {
    Icon: ScaleIcon,
    className: "bg-warning/15 text-warning ring-1 ring-warning/45 ring-inset",
  },
};

/** A PR waiting for review, as how much review it needs; the reason on hover. */
function ReviewPill({ level }: { level?: string }) {
  if (!level) return <StatePill state="review" />;
  const look = ATTENTION_LOOK[level];
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <StatePill
            state="review"
            className={look?.className}
            label={
              look && (
                <>
                  <look.Icon aria-hidden="true" />
                  {level}
                </>
              )
            }
          />
        }
      />
      <TooltipContent>Attention: {ATTENTION[level] ?? level}</TooltipContent>
    </Tooltip>
  );
}

import { GitBranchIcon, GitMergeIcon, RotateCcwIcon, XIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { api, type Act } from "@/api";
import {
  canMerge,
  canRebase,
  itemKey,
  onTrain,
  prUrl,
  reviewTier,
  type Attempt,
  type Job,
  type Pr,
  type Snapshot,
  type TrainCar,
} from "@/backend/types.ts";
import { Button } from "@/components/ui/button";
import { DialogClose } from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/soleone/tooltip/tooltip";
import { agentName, clock, itemTitle } from "@/format";
import { Answer } from "@/JobNotes";
import { CHECKS, TrainLine } from "@/PullRequest";
import { Row } from "@/Row";
import { ATTENTION, StatePill, TaskDetails, taskState } from "@/TaskDetails";

export function canDismiss(job: Job) {
  return job.state === "done" || job.state === "failed" || job.state === "blocked";
}

export const hasBranch = (job: Job) => job.attempts.some((attempt) => attempt.branch);

/** The role to review the job's PR, unless it is a review or a fix of one, or has one already. */
export function reviewerOf(job: Job, snapshot: Snapshot) {
  if (job.item.blueprint === "review" || job.branchOf) return undefined;
  const reviewed = snapshot.jobs.some(
    (other) =>
      other.state !== "removed" &&
      other.item.blueprint === "review" &&
      itemKey(other.item) === itemKey(job.item),
  );
  if (reviewed) return undefined;
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
  // A goal runs no attempt of its own, yet the Inbox lists its final PR.
  const last = job.attempts.at(-1);
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
        ? `Job ${job.id}, "${itemTitle(job.item)}" (workwork ${job.item.id} in ${job.item.repo}), failed${last?.error ? `: ${last.error}` : ""}.${last ? ` Its log is ${last.log}.` : ""} Why did it fail, and should I retry it, pin another agent, or drop it?`
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
        {pending ? pendingLabel[pending] : primary === "rebase" ? "Rebase" : "Merge"}
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
  const retry = job.state === "failed" && (
    <Button
      variant="outline"
      size="sm"
      disabled={disabled}
      onClick={() => act(() => api.retry(job.id))}
    >
      <RotateCcwIcon data-icon="inline-start" />
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
      marked={unread}
      leading={leading || <span className="size-4" />}
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
          <StatePill
            state={state}
            label={
              state === "failed" && last && last.outcome !== "failed" ? last.outcome : undefined
            }
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
      {primaryButton("outline")}
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
  last?: Attempt;
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
      ? last?.error && (
          <span key="error" className="text-destructive">
            {last.error.split("\n")[0]}
          </span>
        )
      : !url && job.state === "done" && (result?.text ?? "nothing to change");
  return (
    <span className="min-w-0 truncate">
      {[...facts, last && agentName(last.agent), last && clock(last.end), text]
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

import {
  CircleCheckIcon,
  CircleDashedIcon,
  CircleIcon,
  CircleXIcon,
  GitPullRequestIcon,
  XIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { api, type Act } from "@/api";
import { AttemptFile } from "@/AttemptFile";
import { PrReview } from "@/PrReview";
import {
  canMerge,
  canRebase,
  onTrain,
  prUrl,
  type Attempt,
  type Job,
  type Pr,
  type Snapshot,
  type TrainCar,
} from "@/backend/types.ts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { ItemGroup } from "@/components/ui/item";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { agentName, day, itemTitle, minutes, OUTCOME_BADGE, tuning } from "@/format";
import { Row } from "@/Row";

type Prs = Snapshot["prs"];

/** A PR not fetched yet counts as open, so it doesn't vanish from review while gh answers. */
const FILTERS: Record<string, { label: string; shows: (job: Job, prs: Prs) => boolean }> = {
  review: {
    label: "Needs review",
    shows: (job, prs) => {
      const url = prUrl(job);
      return url !== undefined && (prs[url]?.state ?? "OPEN") === "OPEN";
    },
  },
  failed: { label: "Failed", shows: (job) => job.state === "failed" },
  nothing: {
    label: "Nothing to do",
    shows: (job) => {
      const last = job.attempts.at(-1)!;
      return job.state === "done" && !last.url && !last.branch;
    },
  },
  all: { label: "All", shows: () => true },
};

const PR_BADGE = { OPEN: "default", MERGED: "secondary", CLOSED: "outline" } as const;
const CHECKS = {
  passing: { label: "checks passing", Icon: CircleCheckIcon, className: "text-success" },
  failing: { label: "checks failing", Icon: CircleXIcon, className: "text-destructive" },
  pending: { label: "checks running", Icon: CircleDashedIcon, className: undefined },
  none: { label: "no checks", Icon: CircleIcon, className: undefined },
};

function canDismiss(job: Job) {
  return job.state === "done" || job.state === "failed";
}

/** What the train can try: it waits for running checks and rebases conflicts, but can't fix the rest. */
function canBoard(job: Job, prs: Prs, train: Snapshot["train"]) {
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

const TRAIN_STEP: Partial<Record<TrainCar["step"], string>> = {
  queued: "on the merge train",
  waiting: "merge train: waiting for checks",
  rebasing: "merge train: rebasing",
  merging: "merge train: merging",
};

/** One row per job that ran, latest first, with its PR to review and merge. */
export function ResultsView({
  snapshot,
  act,
  onAsk,
}: {
  snapshot: Snapshot;
  act: Act;
  onAsk: (question: string) => void;
}) {
  const [filter, setFilter] = useState("all");
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [dismissing, setDismissing] = useState(false);
  const { prs, train } = snapshot;
  const jobs = snapshot.jobs
    .filter((job) => job.state !== "removed" && job.attempts.length > 0)
    .sort((a, b) => b.attempts.at(-1)!.start.localeCompare(a.attempts.at(-1)!.start));
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

  const shown = jobs.filter((job) => FILTERS[filter].shows(job, prs));
  const dismissible = shown.filter(canDismiss);
  const selection = dismissible.filter((job) => selected.has(job.id));
  const allSelected = selection.length === dismissible.length;
  const boarding = selection.filter((job) => canBoard(job, prs, train));

  const select = (id: string, checked: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const dismissSelected = async () => {
    if (
      selection.some((job) => job.attempts.some((attempt) => attempt.branch)) &&
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
    } finally {
      setDismissing(false);
    }
  };

  const mergeSelected = () => {
    const count = boarding.length === 1 ? "1 PR" : `${boarding.length} PRs`;
    if (
      !window.confirm(
        `Merge ${count} one after another? Conflicting ones get rebased; ones that still conflict are skipped.`,
      )
    )
      return;
    void act(() => api.mergeTrain(boarding.map((job) => job.id)));
    setSelected(new Set());
  };

  return (
    <div className="flex flex-col gap-4 pt-2">
      <div className="flex flex-wrap items-center gap-3">
        <ToggleGroup
          variant="outline"
          className="flex-wrap"
          value={[filter]}
          disabled={dismissing}
          onValueChange={([chosen]) => {
            if (!chosen || chosen === filter) return;
            setFilter(chosen);
            setSelected(new Set());
          }}
        >
          {Object.entries(FILTERS).map(([name, { label, shows }]) => (
            <ToggleGroupItem key={name} value={name}>
              {label} ({jobs.filter((job) => shows(job, prs)).length})
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        {dismissible.length > 0 && (
          <div
            role="group"
            aria-label="Batch actions"
            className="flex items-center gap-2 sm:ml-auto"
          >
            <Button
              variant="ghost"
              size="sm"
              aria-label={allSelected ? "Clear selection" : undefined}
              disabled={dismissing}
              onClick={() =>
                setSelected(new Set(allSelected ? [] : dismissible.map((job) => job.id)))
              }
            >
              {allSelected ? "Clear" : "Select all"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={dismissing || selection.length === 0}
              onClick={dismissSelected}
            >
              {dismissing ? "Dismissing…" : `Dismiss (${selection.length})`}
            </Button>
            {shown.some((job) => canBoard(job, prs, train)) && (
              <Button
                size="sm"
                title="Merges one after another per repo, smallest first"
                disabled={dismissing || boarding.length === 0}
                onClick={mergeSelected}
              >
                Merge ({boarding.length})
              </Button>
            )}
          </div>
        )}
      </div>
      <ItemGroup>
        {shown.map((job) => (
          <Result
            key={job.id}
            job={job}
            prs={prs}
            act={act}
            car={train[job.id]}
            onAsk={onAsk}
            asked={snapshot.settings.chat.agent}
            disabled={dismissing && selected.has(job.id)}
            selection={
              canDismiss(job) && (
                <Checkbox
                  aria-label={`Select ${itemTitle(job.item)}`}
                  checked={selected.has(job.id)}
                  disabled={dismissing}
                  onCheckedChange={(checked) => select(job.id, checked)}
                />
              )
            }
          />
        ))}
      </ItemGroup>
    </div>
  );
}

function Result({
  job,
  prs,
  act,
  car,
  onAsk,
  asked,
  disabled: dismissing,
  selection,
}: {
  job: Job;
  prs: Prs;
  act: Act;
  car?: TrainCar;
  onAsk: (question: string) => void;
  /** The agent the Plan chat talks to. */
  asked: string;
  disabled: boolean;
  selection: ReactNode;
}) {
  const [pending, setPending] = useState<"merge" | "rebase" | "close">();
  const last = job.attempts.at(-1)!;
  const url = prUrl(job);
  const pr = url ? prs[url] : undefined;
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

  return (
    <Row
      leading={selection}
      title={
        <>
          {pr ? (
            <Badge variant={PR_BADGE[pr.state]}>{pr.state.toLowerCase()}</Badge>
          ) : (
            <Badge variant={OUTCOME_BADGE[last.outcome]}>{last.outcome}</Badge>
          )}{" "}
          <Badge variant="outline">{pr?.level ?? job.item.level}</Badge> {itemTitle(job.item)}
        </>
      }
      meta={
        <span className="flex flex-col gap-1">
          <AttemptLine job={job} attempt={last} />
          {url && <PrLine jobId={job.id} url={url} pr={pr} />}
          {car?.step === "skipped" && (
            <span className="text-destructive">
              Merge train skipped it: {car.reason.replaceAll("\n", " ")}
            </span>
          )}
          {car && TRAIN_STEP[car.step] && <span>{TRAIN_STEP[car.step]}</span>}
          {job.attempts.length > 1 && (
            <details>
              <summary className="cursor-pointer">
                {job.attempts.length - 1} earlier{" "}
                {job.attempts.length === 2 ? "attempt" : "attempts"}
              </summary>
              {job.attempts.slice(0, -1).map((attempt) => (
                <AttemptLine key={attempt.log} job={job} attempt={attempt} withOutcome />
              ))}
            </details>
          )}
        </span>
      }
    >
      {primary && (
        <Button size="sm" disabled={disabled} onClick={() => changePr(primary)}>
          {pending === "rebase"
            ? "Rebasing…"
            : pending === "merge"
              ? "Merging…"
              : primary === "rebase"
                ? "Rebase"
                : "Merge"}
        </Button>
      )}
      {open && (
        <Button variant="outline" size="sm" disabled={disabled} onClick={() => changePr("close")}>
          {pending === "close" ? "Closing…" : "Close"}
        </Button>
      )}
      {job.state === "failed" && (
        <Button
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={() => act(() => api.retry(job.id))}
        >
          Retry
        </Button>
      )}
      {question && (
        <Button variant="outline" size="sm" onClick={() => onAsk(question)}>
          Ask {agentName(asked)}
        </Button>
      )}
      {canDismiss(job) && (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Dismiss ${itemTitle(job.item)}`}
          title="Dismiss"
          disabled={disabled}
          onClick={() => act(() => api.remove(job.id))}
        >
          <XIcon aria-hidden="true" />
        </Button>
      )}
    </Row>
  );
}

function AttemptLine({
  job,
  attempt,
  withOutcome,
}: {
  job: Job;
  attempt: Attempt;
  withOutcome?: boolean;
}) {
  const agent = [attempt.agent, tuning(attempt)].filter(Boolean).join(" ");
  return (
    <span className="flex flex-col gap-1">
      <span className="flex flex-wrap items-center gap-x-3">
        <span>
          {[
            withOutcome && attempt.outcome,
            job.item.play,
            agent,
            `${day(attempt.start)}, ${minutes(attempt.start, attempt.end)}`,
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
        <AttemptFile log={attempt.log} agent={agent} kind="log" />
        {/* An error means the job failed before its prompt was written. */}
        {!attempt.error && <AttemptFile log={attempt.log} agent={agent} kind="prompt" />}
      </span>
      {attempt.error && <span className="text-destructive">{attempt.error.split("\n")[0]}</span>}
      {attempt.branch && <span>Unpushed work kept on branch {attempt.branch}</span>}
    </span>
  );
}

function PrLine({ jobId, url, pr }: { jobId: string; url: string; pr?: Pr }) {
  const checks = pr && CHECKS[pr.checks];
  return (
    <span className="flex flex-wrap items-center gap-x-3">
      <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1">
        <GitPullRequestIcon className="size-3.5" aria-hidden="true" />
        {url.replace("https://github.com/", "")}
      </a>
      {pr ? (
        <>
          {pr.state === "OPEN" && checks && (
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

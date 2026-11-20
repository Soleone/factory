import {
  CircleCheckIcon,
  CircleDashedIcon,
  CircleIcon,
  CircleXIcon,
  GitPullRequestIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { api, type Act } from "@/api";
import { useQueryParam } from "@/hooks/use-query-param";
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
import { NeutralCheckbox } from "@/components/variants/checkbox";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { ItemGroup } from "@/components/ui/item";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/soleone/tooltip/tooltip";
import { agentName, ago, itemTitle } from "@/format";
import { Answer } from "@/JobNotes";
import { Row } from "@/Row";
import { Choice } from "@/RunFields";
import { StateIcon, StatePill, TaskDetails, taskState } from "@/TaskDetails";

type Prs = Snapshot["prs"];

/** A PR not fetched yet counts as open, so it doesn't vanish from review while gh answers. */
const FILTERS: Record<string, { label: string; shows: (job: Job, prs: Prs) => boolean }> = {
  blocked: { label: "Waiting for you", shows: (job) => job.state === "blocked" },
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

const CHECKS = {
  passing: { label: "checks passing", Icon: CircleCheckIcon, className: "text-success" },
  failing: { label: "checks failing", Icon: CircleXIcon, className: "text-destructive" },
  pending: { label: "checks running", Icon: CircleDashedIcon, className: undefined },
  none: { label: "no checks", Icon: CircleIcon, className: undefined },
};

function canDismiss(job: Job) {
  return job.state === "done" || job.state === "failed" || job.state === "blocked";
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
  const [filter, setFilter] = useQueryParam("filter", "all");
  /** One job alone, as a link to it opens it. */
  const [only, setOnly] = useQueryParam("job", "");
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [dismissing, setDismissing] = useState(false);
  const seen = useLastSeen();
  const { prs, train } = snapshot;
  const active = snapshot.jobs.filter((job) => job.state !== "removed");
  const reviewed = new Set(
    active.filter((job) => job.item.play === "review").map((job) => itemKey(job.item)),
  );
  const agents = Object.keys(snapshot.settings.agents);
  const jobs = active
    .filter((job) => job.attempts.length > 0)
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

  const shown = jobs.filter((job) =>
    only ? job.id === only : (FILTERS[filter] ?? FILTERS.all).shows(job, prs),
  );
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
      {/* Like GitHub: the batch actions take the filter's place once something is selected. */}
      <div className="flex min-h-8 flex-wrap items-center gap-3 border border-transparent px-3">
        {dismissible.length > 0 && (
          <NeutralCheckbox
            aria-label={allSelected ? "Clear selection" : "Select all"}
            checked={selection.length > 0 && allSelected}
            disabled={dismissing}
            onCheckedChange={(checked) =>
              setSelected(new Set(checked ? dismissible.map((job) => job.id) : []))
            }
          />
        )}
        {selection.length === 0 ? (
          <Choice
            label="Filter"
            className="w-56"
            items={Object.entries(FILTERS).map(([name, { label, shows }]) => ({
              value: name,
              label: `${label} (${jobs.filter((job) => shows(job, prs)).length})`,
            }))}
            value={only ? "" : filter}
            onChange={(chosen) => {
              if (!chosen) return;
              setFilter(chosen);
              setOnly("");
            }}
          />
        ) : (
          <>
            <span className="text-sm font-medium">
              {selection.length} of {dismissible.length} selected
            </span>
            <div
              role="group"
              aria-label="Batch actions"
              className="flex items-center gap-2 sm:ml-auto"
            >
              <Button variant="outline" size="sm" disabled={dismissing} onClick={dismissSelected}>
                {dismissing ? "Dismissing…" : "Dismiss"}
              </Button>
              {boarding.length > 0 && (
                <Tooltip>
                  {/* A disabled button ignores the pointer, so the wrapper shows the hint. */}
                  <TooltipTrigger render={<span />}>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={dismissing}
                      onClick={mergeSelected}
                    >
                      Merge {boarding.length < selection.length && `(${boarding.length})`}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Merges one after another per repo, smallest first</TooltipContent>
                </Tooltip>
              )}
            </div>
          </>
        )}
      </div>
      <ItemGroup>
        {shown.map((job) => (
          <Result
            key={job.id}
            job={job}
            snapshot={snapshot}
            act={act}
            car={train[job.id]}
            onAsk={onAsk}
            asked={snapshot.settings.chat.agent}
            unread={seen !== "" && job.attempts.at(-1)!.end > seen}
            reviewer={
              job.item.play !== "review" && !reviewed.has(itemKey(job.item))
                ? agents.find((agent) => agent !== job.agent)
                : undefined
            }
            disabled={dismissing && selected.has(job.id)}
            selection={
              canDismiss(job) && (
                <NeutralCheckbox
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
  snapshot,
  act,
  car,
  onAsk,
  asked,
  unread,
  reviewer,
  disabled: dismissing,
  selection,
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
  selection: ReactNode;
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
  const dismiss = () => act(() => api.remove(job.id));
  const ask =
    job.state === "blocked" ? job.notes.findLast((note) => note.kind === "ask") : undefined;

  return (
    <Row
      leading={
        <>
          {selection}
          <StateIcon state={state} />
        </>
      }
      title={
        <>
          {unread && (
            <span
              role="img"
              aria-label="new"
              className="mr-1 inline-block size-2 rounded-full bg-primary align-middle"
            />
          )}
          <TaskDetails
            item={job.item}
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
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <StatePill
            state={state}
            label={state === "failed" && last.outcome !== "failed" ? last.outcome : undefined}
          />
          <Facts job={job} last={last} pr={pr} url={url} car={car} />
        </span>
      }
      below={ask && <Answer job={job} question={ask} act={act} />}
    >
      {primaryButton}
      {retry}
      {canDismiss(job) && (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Dismiss ${itemTitle(job.item)}`}
          disabled={disabled}
          onClick={dismiss}
        >
          <XIcon aria-hidden="true" />
        </Button>
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
  const checks = pr?.state === "OPEN" && CHECKS[pr.checks];
  const facts: ReactNode[] = url
    ? [
        pr?.state === "OPEN" && (pr.level ?? job.item.level),
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
        `#${url.split("/").at(-1)}`,
      ]
    : job.state === "failed"
      ? [
          last.error && (
            <span key="error" className="text-destructive">
              {last.error.split("\n")[0]}
            </span>
          ),
          job.attempts.length > 1 && `${job.attempts.length} attempts`,
        ]
      : [job.state === "done" && (result?.text ?? "nothing to change")];
  return (
    <span className="min-w-0 truncate">
      {[...facts, agentName(last.agent), ago(last.end)].filter(Boolean).map((fact, index) => (
        <span key={index}>
          {index > 0 && " · "}
          {fact}
        </span>
      ))}
    </span>
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

import {
  CircleCheckIcon,
  CircleDashedIcon,
  CircleIcon,
  CircleXIcon,
  GitMergeIcon,
  GitPullRequestIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { api, type Act } from "@/api";
import {
  onTrain,
  prUrl,
  type Job,
  type Pr,
  type Snapshot,
  type TrainCar,
} from "@/backend/types.ts";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/soleone/tooltip/tooltip";

type Prs = Snapshot["prs"];

export const CHECKS = {
  passing: { label: "checks passing", Icon: CircleCheckIcon, className: "text-success" },
  failing: { label: "checks failing", Icon: CircleXIcon, className: "text-destructive" },
  pending: { label: "checks running", Icon: CircleDashedIcon, className: undefined },
  none: { label: "no checks", Icon: CircleIcon, className: undefined },
};

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
          <GitMergeIcon data-icon="inline-start" />
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>Merges one after another per repo, smallest first</TooltipContent>
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

export function PrLine({ url, pr }: { url: string; pr?: Pr }) {
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
        </>
      ) : (
        <span>asking GitHub…</span>
      )}
    </span>
  );
}

import { useState } from "react";
import { api, type Act } from "@/api";
import {
  canMerge,
  prUrl,
  type Attempt,
  type Job,
  type Pr,
  type Snapshot,
} from "@/backend/types.ts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { ItemGroup } from "@/components/ui/item";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { day, itemTitle, minutes, OUTCOME_BADGE, tuning } from "@/format";
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
  passing: "checks passing",
  failing: "checks failing",
  pending: "checks running",
  none: "no checks",
};

/** One row per job that ran, latest first, with its PR to review and merge. */
export function ResultsView({ snapshot, act }: { snapshot: Snapshot; act: Act }) {
  const [filter, setFilter] = useState("all");
  const { prs } = snapshot;
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
  const failed = jobs.filter((job) => job.state === "failed");
  return (
    <div className="flex flex-col gap-4 pt-2">
      <div className="flex flex-wrap items-center gap-3">
        <ToggleGroup
          variant="outline"
          className="flex-wrap"
          value={[filter]}
          onValueChange={([chosen]) => chosen && setFilter(chosen)}
        >
          {Object.entries(FILTERS).map(([name, { label, shows }]) => (
            <ToggleGroupItem key={name} value={name}>
              {label} ({jobs.filter((job) => shows(job, prs)).length})
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        {filter === "failed" && failed.length > 0 && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => act(() => Promise.all(failed.map((job) => api.remove(job.id))))}
          >
            Dismiss all {failed.length}
          </Button>
        )}
      </div>
      <ItemGroup>
        {shown.map((job) => (
          <Result key={job.id} job={job} prs={prs} act={act} />
        ))}
      </ItemGroup>
    </div>
  );
}

function Result({ job, prs, act }: { job: Job; prs: Prs; act: Act }) {
  const last = job.attempts.at(-1)!;
  const url = prUrl(job);
  const pr = url ? prs[url] : undefined;
  const open = pr?.state === "OPEN";
  return (
    <Row
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
          {url && <PrLine url={url} pr={pr} />}
          {pr && <Review pr={pr} />}
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
      {pr && canMerge(pr) && (
        <Button size="sm" onClick={() => act(() => api.merge(job.id))}>
          Merge
        </Button>
      )}
      {open && (
        <Button variant="outline" size="sm" onClick={() => act(() => api.close(job.id))}>
          Close
        </Button>
      )}
      {job.state === "failed" && (
        <Button variant="outline" size="sm" onClick={() => act(() => api.retry(job.id))}>
          Retry
        </Button>
      )}
      {(job.state === "done" || job.state === "failed") && (
        <Button variant="ghost" size="sm" onClick={() => act(() => api.remove(job.id))}>
          Dismiss
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
      <span className="flex flex-wrap gap-x-3">
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
        <a href={`/${attempt.log}`} target="_blank" rel="noreferrer">
          log
        </a>
        {/* An error means the job failed before its prompt was written. */}
        {!attempt.error && (
          <a
            href={`/${attempt.log.replace(/agent\.log$/, "prompt.md")}`}
            target="_blank"
            rel="noreferrer"
          >
            prompt
          </a>
        )}
      </span>
      {attempt.error && <span className="text-destructive">{attempt.error.split("\n")[0]}</span>}
      {attempt.branch && <span>Unpushed work kept on branch {attempt.branch}</span>}
    </span>
  );
}

function PrLine({ url, pr }: { url: string; pr?: Pr }) {
  return (
    <span className="flex flex-wrap gap-x-3">
      <a href={url} target="_blank" rel="noreferrer">
        {url.replace("https://github.com/", "")}
      </a>
      {pr ? (
        <>
          {pr.state === "OPEN" && (
            <span className={pr.checks === "failing" ? "text-destructive" : undefined}>
              {CHECKS[pr.checks]}
            </span>
          )}
          {pr.draft && <span>draft</span>}
          {pr.conflicts && <span className="text-destructive">conflicts</span>}
          <span>
            +{pr.additions} −{pr.deletions} in {pr.files.length}{" "}
            {pr.files.length === 1 ? "file" : "files"}
          </span>
        </>
      ) : (
        <span>asking GitHub…</span>
      )}
    </span>
  );
}

function Review({ pr }: { pr: Pr }) {
  return (
    <details>
      <summary className="cursor-pointer">{pr.title}</summary>
      <span className="flex flex-col gap-2 py-1">
        {pr.summary && <span className="whitespace-pre-wrap">{pr.summary}</span>}
        <span className="flex flex-col font-mono text-xs">
          {pr.files.map((file) => (
            <span key={file}>{file}</span>
          ))}
        </span>
      </span>
    </details>
  );
}

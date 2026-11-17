import { api, type Act } from "@/api";
import type { Attempt, Job, Snapshot } from "@/backend/types.ts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { ItemGroup } from "@/components/ui/item";
import { clock, day, itemTitle, minutes, OUTCOME_BADGE, runStart, tuning } from "@/format";
import { Row, Section } from "@/Row";

/** Every attempt, newest run first, with its PR, log and prompt. */
export function ResultsView({ snapshot, act }: { snapshot: Snapshot; act: Act }) {
  const attempts = snapshot.jobs
    .flatMap((job) =>
      job.attempts.map((attempt, index) => ({
        job,
        attempt,
        last: index === job.attempts.length - 1,
      })),
    )
    .sort((a, b) => b.attempt.start.localeCompare(a.attempt.start));
  if (attempts.length === 0)
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>Nothing done yet</EmptyTitle>
          <EmptyDescription>
            What the agents did shows up here, with links to their PRs and logs.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );

  const runs = new Map<string, typeof attempts>();
  for (const entry of attempts)
    runs.set(entry.attempt.run, [...(runs.get(entry.attempt.run) ?? []), entry]);

  return (
    <div className="flex flex-col gap-8 pt-2">
      {[...runs].map(([run, entries]) => (
        <Section key={run} title={`Run ${day(runStart(run))}`}>
          <ItemGroup>
            {entries.map(({ job, attempt, last }) => (
              <Row
                key={attempt.log}
                title={
                  <>
                    <Badge variant={OUTCOME_BADGE[attempt.outcome]}>{attempt.outcome}</Badge>{" "}
                    {itemTitle(job.item)}
                  </>
                }
                meta={<Meta job={job} attempt={attempt} />}
              >
                {last && job.state === "failed" && (
                  <Button variant="outline" size="sm" onClick={() => act(() => api.retry(job.id))}>
                    Retry
                  </Button>
                )}
              </Row>
            ))}
          </ItemGroup>
        </Section>
      ))}
    </div>
  );
}

function Meta({ job, attempt }: { job: Job; attempt: Attempt }) {
  const agent = [attempt.agent, tuning(attempt)].filter(Boolean).join(" ");
  return (
    <span className="flex flex-col gap-1">
      <span>
        {[
          job.item.play,
          agent,
          `${clock(attempt.start)}, ${minutes(attempt.start, attempt.end)}`,
        ].join(" · ")}
      </span>
      {attempt.error && <span className="text-destructive">{attempt.error.split("\n")[0]}</span>}
      {attempt.branch && <span>Unpushed work kept on branch {attempt.branch}</span>}
      <span className="flex flex-wrap gap-x-3">
        {attempt.url && (
          <a href={attempt.url} target="_blank" rel="noreferrer">
            {attempt.url.replace("https://github.com/", "")}
          </a>
        )}
        <a href={`/${attempt.log}`} target="_blank" rel="noreferrer">
          log
        </a>
        <a
          href={`/${attempt.log.replace(/agent\.log$/, "prompt.md")}`}
          target="_blank"
          rel="noreferrer"
        >
          prompt
        </a>
      </span>
    </span>
  );
}

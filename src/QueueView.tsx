import { ArrowDownIcon, ArrowUpIcon, XIcon } from "lucide-react";
import { api, type Act } from "@/api";
import type { Job, Snapshot } from "@/backend/types.ts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { ItemGroup } from "@/components/ui/item";
import { clock, itemTitle, tuning, WORKER_BADGE } from "@/format";
import { Row, Section } from "@/Row";

function jobMeta(job: Job): string {
  const pin = job.agent ? [job.agent, tuning(job)].filter(Boolean).join(" ") : "";
  return [job.item.play, job.item.level, pin].filter(Boolean).join(" · ");
}

export function QueueView({
  snapshot,
  act,
  onBrowse,
}: {
  snapshot: Snapshot;
  act: Act;
  onBrowse: () => void;
}) {
  const { jobs, status, on, settings } = snapshot;
  const byId = new Map(jobs.map((job) => [job.id, job]));
  const picks = jobs.filter((job) => job.state === "queued" && job.source === "pick");
  const auto = jobs.filter((job) => job.state === "queued" && job.source === "auto");
  const remove = (job: Job) => (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label="Remove"
      onClick={() => act(() => api.remove(job.id))}
    >
      <XIcon />
    </Button>
  );

  return (
    <div className="flex flex-col gap-8 pt-2">
      {on && status && (
        <Section title="Agents">
          <ItemGroup>
            {status.workers.map((worker) => {
              const job = worker.job ? byId.get(worker.job) : undefined;
              const what = job
                ? itemTitle(job.item)
                : worker.until
                  ? `until ${clock(worker.until)}`
                  : (worker.reason ?? "waiting for work");
              const limits = `limits hit ${worker.limits} of ${status.limit ?? "∞"}`;
              return (
                <Row
                  key={worker.agent}
                  title={
                    <>
                      {worker.agent}{" "}
                      <Badge variant={WORKER_BADGE[worker.state]}>{worker.state}</Badge>
                    </>
                  }
                  meta={[what, tuning(worker), `since ${clock(worker.since)}`, limits]
                    .filter(Boolean)
                    .join(" · ")}
                />
              );
            })}
          </ItemGroup>
        </Section>
      )}

      <Section title={`Your picks (${picks.length})`}>
        {picks.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>Nothing picked</EmptyTitle>
              <EmptyDescription>
                Picks go before anything auto mode queues. Find work under Browse.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button variant="outline" onClick={onBrowse}>
                Browse candidates
              </Button>
            </EmptyContent>
          </Empty>
        ) : (
          <ItemGroup>
            {picks.map((job, index) => (
              <Row key={job.id} title={itemTitle(job.item)} meta={jobMeta(job)}>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Move up"
                  disabled={index === 0}
                  onClick={() => act(() => api.move(job.id, index - 1))}
                >
                  <ArrowUpIcon />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Move down"
                  disabled={index === picks.length - 1}
                  onClick={() => act(() => api.move(job.id, index + 1))}
                >
                  <ArrowDownIcon />
                </Button>
                {remove(job)}
              </Row>
            ))}
          </ItemGroup>
        )}
      </Section>

      <Section title={`Auto (${auto.length})`}>
        {auto.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {settings.auto.on
              ? "Auto mode tops this up to 5 jobs per agent while the factory is on."
              : "Auto mode is off. Turn it on to keep the queue topped up from workwork."}
          </p>
        ) : (
          <ItemGroup>
            {auto.map((job) => (
              <Row key={job.id} title={itemTitle(job.item)} meta={jobMeta(job)}>
                {remove(job)}
              </Row>
            ))}
          </ItemGroup>
        )}
      </Section>
    </div>
  );
}

import { ArrowDownIcon, ArrowUpIcon, XIcon } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import type { ReactNode, Ref } from "react";
import { api, type Act } from "@/api";
import { TIERS, type Job, type Snapshot } from "@/backend/types.ts";
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
import { clock, itemTitle, minutesSince, pinName, tuning, WORKER_BADGE } from "@/format";
import { Row, Section } from "@/Row";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/soleone/tooltip/tooltip";
import { StateIcon, StatePill, TaskDetails } from "@/TaskDetails";

function jobMeta(job: Job, byId: Map<string, Job>): string {
  const pin = job.agent ? pinName({ ...job, agent: job.agent }) : "";
  const waiting = job.after.flatMap((id) => {
    const before = byId.get(id);
    return before && before.state !== "done" ? [itemTitle(before.item)] : [];
  });
  const after = waiting.length > 0 && `after ${waiting.join(", ")}`;
  return [job.item.play, job.item.level, pin, after].filter(Boolean).join(" · ");
}

function Meta({ job, byId }: { job: Job; byId: Map<string, Job> }) {
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <StatePill state={job.state} />
      {jobMeta(job, byId)}
    </span>
  );
}

/** Glides to its new place when the order changes, and slides out to the right when it leaves the queue. */
function Glide({ ref, children }: { ref?: Ref<HTMLDivElement>; children: ReactNode }) {
  return (
    <motion.div
      ref={ref}
      layout="position"
      exit={{ opacity: 0, x: 64 }}
      transition={{ duration: 0.2 }}
    >
      {children}
    </motion.div>
  );
}

export function QueueView({
  snapshot,
  act,
  onCandidates,
}: {
  snapshot: Snapshot;
  act: Act;
  onCandidates: () => void;
}) {
  const { jobs, status, on, settings } = snapshot;
  const byId = new Map(jobs.map((job) => [job.id, job]));
  const picks = jobs.filter((job) => job.state === "queued" && job.source === "pick");
  const auto = jobs.filter((job) => job.state === "queued" && job.source === "auto");
  const details = (job: Job, removable: boolean) => (
    <TaskDetails
      item={job.item}
      job={job}
      snapshot={snapshot}
      act={act}
      actions={
        removable && (
          <Button
            variant="destructive"
            size="sm"
            className="sm:mr-auto"
            onClick={() => act(() => api.remove(job.id))}
          >
            Remove from queue
          </Button>
        )
      }
    />
  );
  const remove = (job: Job) => (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Remove from queue"
            onClick={() => act(() => api.remove(job.id))}
          />
        }
      >
        <XIcon />
      </TooltipTrigger>
      <TooltipContent>Remove from queue</TooltipContent>
    </Tooltip>
  );

  return (
    <div className="flex flex-col gap-8 pt-2">
      {on &&
        status &&
        status.pools.map((pool) => {
          const pause = pool.stopped ?? (pool.until ? `sleeps until ${clock(pool.until)}` : "");
          return (
            <Section
              key={pool.name}
              title={`${pool.name}: limits hit ${pool.limits} of ${status.limit ?? "∞"}${pause ? `, ${pause}` : ""}`}
            >
              <ItemGroup>
                {status.workers
                  .filter((worker) => worker.pool === pool.name)
                  .map((worker) => {
                    const job = worker.job ? byId.get(worker.job) : undefined;
                    const what = job
                      ? undefined
                      : worker.until
                        ? `until ${clock(worker.until)}`
                        : (worker.reason ?? "waiting for work");
                    const tiers = TIERS.filter((tier) =>
                      settings.tiers[tier].includes(worker.preset),
                    );
                    const step = job?.notes.findLast(
                      (note) => note.kind === "step" && note.attempt === job.attempts.length + 1,
                    );
                    const said = job?.notes.findLast((note) => note.kind !== "step");
                    return (
                      <Row
                        key={worker.id}
                        title={
                          <>
                            {worker.id}{" "}
                            <Badge variant={WORKER_BADGE[worker.state]}>{worker.state}</Badge>
                            {tiers.map((tier) => (
                              <Badge key={tier} variant="secondary" className="ml-1">
                                {tier}
                              </Badge>
                            ))}
                          </>
                        }
                        meta={
                          <span className="flex flex-col gap-1">
                            {job && (
                              <span className="flex items-center gap-2 text-foreground">
                                <StateIcon state={job.state} />
                                {details(job, false)}
                              </span>
                            )}
                            <span>
                              {[
                                what,
                                tuning(worker),
                                job
                                  ? `${minutesSince(worker.since)} min`
                                  : `since ${clock(worker.since)}`,
                                worker.context && `${Math.round(worker.context / 1000)}k context`,
                              ]
                                .filter(Boolean)
                                .join(" · ")}
                            </span>
                            {step && (
                              <span className="text-foreground">
                                {step.text}
                                {step.of ? ` (${step.done ?? 0}/${step.of})` : ""}
                              </span>
                            )}
                            {worker.activity && <span>{worker.activity}</span>}
                            {said && (
                              <span>
                                {clock(said.at)} {said.kind}: {said.text}
                              </span>
                            )}
                          </span>
                        }
                      />
                    );
                  })}
              </ItemGroup>
            </Section>
          );
        })}

      <Section title={`Your picks (${picks.length})`}>
        {picks.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>Nothing picked</EmptyTitle>
              <EmptyDescription>
                Picks go before anything auto mode queues. Find work under Candidates.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button variant="outline" onClick={onCandidates}>
                Browse candidates
              </Button>
            </EmptyContent>
          </Empty>
        ) : (
          <ItemGroup>
            <AnimatePresence mode="popLayout" initial={false}>
              {picks.map((job, index) => (
                <Glide key={job.id}>
                  <Row
                    leading={<StateIcon state={job.state} />}
                    title={details(job, true)}
                    meta={<Meta job={job} byId={byId} />}
                  >
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
                </Glide>
              ))}
            </AnimatePresence>
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
            <AnimatePresence mode="popLayout" initial={false}>
              {auto.map((job) => (
                <Glide key={job.id}>
                  <Row
                    leading={<StateIcon state={job.state} />}
                    title={details(job, true)}
                    meta={<Meta job={job} byId={byId} />}
                  >
                    {remove(job)}
                  </Row>
                </Glide>
              ))}
            </AnimatePresence>
          </ItemGroup>
        )}
      </Section>
    </div>
  );
}

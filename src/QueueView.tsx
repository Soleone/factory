import { ArrowDownIcon, ArrowUpIcon, PlusIcon, XIcon } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useState, type ReactNode, type Ref } from "react";
import { api, type Act } from "@/api";
import {
  TIERS,
  type Job,
  type Settings,
  type Snapshot,
  type Status,
  type Worker,
} from "@/backend/types.ts";
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
import { clock, itemTitle, minutesSince, pinName, tuning } from "@/format";
import { NewJobDialog } from "@/NewJobDialog";
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

/** A worker's name as its tiers say it, the same chip in the pool and on the job it picks up, so it moves from one to the other. */
function WorkerChip({ worker, settings }: { worker: Worker; settings: Settings }) {
  const tiers = TIERS.filter((tier) => settings.tiers[tier].includes(worker.preset));
  return (
    <motion.span
      layoutId={`worker-${worker.id}`}
      transition={{ duration: 0.35 }}
      className="inline-flex"
    >
      <Badge variant={worker.job ? "default" : "secondary"}>
        {tiers.length > 0 ? tiers.join(", ") : "untiered"}
        <span className="opacity-60">#{worker.id.split("#").at(-1)}</span>
      </Badge>
    </motion.span>
  );
}

const WORKER_DOT: Record<Worker["state"], string> = {
  idle: "bg-success",
  working: "bg-primary",
  sleeping: "bg-muted-foreground",
  stopped: "bg-destructive",
};

/** The free workers by pool, small and to the side: they leave it while they work a job. */
function Workers({ status, settings }: { status: Status; settings: Settings }) {
  return (
    <aside className="flex flex-col gap-4 lg:col-start-2">
      {status.pools.map((pool) => {
        const workers = status.workers.filter((worker) => worker.pool === pool.name);
        const free = workers.filter((worker) => !worker.job);
        const pause = pool.stopped ?? (pool.until ? `sleeps until ${clock(pool.until)}` : "");
        return (
          <section key={pool.name} className="flex flex-col gap-1.5 text-sm">
            <h2 className="flex items-baseline justify-between gap-2 font-medium text-muted-foreground">
              {pool.name}
              <span className="text-xs font-normal tabular-nums">
                {free.length} of {workers.length} free · limits {pool.limits}/{status.limit ?? "∞"}
              </span>
            </h2>
            {pause && <p className="text-xs text-warning">{pause}</p>}
            <ul className="flex flex-col gap-1">
              {free.map((worker) => (
                <li key={worker.id}>
                  <Tooltip>
                    <TooltipTrigger render={<span className="flex items-center gap-2" />}>
                      <span
                        className={`size-1.5 shrink-0 rounded-full ${WORKER_DOT[worker.state]}`}
                      />
                      <WorkerChip worker={worker} settings={settings} />
                      <span className="truncate text-xs text-muted-foreground">
                        {worker.state === "idle" ? tuning(worker) : worker.state}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>
                      {worker.id}, {worker.state}
                      {worker.until
                        ? ` until ${clock(worker.until)}`
                        : worker.reason
                          ? `: ${worker.reason}`
                          : ` since ${clock(worker.since)}`}
                      {worker.preset === worker.agent &&
                        `. The run's own ${worker.agent} worker, for jobs without a tier, like maintenance picks.`}
                    </TooltipContent>
                  </Tooltip>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </aside>
  );
}

/** A job a worker has now, with the worker on it and what it does. */
function Running({
  worker,
  job,
  title,
  settings,
}: {
  worker: Worker;
  job: Job;
  title: ReactNode;
  settings: Settings;
}) {
  const step = job.notes.findLast(
    (note) => note.kind === "step" && note.attempt === job.attempts.length + 1,
  );
  const said = job.notes.findLast((note) => note.kind !== "step");
  return (
    <Row
      leading={<StateIcon state={job.state} />}
      title={title}
      meta={
        <span className="flex flex-col gap-1">
          <span className="flex flex-wrap items-center gap-2">
            <WorkerChip worker={worker} settings={settings} />
            {[
              tuning(worker),
              `${minutesSince(worker.since)} min`,
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
  const [creating, setCreating] = useState(false);
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

  const newJob = (
    <Button variant="outline" onClick={() => setCreating(true)}>
      <PlusIcon /> New job
    </Button>
  );

  const running = on && status ? status.workers.filter((worker) => worker.job) : [];

  return (
    <div className={`grid gap-8 pt-2 ${on && status ? "lg:grid-cols-[1fr_15rem]" : ""}`}>
      {on && status && <Workers status={status} settings={settings} />}
      <div className="flex min-w-0 flex-col gap-8 lg:row-start-1">
        <NewJobDialog act={act} open={creating} onOpenChange={setCreating} />
        {running.length > 0 && (
          <Section title={`Running (${running.length})`}>
            <ItemGroup>
              {running.map((worker) => {
                const job = byId.get(worker.job!);
                return (
                  job && (
                    <Running
                      key={worker.id}
                      worker={worker}
                      job={job}
                      title={details(job, false)}
                      settings={settings}
                    />
                  )
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
                  Picks go before anything auto mode queues. Find work under Candidates, or write a
                  job of your own.
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent className="flex-row justify-center">
                <Button variant="outline" onClick={onCandidates}>
                  Browse candidates
                </Button>
                {newJob}
              </EmptyContent>
            </Empty>
          ) : (
            <>
              <div className="flex justify-end">{newJob}</div>
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
            </>
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
    </div>
  );
}

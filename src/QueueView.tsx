import { ArrowDownIcon, ArrowUpIcon, GripVerticalIcon, XIcon } from "lucide-react";
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
import { TierBadge } from "@/TierBadge";
import { Row, Section } from "@/Row";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/soleone/tooltip/tooltip";
import { StateIcon, StatePill, TaskDetails } from "@/TaskDetails";

function Meta({ job, byId }: { job: Job; byId: Map<string, Job> }) {
  const pin = job.agent && pinName({ agent: job.agent, model: job.model, effort: job.effort });
  const waiting = job.after.flatMap((id) => {
    const before = byId.get(id);
    return before && before.state !== "done" ? [itemTitle(before.item)] : [];
  });
  const after = waiting.length > 0 && `after ${waiting.join(", ")}`;
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <StatePill state={job.state} />
      {[job.item.blueprint, job.item.attention, pin, after].filter(Boolean).join(" · ")}
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

/** What a worker can do now: ready only when it's idle without a job. */
function slot(worker: Worker): string {
  if (worker.job) return "busy";
  return worker.state === "idle" ? "ready" : worker.state;
}

/**
 * Each pool as a bar of its workers, busy ones filled, and the free ones listed:
 * they leave the list while they work a job.
 */
function Workers({ status, settings }: { status: Status; settings: Settings }) {
  return (
    <aside className="flex flex-col gap-5 lg:col-start-2">
      {status.pools.map((pool) => {
        const workers = status.workers.filter((worker) => worker.pool === pool.name);
        const free = workers.filter((worker) => !worker.job);
        const counts = ["ready", "busy", "sleeping", "stopped"].flatMap((name) => {
          const n = workers.filter((worker) => slot(worker) === name).length;
          return n > 0 ? [`${n} ${name}`] : [];
        });
        const pause =
          pool.stopped ??
          (pool.until
            ? `${pool.reserved ? "keeps its reserve" : "sleeps"} until ${clock(pool.until)}`
            : "");
        const notes = [
          pool.used !== undefined &&
            `${pool.used}% of 5h used, keeps ${settings.reserves[pool.name] ?? 0}%`,
          pool.limits > 0 &&
            `hit its usage limit ${pool.limits}${status.limit === null ? "" : ` of ${status.limit}`} times`,
        ].filter(Boolean);
        return (
          <section key={pool.name} className="flex flex-col gap-1.5 text-sm">
            <h2 className="flex items-baseline justify-between gap-2 font-medium text-muted-foreground">
              <span className="whitespace-nowrap">{pool.name}</span>
              <span className="text-right text-xs font-normal tabular-nums">
                {counts.join(" · ")}
              </span>
            </h2>
            <div className="flex gap-0.5">
              {workers.map((worker) => (
                <span
                  key={worker.id}
                  className={`h-1.5 flex-1 rounded-full ${worker.job ? WORKER_DOT.working : WORKER_DOT[worker.state]}`}
                />
              ))}
            </div>
            {notes.length > 0 && (
              <p className="text-xs text-muted-foreground">{notes.join(" · ")}</p>
            )}
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

/** The queued jobs the Queue tab lists, so its count and its rows agree. */
export function queued(jobs: Job[]) {
  const byId = new Map(jobs.map((job) => [job.id, job]));
  const waiting = jobs.filter((job) => job.state === "queued");
  return {
    picks: waiting.filter((job) => job.source === "pick"),
    auto: waiting.filter((job) => job.source === "auto"),
    // A goal's nodes wait while the goal does (for approval, or paused); milestones never run themselves.
    fromGoals: waiting.filter(
      (job) =>
        job.of &&
        byId.get(job.of)?.state === "queued" &&
        !jobs.some((each) => each.parent === job.id),
    ),
  };
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
  onAdd,
}: {
  snapshot: Snapshot;
  act: Act;
  onAdd: (view: "candidates" | "job") => void;
}) {
  const { jobs, status, on, settings } = snapshot;
  const [dragging, setDragging] = useState<number>();
  const byId = new Map(jobs.map((job) => [job.id, job]));
  const { picks, auto, fromGoals } = queued(jobs);
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

  const running = on && status ? status.workers.filter((worker) => worker.job) : [];

  return (
    <div className={`grid gap-8 pt-2 ${on && status ? "lg:grid-cols-[1fr_15rem]" : ""}`}>
      {on && status && <Workers status={status} settings={settings} />}
      <div className="flex min-w-0 flex-col gap-8 lg:row-start-1">
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
                <Button variant="outline" onClick={() => onAdd("candidates")}>
                  Browse candidates
                </Button>
                <Button variant="outline" onClick={() => onAdd("job")}>
                  Write your own
                </Button>
              </EmptyContent>
            </Empty>
          ) : (
            <ItemGroup>
              <AnimatePresence mode="popLayout" initial={false}>
                {picks.map((job, index) => (
                  <Glide key={job.id}>
                    <div
                      draggable
                      onDragStart={() => setDragging(index)}
                      onDragOver={(event) => dragging !== undefined && event.preventDefault()}
                      onDrop={() => {
                        if (dragging !== undefined && dragging !== index)
                          void act(() => api.move(picks[dragging].id, index));
                        setDragging(undefined);
                      }}
                      onDragEnd={() => setDragging(undefined)}
                    >
                      <Row
                        leading={
                          <span className="flex items-center gap-1">
                            <GripVerticalIcon className="size-4 cursor-grab text-muted-foreground" />
                            <StateIcon state={job.state} />
                          </span>
                        }
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
                    </div>
                  </Glide>
                ))}
              </AnimatePresence>
            </ItemGroup>
          )}
        </Section>

        {fromGoals.length > 0 && (
          <Section title={`From goals (${fromGoals.length})`}>
            <ItemGroup>
              <AnimatePresence mode="popLayout" initial={false}>
                {fromGoals.map((job) => (
                  <Glide key={job.id}>
                    <Row
                      leading={<StateIcon state={job.state} />}
                      title={details(job, false)}
                      meta={
                        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          {job.tier && <TierBadge tier={job.tier} />}
                          {byId.get(job.of!)!.item.title}
                        </span>
                      }
                    />
                  </Glide>
                ))}
              </AnimatePresence>
            </ItemGroup>
          </Section>
        )}

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

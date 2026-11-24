import { XIcon } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useState, type ReactNode, type Ref } from "react";
import { api, type Act } from "@/api";
import {
  presetWorkers,
  type Job,
  type Pool as PoolUsage,
  type Preset,
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
import { clock, itemTitle, minutesSince } from "@/format";
import { PinChip } from "@/PinMenu";
import { ProviderLogo, providerOf, WorkerName } from "@/WorkerName";
import { TierBadge } from "@/TierBadge";
import { ReorderHandle } from "@/ReorderHandle";
import { Row, Section } from "@/Row";
import { RowGroup } from "@/components/variants/item";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/soleone/tooltip/tooltip";
import { StateIcon, StatePill, TaskDetails } from "@/TaskDetails";

function jobMeta(job: Job, byId: Map<string, Job>): string {
  const waiting = job.after.flatMap((id) => {
    const before = byId.get(id);
    return before && before.state !== "done" ? [itemTitle(before.item)] : [];
  });
  const after = waiting.length > 0 && `after ${waiting.join(", ")}`;
  return [job.item.blueprint, job.item.attention, after].filter(Boolean).join(" · ");
}

function Meta({
  job,
  byId,
  settings,
  act,
}: {
  job: Job;
  byId: Map<string, Job>;
  settings: Settings;
  act: Act;
}) {
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <StatePill state={job.state} />
      <PinChip job={job} settings={settings} act={act} />
      {job.machine && <Alone />}
      {jobMeta(job, byId)}
    </span>
  );
}

function Alone() {
  return (
    <Tooltip>
      <TooltipTrigger render={<Badge variant="outline" />}>runs alone</TooltipTrigger>
      <TooltipContent>
        It changes things outside its worktree, so it waits until no other job runs
      </TooltipContent>
    </Tooltip>
  );
}

/** Working is the one filled, accented dot; ready is an empty ring. */
const DOT: Record<Worker["state"], string> = {
  idle: "border border-muted-foreground",
  working: "bg-primary",
  sleeping: "bg-muted-foreground/40",
  stopped: "bg-destructive",
};

/**
 * Each provider's workers as same-size dots, a row per kind of worker, filled while one works.
 * While the factory is off it shows, muted, the workers the settings would start.
 */
function Pool({ status, presets }: { status: Status | null; presets: Preset[] }) {
  const workers = status?.workers ?? presetWorkers(presets);
  const pools =
    status?.pools ??
    [...new Set(workers.map((worker) => worker.pool))].map((name): PoolUsage => ({
      name,
      limits: 0,
    }));
  return (
    <aside className={`flex flex-col gap-5 lg:col-start-2 ${status ? "" : "opacity-60"}`}>
      {pools.map((pool) => {
        const inPool = workers.filter((worker) => worker.pool === pool.name);
        const busy = inPool.filter((worker) => worker.job).length;
        const kinds = [...new Set(inPool.map((worker) => worker.preset))];
        const pause =
          pool.stopped ??
          (pool.until
            ? `${pool.reserved ? "keeps its reserve" : "sleeps"} until ${clock(pool.until)}`
            : "");
        return (
          <section key={pool.name} className="flex flex-col gap-2 text-sm">
            <h2 className="flex items-center justify-between gap-2 font-medium text-muted-foreground">
              <span className="flex items-center gap-1.5 whitespace-nowrap">
                <ProviderLogo pool={pool.name} />
                {providerOf(pool.name).name}
              </span>
              <span className="text-xs font-normal tabular-nums">
                {status ? `${busy} of ${inPool.length} busy` : `${inPool.length} off`}
              </span>
            </h2>
            <ul className="flex flex-col gap-1.5">
              {kinds.map((kind) => {
                const same = inPool.filter((worker) => worker.preset === kind);
                return (
                  <li key={kind} className="flex items-center justify-between gap-3">
                    <WorkerName of={same[0]} logo={false} />
                    <span className="flex shrink-0 gap-1">
                      {same.map((worker) => (
                        <Tooltip key={worker.id}>
                          <TooltipTrigger
                            render={
                              <span
                                className={`size-2.5 rounded-full ${DOT[worker.job ? "working" : worker.state]}`}
                              />
                            }
                          />
                          <TooltipContent>
                            {worker.id},{" "}
                            {!status
                              ? "starts when the factory is on"
                              : worker.job
                                ? "working"
                                : worker.state === "idle"
                                  ? "ready"
                                  : worker.state}
                            {!status
                              ? ""
                              : worker.until
                                ? ` until ${clock(worker.until)}`
                                : worker.reason
                                  ? `: ${worker.reason}`
                                  : ` since ${clock(worker.since)}`}
                          </TooltipContent>
                        </Tooltip>
                      ))}
                    </span>
                  </li>
                );
              })}
            </ul>
            {pool.limits > 0 && (
              <p className="text-xs text-muted-foreground">
                hit its usage limit {pool.limits}
                {status?.limit == null ? "" : ` of ${status.limit}`} times
              </p>
            )}
            {pause && <p className="text-xs text-warning">{pause}</p>}
          </section>
        );
      })}
    </aside>
  );
}

/** A job a worker has now, with the worker on it and what it does. */
function Running({ worker, job, title }: { worker: Worker; job: Job; title: ReactNode }) {
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
            <WorkerName of={worker} />
            {[
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
    <div className="grid gap-8 pt-2 lg:grid-cols-[1fr_15rem]">
      <Pool status={on ? status : null} presets={settings.presets} />
      <div className="flex min-w-0 flex-col gap-8 lg:row-start-1">
        {running.length > 0 && (
          <Section title={`Running (${running.length})`}>
            <RowGroup>
              {running.map((worker) => {
                const job = byId.get(worker.job!);
                return (
                  job && (
                    <Running
                      key={worker.id}
                      worker={worker}
                      job={job}
                      title={details(job, false)}
                    />
                  )
                );
              })}
            </RowGroup>
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
            <>
              <RowGroup>
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
                              <ReorderHandle
                                label={itemTitle(job.item)}
                                index={index}
                                count={picks.length}
                                onMove={(target) => void act(() => api.move(job.id, target))}
                              />
                              <StateIcon state={job.state} />
                            </span>
                          }
                          title={details(job, true)}
                          meta={<Meta job={job} byId={byId} settings={settings} act={act} />}
                        >
                          {remove(job)}
                        </Row>
                      </div>
                    </Glide>
                  ))}
                </AnimatePresence>
              </RowGroup>
            </>
          )}
        </Section>

        {fromGoals.length > 0 && (
          <Section title={`From goals (${fromGoals.length})`}>
            <RowGroup>
              <AnimatePresence mode="popLayout" initial={false}>
                {fromGoals.map((job) => (
                  <Glide key={job.id}>
                    <Row
                      leading={<StateIcon state={job.state} />}
                      title={details(job, false)}
                      meta={
                        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          {job.tier && <TierBadge tier={job.tier} />}
                          {job.machine && <Alone />}
                          {byId.get(job.of!)!.item.title}
                        </span>
                      }
                    />
                  </Glide>
                ))}
              </AnimatePresence>
            </RowGroup>
          </Section>
        )}

        <Section title={`Auto (${auto.length})`}>
          {auto.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {settings.auto.on
                ? "Auto mode tops this up to 5 jobs per worker while the factory is on."
                : "Auto mode is off. Turn it on to keep the queue topped up from workwork."}
            </p>
          ) : (
            <RowGroup>
              <AnimatePresence mode="popLayout" initial={false}>
                {auto.map((job) => (
                  <Glide key={job.id}>
                    <Row
                      leading={<StateIcon state={job.state} />}
                      title={details(job, true)}
                      meta={<Meta job={job} byId={byId} settings={settings} act={act} />}
                    >
                      {remove(job)}
                    </Row>
                  </Glide>
                ))}
              </AnimatePresence>
            </RowGroup>
          )}
        </Section>
      </div>
    </div>
  );
}

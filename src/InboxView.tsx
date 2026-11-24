import {
  CheckCheckIcon,
  CheckIcon,
  EyeIcon,
  FlagIcon,
  LightbulbIcon,
  SettingsIcon,
} from "lucide-react";
import { api, type Act } from "@/api";
import type { Snapshot } from "@/backend/types.ts";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { holds, inbox, type InboxItem } from "@/inbox";
import { canBoard, MergeButton, mergeTrain } from "@/PullRequest";
import { Result, reviewerOf, usePeek } from "@/Result";
import { Row } from "@/Row";
import { RowGroup } from "@/components/variants/item";
import { AssumeAnswer, TaskDetails } from "@/TaskDetails";
import { Said } from "@/JobNotes";

const ICON = {
  checkpoint: <FlagIcon className="size-4 text-warning" />,
  setup: <SettingsIcon className="size-4 text-warning" />,
  assume: <LightbulbIcon className="size-4 text-warning" />,
  unverified: <EyeIcon className="size-4 text-muted-foreground" />,
};

/** Everything that waits on the user, in one place: what holds work up first, then what can wait. */
export function InboxView({
  snapshot,
  act,
  onAsk,
  onOpenGoal,
}: {
  snapshot: Snapshot;
  act: Act;
  onAsk: (question: string) => void;
  onOpenGoal: (id: string) => void;
}) {
  const { stopped, ready } = inbox(snapshot);
  const peek = usePeek();
  if (stopped.length + ready.length === 0)
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>Nothing waits on you</EmptyTitle>
          <EmptyDescription>
            Questions, approvals and PRs to review show up here as agents get to them.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );

  const mergeable = ready.flatMap((item) =>
    item.kind === "review" && canBoard(item.job, snapshot.prs, snapshot.train) ? [item.job] : [],
  );
  const row = (item: InboxItem) => (
    <InboxRow
      key={`${item.kind} ${item.job.id} ${"need" in item ? item.need : ""}${"note" in item ? item.note.at : ""}`}
      item={item}
      snapshot={snapshot}
      act={act}
      onAsk={onAsk}
      onOpenGoal={onOpenGoal}
      peek={peek}
    />
  );

  return (
    <div className="flex flex-col gap-6 pt-2">
      {stopped.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="flex min-h-8 items-center gap-2 px-3 text-sm font-medium">
            Work stopped until you act{" "}
            <span className="font-normal text-muted-foreground">{stopped.length}</span>
          </h2>
          <RowGroup>{stopped.map(row)}</RowGroup>
        </section>
      )}
      {ready.length > 0 && (
        <section className="flex flex-col gap-3">
          <div className="flex min-h-8 items-center gap-3 px-3">
            <h2 className="text-sm font-medium">
              Ready when you are{" "}
              <span className="font-normal text-muted-foreground">{ready.length}</span>
            </h2>
            {mergeable.length > 1 && (
              <MergeButton
                className="ml-auto"
                disabled={false}
                onClick={() => void mergeTrain(mergeable, act)}
              >
                Merge all ready ({mergeable.length})
              </MergeButton>
            )}
          </div>
          <RowGroup>{ready.map(row)}</RowGroup>
        </section>
      )}
    </div>
  );
}

function InboxRow({
  item,
  snapshot,
  act,
  onAsk,
  onOpenGoal,
  peek,
}: {
  item: InboxItem;
  snapshot: Snapshot;
  act: Act;
  onAsk: (question: string) => void;
  onOpenGoal: (id: string) => void;
  peek: ReturnType<typeof usePeek>;
}) {
  const { job } = item;
  const title = <TaskDetails item={job.item} job={job} snapshot={snapshot} act={act} />;
  switch (item.kind) {
    case "ask":
    case "failed":
    case "review":
      return (
        <Result
          job={job}
          snapshot={snapshot}
          act={act}
          car={snapshot.train[job.id]}
          onAsk={onAsk}
          asked={snapshot.settings.chat.agent}
          unread={false}
          reviewer={reviewerOf(job, snapshot)}
          disabled={false}
          {...peek(job.id)}
          holding={holds(job, snapshot.jobs)}
        />
      );
    case "checkpoint":
      return (
        <Row
          leading={ICON.checkpoint}
          title={
            <button
              type="button"
              className="cursor-pointer truncate text-left underline-offset-4 hover:underline"
              onClick={() => onOpenGoal(job.id)}
            >
              {job.item.title}
            </button>
          }
          meta={job.why ?? "waiting for your approval"}
        >
          <Button variant="outline" size="sm" onClick={() => onOpenGoal(job.id)}>
            Open goal
          </Button>
          <Button size="sm" onClick={() => act(() => api.goal(job.id, "approve"))}>
            Approve
          </Button>
        </Row>
      );
    case "setup":
      return (
        <Row leading={ICON.setup} title={title} meta={job.why ?? "waiting for setup"}>
          <Button variant="outline" size="sm" onClick={() => act(() => api.retry(job.id))}>
            Retry now
          </Button>
        </Row>
      );
    case "assume":
      return (
        <Row
          leading={ICON.assume}
          title={title}
          below={
            <>
              <Said label={`assumed ${item.note.assumed}`}>{item.note.text}</Said>
              <AssumeAnswer job={job} index={item.note.index} act={act} />
            </>
          }
        >
          <Button size="sm" onClick={() => act(() => api.answer(job.id, "fine", item.note.index))}>
            <CheckIcon data-icon="inline-start" />
            Fine
          </Button>
        </Row>
      );
    case "unverified":
      return (
        <Row leading={ICON.unverified} title={title} meta={`Not verified: ${item.need}`}>
          <Button
            variant="outline"
            size="sm"
            onClick={() => act(() => api.verify(job.id, item.need))}
          >
            <CheckCheckIcon data-icon="inline-start" />
            Checked
          </Button>
        </Row>
      );
  }
}

import { useEffect, useState } from "react";
import { api, type Act } from "@/api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { repoName } from "@/format";

const NEW = { value: "new-project", label: "New project..." };

/** Starts a goal from a brief, in a repo or a new project, or from a plan written elsewhere. */
export function NewGoalDialog({
  act,
  open,
  onOpenChange,
  onCreated,
}: {
  act: Act;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (id: string) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>New goal</DialogTitle>
          <DialogDescription>
            A goal is one large task, planned into a graph of jobs. Nothing runs until you approve
            the plan.
          </DialogDescription>
        </DialogHeader>
        <Tabs defaultValue="brief">
          <TabsList>
            <TabsTrigger value="brief">From a brief</TabsTrigger>
            <TabsTrigger value="plan">Import a plan</TabsTrigger>
          </TabsList>
          <TabsContent value="brief">
            <BriefForm act={act} onCreated={onCreated} />
          </TabsContent>
          <TabsContent value="plan">
            <PlanForm act={act} onCreated={onCreated} />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

function BriefForm({ act, onCreated }: { act: Act; onCreated: (id: string) => void }) {
  const [listing, setListing] = useState<{ repos: string[]; root: string }>();
  const [title, setTitle] = useState("");
  const [repo, setRepo] = useState("");
  const [project, setProject] = useState("");
  const [brief, setBrief] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api.candidates().then(setListing);
  }, []);

  const creating = repo === NEW.value;
  const repos = (listing?.repos ?? []).map((path) => ({ value: path, label: repoName(path) }));
  const ready = title.trim() && (creating ? project.trim() : repo);
  const submit = () =>
    act(async () => {
      setBusy(true);
      try {
        const job = await api.newGoal({
          title,
          brief,
          ...(creating ? { project: project.trim() } : { repo }),
        });
        onCreated(job.id);
      } finally {
        setBusy(false);
      }
    });

  return (
    <FieldGroup className="mt-2">
      <Field>
        <FieldLabel htmlFor="goal-title">Title</FieldLabel>
        <Input
          id="goal-title"
          autoFocus
          placeholder="GPUI client for Tasks"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
      </Field>
      <Field>
        <FieldLabel>Repo</FieldLabel>
        <Select
          items={[...repos, NEW]}
          value={repo}
          onValueChange={(value) => setRepo(value ?? "")}
        >
          <SelectTrigger aria-label="Repo">
            <SelectValue placeholder="Pick a repo" />
          </SelectTrigger>
          <SelectContent alignItemWithTrigger={false}>
            <SelectGroup>
              {repos.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectGroup>
            <SelectSeparator />
            <SelectGroup>
              <SelectItem value={NEW.value}>{NEW.label}</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
        {creating && (
          <>
            <Input
              aria-label="Project name"
              placeholder="units"
              value={project}
              onChange={(event) => setProject(event.target.value)}
            />
            <FieldDescription>
              Creates {listing?.root}/{project.trim() || "<name>"} and a private GitHub repo of the
              same name.
            </FieldDescription>
          </>
        )}
      </Field>
      <Field>
        <FieldLabel htmlFor="goal-brief">Brief</FieldLabel>
        <Textarea
          id="goal-brief"
          className="min-h-48"
          placeholder="What done looks like, constraints, links to specs, and the commands that prove it works."
          value={brief}
          onChange={(event) => setBrief(event.target.value)}
        />
        <FieldDescription>
          Markdown. A communicator plans it into a graph, which waits for your approval here.
        </FieldDescription>
      </Field>
      <DialogFooter>
        <Button disabled={!ready || busy} onClick={submit}>
          Plan it
        </Button>
      </DialogFooter>
    </FieldGroup>
  );
}

function PlanForm({ act, onCreated }: { act: Act; onCreated: (id: string) => void }) {
  const [plan, setPlan] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = () =>
    act(async () => {
      setBusy(true);
      try {
        onCreated((await api.importPlan(plan)).id);
      } finally {
        setBusy(false);
      }
    });

  return (
    <FieldGroup className="mt-2">
      <Field>
        <FieldLabel htmlFor="goal-plan">Plan</FieldLabel>
        <Textarea
          id="goal-plan"
          className="min-h-64"
          placeholder='{ "format": "factory-plan/1", "goal": { ... }, "nodes": [ ... ] }'
          value={plan}
          onChange={(event) => setPlan(event.target.value)}
        />
        <FieldDescription>
          JSON or YAML in factory-plan/1, as in spec/plan-format.md. It's validated before anything
          changes.
        </FieldDescription>
      </Field>
      <DialogFooter>
        <Button disabled={!plan.trim() || busy} onClick={submit}>
          Import
        </Button>
      </DialogFooter>
    </FieldGroup>
  );
}

import { PlusIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { api, type Act } from "@/api";
import type { Blueprint } from "@/backend/types.ts";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { AnchoredDialogContent } from "@/components/variants/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ItemGroup } from "@/components/ui/item";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { repoName } from "@/format";
import { Row, Section } from "@/Row";

const FINDERS = [
  { value: "scan", label: "The whole repo, searched by the agent" },
  { value: "batch", label: "Batches of related code files" },
  { value: "batch tests", label: "Batches of related test files" },
];

const BLANK: Omit<Blueprint, "custom"> = {
  name: "",
  attention: "skim",
  description: "",
  finder: "scan",
  done: "",
  // A new blueprint runs where you send it, rather than adding a candidate to every repo.
  onRequest: true,
  prompt: "",
};

/** workwork's blueprints: yours to create, edit and delete, and every one to run on a repo. */
export function BlueprintsView({ act }: { act: Act }) {
  const [blueprints, setBlueprints] = useState<Blueprint[]>([]);
  const [repos, setRepos] = useState<string[]>([]);
  const [editing, setEditing] = useState<Blueprint>();
  const [saves, setSaves] = useState(0);

  useEffect(() => {
    void api.blueprints().then(setBlueprints);
  }, [saves]);
  useEffect(() => {
    void api.candidates().then((listing) => setRepos(listing.repos));
  }, []);

  const change = (run: () => Promise<unknown>) =>
    act(async () => {
      await run();
      setSaves((count) => count + 1);
    });

  const row = (blueprint: Blueprint) => (
    <Row
      key={blueprint.name}
      title={
        <button className="text-left hover:underline" onClick={() => setEditing(blueprint)}>
          {blueprint.name}
        </button>
      }
      meta={[
        blueprint.attention,
        blueprint.finder,
        blueprint.onRequest && "on request",
        blueprint.description,
      ]
        .filter(Boolean)
        .join(" · ")}
    >
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="outline" size="sm" />}>
          Run on…
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="max-h-80 w-auto">
          {repos.map((repo) => (
            <DropdownMenuItem
              key={repo}
              onClick={() => act(() => api.runBlueprint(blueprint.name, repo))}
            >
              {repoName(repo)}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {blueprint.custom && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            if (confirm(`Delete the blueprint ${blueprint.name}?`))
              void change(() => api.deleteBlueprint(blueprint.name));
          }}
        >
          Delete
        </Button>
      )}
    </Row>
  );

  const yours = blueprints.filter((blueprint) => blueprint.custom);
  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-muted-foreground">
        A blueprint is a reusable prompt that workwork turns into candidates in every repo. Running
        one on a repo queues what it finds there.
      </p>
      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-medium text-muted-foreground">Yours ({yours.length})</h2>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setEditing({ ...BLANK, custom: true })}
          >
            <PlusIcon /> New blueprint
          </Button>
        </div>
        {yours.length ? (
          <ItemGroup>{yours.map(row)}</ItemGroup>
        ) : (
          <p className="text-sm text-muted-foreground">None yet.</p>
        )}
      </section>
      <Section title="Built in">
        <ItemGroup>{blueprints.filter((blueprint) => !blueprint.custom).map(row)}</ItemGroup>
      </Section>
      {editing && (
        <BlueprintDialog
          blueprint={editing}
          onClose={() => setEditing(undefined)}
          onSave={(blueprint) =>
            change(async () => {
              await api.saveBlueprint(blueprint);
              setEditing(undefined);
            })
          }
        />
      )}
    </div>
  );
}

/** Creates or edits one of yours; a built-in one is shown read-only. */
function BlueprintDialog({
  blueprint,
  onClose,
  onSave,
}: {
  blueprint: Blueprint;
  onClose: () => void;
  onSave: (blueprint: Omit<Blueprint, "custom">) => void;
}) {
  const { custom, ...fields } = blueprint;
  const [draft, setDraft] = useState(fields);
  const set = (change: Partial<typeof draft>) => setDraft({ ...draft, ...change });
  const creating = blueprint.name === "";
  const finders = FINDERS.some(({ value }) => value === draft.finder)
    ? FINDERS
    : [...FINDERS, { value: draft.finder, label: draft.finder }];

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <AnchoredDialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{creating ? "New blueprint" : blueprint.name}</DialogTitle>
          <DialogDescription>
            {custom
              ? "Saved in your workwork folder, so every repo can use it."
              : "Built into workwork. A blueprint of yours with the same name replaces it."}
          </DialogDescription>
        </DialogHeader>
        <fieldset disabled={!custom} className="contents">
          <FieldGroup>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="blueprint-name">Name</FieldLabel>
                <Input
                  id="blueprint-name"
                  placeholder="naming"
                  disabled={!creating}
                  value={draft.name}
                  onChange={(event) => set({ name: event.target.value })}
                />
              </Field>
              <Field>
                <FieldLabel>Attention</FieldLabel>
                <ToggleGroup
                  variant="outline"
                  disabled={!custom}
                  value={[draft.attention]}
                  onValueChange={([attention]) => attention && set({ attention })}
                >
                  {["none", "skim", "decide"].map((value) => (
                    <ToggleGroupItem key={value} value={value}>
                      {value}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </Field>
            </div>
            <Field>
              <FieldLabel>Covers</FieldLabel>
              <Select
                items={finders}
                value={draft.finder}
                disabled={!custom}
                onValueChange={(finder) => finder && set({ finder })}
              >
                <SelectTrigger aria-label="Covers">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent alignItemWithTrigger={false}>
                  {finders.map(({ value, label }) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="blueprint-description">Description</FieldLabel>
              <Input
                id="blueprint-description"
                placeholder="One sentence on what it does"
                value={draft.description}
                onChange={(event) => set({ description: event.target.value })}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="blueprint-prompt">Prompt</FieldLabel>
              <Textarea
                id="blueprint-prompt"
                className="min-h-48"
                placeholder="What to look for and what to change."
                value={draft.prompt}
                onChange={(event) => set({ prompt: event.target.value })}
              />
              <FieldDescription>
                Markdown. workwork wraps it with the repo, the candidate, its checks and how to
                deliver.
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="blueprint-done">Done when</FieldLabel>
              <Input
                id="blueprint-done"
                placeholder="checks pass; each change names what it fixed"
                value={draft.done}
                onChange={(event) => set({ done: event.target.value })}
              />
            </Field>
            <Field orientation="horizontal">
              <Checkbox
                id="blueprint-on-request"
                checked={draft.onRequest}
                onCheckedChange={(onRequest) => set({ onRequest })}
              />
              <FieldLabel htmlFor="blueprint-on-request">
                Only when run on a repo, not in every repo's candidates
              </FieldLabel>
            </Field>
          </FieldGroup>
        </fieldset>
        {custom && (
          <DialogFooter>
            <Button
              disabled={!draft.name || !draft.prompt.trim() || !draft.done.trim()}
              onClick={() => onSave(draft)}
            >
              Save
            </Button>
          </DialogFooter>
        )}
      </AnchoredDialogContent>
    </Dialog>
  );
}

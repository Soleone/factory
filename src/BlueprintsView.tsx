import { PlusIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { confirm } from "@/Confirm";
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
import { RowGroup } from "@/components/variants/item";

const FINDERS = [
  { value: "scan", label: "The whole repo, searched by the agent" },
  { value: "batch", label: "Batches of related code files" },
  { value: "batch tests", label: "Batches of related test files" },
];

/** What workwork accepts as a blueprint's name. */
const NAME = /^[a-z0-9][a-z0-9-]*$/;
const slug = (title: string) =>
  title
    // Ü becomes u rather than a dash.
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

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
          onClick={async () => {
            if (
              await confirm({
                title: `Delete the blueprint ${blueprint.name}?`,
                description: "This can't be undone.",
                action: "Delete",
                destructive: true,
              })
            )
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
          <RowGroup>{yours.map(row)}</RowGroup>
        ) : (
          <p className="text-sm text-muted-foreground">None yet.</p>
        )}
      </section>
      <Section title="Built in">
        <RowGroup>{blueprints.filter((blueprint) => !blueprint.custom).map(row)}</RowGroup>
      </Section>
      {editing && (
        <BlueprintDialog
          blueprint={editing}
          onClose={() => setEditing(undefined)}
          onSave={async (blueprint) => {
            await api.saveBlueprint(blueprint);
            setEditing(undefined);
            setSaves((count) => count + 1);
          }}
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
  /** Rejects with what went wrong, which the dialog shows while keeping the draft. */
  onSave: (blueprint: Omit<Blueprint, "custom">) => Promise<void>;
}) {
  const { custom, ...fields } = blueprint;
  const [draft, setDraft] = useState(fields);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  /** The name was typed by hand, so the title no longer fills it in. */
  const [ownId, setOwnId] = useState(false);
  const set = (change: Partial<typeof draft>) => setDraft({ ...draft, ...change });
  const creating = blueprint.name === "";
  const badName = draft.name !== "" && !NAME.test(draft.name);

  const save = async () => {
    // Save stays clickable so a blank field gets named instead of the button just not reacting.
    const missing = [
      !draft.name && "Title",
      !draft.prompt.trim() && "Prompt",
      !draft.done.trim() && "Done when",
    ].filter(Boolean);
    if (missing.length) return setError(`Fill in ${missing.join(", ")}.`);
    if (badName) return setError("The name takes lowercase letters, digits and dashes only.");
    setSaving(true);
    setError(undefined);
    try {
      await onSave(draft);
    } catch (failure) {
      setError((failure as Error).message);
      setSaving(false);
    }
  };
  const close = async () => {
    const unsaved = JSON.stringify(draft) !== JSON.stringify(fields);
    if (
      !unsaved ||
      (await confirm({
        title: creating ? "Discard this blueprint?" : `Discard your changes to ${blueprint.name}?`,
        description: "What you wrote isn't saved yet.",
        action: "Discard",
        destructive: true,
      }))
    )
      onClose();
  };
  const finders = FINDERS.some(({ value }) => value === draft.finder)
    ? FINDERS
    : [...FINDERS, { value: draft.finder, label: draft.finder }];

  return (
    <Dialog open onOpenChange={(open) => !open && !saving && void close()}>
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
            <Field>
              <FieldLabel htmlFor="blueprint-title">Title</FieldLabel>
              {/* workwork calls it the description: what lists and tooltips show, never the agent. */}
              <Input
                id="blueprint-title"
                placeholder="Tidy up naming"
                value={draft.description}
                onChange={(event) =>
                  set({
                    description: event.target.value,
                    ...(creating && !ownId && { name: slug(event.target.value) }),
                  })
                }
              />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field data-invalid={badName}>
                <FieldLabel htmlFor="blueprint-name">Name</FieldLabel>
                <Input
                  id="blueprint-name"
                  placeholder="tidy-up-naming"
                  disabled={!creating}
                  aria-invalid={badName}
                  value={draft.name}
                  onChange={(event) => {
                    // Cleared, it follows the title again.
                    setOwnId(event.target.value !== "");
                    set({ name: event.target.value });
                  }}
                />
                {creating && (
                  <FieldDescription>
                    Made from the title. Lowercase letters, digits and dashes.
                  </FieldDescription>
                )}
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
          <DialogFooter className="items-center">
            {error && (
              <p role="alert" className="mr-auto text-sm whitespace-pre-line text-destructive">
                {error}
              </p>
            )}
            <Button disabled={saving} onClick={() => void save()}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        )}
      </AnchoredDialogContent>
    </Dialog>
  );
}

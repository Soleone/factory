import { type ComponentProps, useEffect, useState } from "react";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  GripVerticalIcon,
  PlusIcon,
  Settings2,
  XIcon,
} from "lucide-react";
import { api, type Act } from "@/api";
import {
  presetId,
  TIERS,
  type Preset,
  type Settings,
  type Snapshot,
  type Tier,
} from "@/backend/types.ts";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { AGENT_NAMES } from "@/backend/agents.ts";
import { agentName, repoName } from "@/format";
import { Choice, RunFields, TuningFields } from "@/RunFields";
import { version } from "../package.json";

/** A gear button that opens the defaults every run starts from, and what auto mode may queue. */
export function SettingsDialog({ snapshot, act }: { snapshot: Snapshot; act: Act }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="ghost" size="icon" aria-label="Settings" />}>
        <Settings2 />
      </DialogTrigger>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>
            Defaults for every run, and what auto mode may queue. Closing without saving discards
            changes.
          </DialogDescription>
        </DialogHeader>
        <SettingsForm snapshot={snapshot} act={act} onSaved={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}

/** Mounted only while the dialog is open, so every opening starts from the saved settings. */
function SettingsForm({
  snapshot,
  act,
  onSaved,
}: {
  snapshot: Snapshot;
  act: Act;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<Settings>(snapshot.settings);
  const [blueprints, setBlueprints] = useState<string[]>([]);
  const [repos, setRepos] = useState<string[]>([]);
  // The Auto switch in the header saves on its own; this form never changes it.
  const current = { ...draft, auto: { ...draft.auto, on: snapshot.settings.auto.on } };
  const unchanged = JSON.stringify(current) === JSON.stringify(snapshot.settings);

  useEffect(() => {
    void api.candidates().then((candidates) => {
      setRepos([...new Set(candidates.items.map((item) => item.repo))].sort());
    });
  }, [snapshot.candidates.at]);
  // On-request blueprints never reach the candidates auto mode picks from.
  useEffect(() => {
    void api.blueprints().then((all) =>
      setBlueprints(
        all
          .filter((each) => !each.onRequest)
          .map((each) => each.name)
          .sort(),
      ),
    );
  }, []);

  const auto = draft.auto;
  const setAuto = (change: Partial<Settings["auto"]>) =>
    setDraft({ ...draft, auto: { ...auto, ...change } });

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void act(async () => {
          await api.saveSettings(current);
          onSaved();
        });
      }}
    >
      <Tabs defaultValue="runs">
        <TabsList>
          <TabsTrigger value="runs">Runs</TabsTrigger>
          <TabsTrigger value="presets">Presets</TabsTrigger>
          <TabsTrigger value="tiers">Tiers</TabsTrigger>
          <TabsTrigger value="auto">Auto mode</TabsTrigger>
          <TabsTrigger value="chat">Live Agent</TabsTrigger>
        </TabsList>
        <div className="mt-2 grid">
          <StackedTabsContent value="runs">
            <FieldGroup>
              <RunFields value={draft} onChange={(run) => setDraft({ ...draft, ...run })} />
              <Field orientation="horizontal">
                <FieldLabel htmlFor="idle">
                  Minutes without a sign of life before an attempt times out
                </FieldLabel>
                <Input
                  id="idle"
                  type="number"
                  className="w-20"
                  min={1}
                  value={draft.idle}
                  onChange={(event) => setDraft({ ...draft, idle: Number(event.target.value) })}
                />
              </Field>
            </FieldGroup>
          </StackedTabsContent>
          <StackedTabsContent value="presets">
            <PresetFields
              value={draft.presets}
              onChange={(presets) => setDraft({ ...draft, presets })}
            />
          </StackedTabsContent>
          <StackedTabsContent value="tiers">
            <TierFields
              presets={draft.presets}
              value={draft.tiers}
              onChange={(tiers) => setDraft({ ...draft, tiers })}
            />
          </StackedTabsContent>
          <StackedTabsContent value="auto">
            <FieldGroup>
              <FieldDescription>
                While the factory is on, auto mode keeps up to 5 jobs per agent queued, cheapest
                attention first, and never queues a candidate that already had a job. An empty
                filter allows everything.
              </FieldDescription>
              <Field>
                <FieldLabel>Attention</FieldLabel>
                <ToggleGroup
                  multiple
                  variant="outline"
                  value={auto.attention}
                  onValueChange={(attention) => setAuto({ attention })}
                >
                  {["none", "skim", "decide"].map((value) => (
                    <ToggleGroupItem key={value} value={value}>
                      {value}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </Field>
              <Field>
                <FieldLabel>Blueprints</FieldLabel>
                <ToggleGroup
                  multiple
                  variant="outline"
                  className="flex-wrap"
                  value={auto.blueprints}
                  onValueChange={(blueprints) => setAuto({ blueprints })}
                >
                  {blueprints.map((blueprint) => (
                    <ToggleGroupItem key={blueprint} value={blueprint}>
                      {blueprint}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </Field>
              <Field>
                <FieldLabel>Repos</FieldLabel>
                <ToggleGroup
                  multiple
                  variant="outline"
                  className="flex-wrap"
                  value={auto.repos}
                  onValueChange={(repos) => setAuto({ repos })}
                >
                  {repos.map((repo) => (
                    <ToggleGroupItem key={repo} value={repo}>
                      {repoName(repo)}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </Field>
            </FieldGroup>
          </StackedTabsContent>
          <StackedTabsContent value="chat">
            <FieldGroup>
              <FieldDescription>
                The agent you plan the queue with. Changing it starts a new chat.
              </FieldDescription>
              <Field orientation="horizontal">
                <Choice
                  label="Chat agent"
                  className="w-24 flex-none"
                  items={AGENT_NAMES.map((name) => ({ value: name, label: agentName(name) }))}
                  value={draft.chat.agent}
                  onChange={(agent) => agent && setDraft({ ...draft, chat: { agent } })}
                />
                <TuningFields
                  agent={draft.chat.agent}
                  value={draft.chat}
                  onChange={(tuning) =>
                    setDraft({ ...draft, chat: { ...tuning, agent: draft.chat.agent } })
                  }
                />
              </Field>
            </FieldGroup>
          </StackedTabsContent>
        </div>
      </Tabs>
      <DialogFooter className="sm:items-center">
        <span className="text-xs text-muted-foreground sm:mr-auto">factory {version}</span>
        <Button type="submit" disabled={unchanged}>
          Save
        </Button>
      </DialogFooter>
    </form>
  );
}

/** The agents with a model and effort that the arrow next to Queue offers. */
function PresetFields({
  value,
  onChange,
}: {
  value: Preset[];
  onChange: (presets: Preset[]) => void;
}) {
  const set = (index: number, preset: Preset) =>
    onChange(value.map((each, at) => (at === index ? preset : each)));

  return (
    <FieldGroup>
      <FieldDescription>
        Queue a candidate with one of these from the arrow next to its Queue button. Tiers run on
        them too: workers is how many run at once (empty: one once a tier lists it), and k ctx the
        context size, in thousands of tokens, where the agent compacts (empty: 90 for Haiku, 200
        otherwise).
      </FieldDescription>
      {value.map((preset, index) => (
        <Field key={index} orientation="horizontal">
          <Choice
            label="Preset agent"
            className="w-24 flex-none"
            items={AGENT_NAMES.map((name) => ({ value: name, label: agentName(name) }))}
            value={preset.agent}
            onChange={(agent) => agent && set(index, { agent })}
          />
          <TuningFields
            agent={preset.agent}
            value={preset}
            onChange={(tuning) => set(index, { ...preset, ...tuning, agent: preset.agent })}
          />
          <Input
            aria-label="Workers"
            type="number"
            min={0}
            className="w-24"
            placeholder="workers"
            value={preset.workers ?? ""}
            onChange={(event) =>
              set(index, {
                ...preset,
                workers: event.target.value === "" ? undefined : Number(event.target.value),
              })
            }
          />
          <Input
            aria-label="Compact at, thousands of tokens"
            type="number"
            min={10}
            className="w-20"
            placeholder="k ctx"
            value={preset.compactAt ? preset.compactAt / 1000 : ""}
            onChange={(event) =>
              set(index, {
                ...preset,
                compactAt:
                  event.target.value === "" ? undefined : Number(event.target.value) * 1000,
              })
            }
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Remove preset"
            onClick={() => onChange(value.filter((_, at) => at !== index))}
          >
            <XIcon />
          </Button>
        </Field>
      ))}
      <Button
        type="button"
        variant="outline"
        className="self-start"
        onClick={() => onChange([...value, { agent: AGENT_NAMES[0] }])}
      >
        <PlusIcon /> Add preset
      </Button>
    </FieldGroup>
  );
}

/**
 * Every panel stays mounted in the same grid cell, so the dialog keeps the tallest panel's height
 * and its top never moves when switching tabs.
 */
function StackedTabsContent(props: ComponentProps<typeof TabsContent>) {
  return (
    <TabsContent
      keepMounted
      hidden={false}
      className="col-start-1 row-start-1 data-hidden:invisible"
      {...props}
    />
  );
}

const TIER_ABOUT: Record<Tier, string> = {
  communicator: "decomposition, UX, visual design, copy: anything judged by taste",
  builder: "architecture, foundations, tricky logic, reviews",
  grunt: "well-specified mechanical work",
};

/** Each tier's presets, tried in order: drag or use the arrows to reorder. */
function TierFields({
  presets,
  value,
  onChange,
}: {
  presets: Preset[];
  value: Settings["tiers"];
  onChange: (tiers: Settings["tiers"]) => void;
}) {
  const [dragging, setDragging] = useState<{ tier: Tier; index: number }>();
  const ids = presets.map(presetId);
  const set = (tier: Tier, list: string[]) => onChange({ ...value, [tier]: list });
  const move = (tier: Tier, from: number, to: number) => {
    const list = [...value[tier]];
    const [id] = list.splice(from, 1);
    list.splice(to, 0, id);
    set(tier, list);
  };
  return (
    <FieldGroup>
      <FieldDescription>
        A goal's node runs on the first preset of its tier whose usage limit isn't hit and that has
        a free worker. A tier with no presets here runs on the run's agents.
      </FieldDescription>
      {TIERS.map((tier) => {
        const list = value[tier];
        const free = ids.filter((id) => !list.includes(id));
        return (
          <Field key={tier}>
            <FieldLabel>
              {tier} <span className="font-normal text-muted-foreground">{TIER_ABOUT[tier]}</span>
            </FieldLabel>
            <ol className="flex flex-col gap-1">
              {list.map((id, index) => (
                <li
                  key={id}
                  draggable
                  onDragStart={() => setDragging({ tier, index })}
                  onDragOver={(event) => dragging?.tier === tier && event.preventDefault()}
                  onDrop={() => {
                    if (dragging?.tier === tier) move(tier, dragging.index, index);
                    setDragging(undefined);
                  }}
                  className="flex items-center gap-1 rounded-md border px-2 py-1 text-sm"
                >
                  <GripVerticalIcon className="size-4 cursor-grab text-muted-foreground" />
                  <span className="flex-1">
                    {index + 1}. {id}
                    {!ids.includes(id) && (
                      <span className="text-destructive"> (no such preset)</span>
                    )}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Move up"
                    disabled={index === 0}
                    onClick={() => move(tier, index, index - 1)}
                  >
                    <ArrowUpIcon />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Move down"
                    disabled={index === list.length - 1}
                    onClick={() => move(tier, index, index + 1)}
                  >
                    <ArrowDownIcon />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Remove from tier"
                    onClick={() =>
                      set(
                        tier,
                        list.filter((each) => each !== id),
                      )
                    }
                  >
                    <XIcon />
                  </Button>
                </li>
              ))}
            </ol>
            {free.length > 0 && (
              <Choice
                label={`Add a preset to ${tier}`}
                className="w-56"
                items={[
                  { value: "", label: "Add a preset…" },
                  ...free.map((id) => ({ value: id, label: id })),
                ]}
                value=""
                onChange={(id) => id && set(tier, [...list, id])}
              />
            )}
          </Field>
        );
      })}
    </FieldGroup>
  );
}

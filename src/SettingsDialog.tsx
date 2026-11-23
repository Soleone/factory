import { type ComponentProps, Fragment, useEffect, useState } from "react";
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
  USAGE_POOLS,
  type Preset,
  type Settings,
  type Snapshot,
  type Tier,
} from "@/backend/types.ts";
import { Button } from "@/components/ui/button";
import {
  Combobox,
  ComboboxChip,
  ComboboxChips,
  ComboboxChipsInput,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxValue,
  useComboboxAnchor,
} from "@/components/ui/combobox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { AnchoredDialogContent } from "@/components/variants/dialog";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { AGENT_NAMES } from "@/backend/agents.ts";
import { agentName, repoName } from "@/format";
import { Choice, RunFields, TuningFields } from "@/RunFields";
import { TierBadge } from "@/TierBadge";
import { version } from "../package.json";

/** A gear button that opens the defaults every run starts from, and what auto mode may queue. */
export function SettingsDialog({ snapshot, act }: { snapshot: Snapshot; act: Act }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="ghost" size="icon" aria-label="Settings" />}>
        <Settings2 />
      </DialogTrigger>
      <AnchoredDialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>
            Defaults for every run, and what may queue work on its own. Closing without saving
            discards changes.
          </DialogDescription>
        </DialogHeader>
        <SettingsForm snapshot={snapshot} act={act} onSaved={() => setOpen(false)} />
      </AnchoredDialogContent>
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
          <TabsTrigger value="triggers">Triggers</TabsTrigger>
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
              <ReserveFields
                value={draft.reserves}
                onChange={(reserves) => setDraft({ ...draft, reserves })}
              />
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
                <MultiPicker
                  items={blueprints}
                  value={auto.blueprints}
                  onChange={(blueprints) => setAuto({ blueprints })}
                  placeholder="All blueprints"
                  label={(blueprint) => blueprint}
                />
              </Field>
              <Field>
                <FieldLabel>Repos</FieldLabel>
                <MultiPicker
                  items={repos}
                  value={auto.repos}
                  onChange={(repos) => setAuto({ repos })}
                  placeholder="All repos"
                  label={repoName}
                />
              </Field>
            </FieldGroup>
          </StackedTabsContent>
          <StackedTabsContent value="triggers">
            <TriggerFields
              value={draft.triggers}
              onChange={(triggers) => setDraft({ ...draft, triggers })}
            />
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

/** The percent of each pool's 5-hour window kept for other apps on the account; empty keeps none. */
function ReserveFields({
  value,
  onChange,
}: {
  value: Settings["reserves"];
  onChange: (reserves: Settings["reserves"]) => void;
}) {
  const set = (pool: string, text: string) => {
    const reserves = { ...value };
    if (text === "") delete reserves[pool];
    else reserves[pool] = Number(text);
    onChange(reserves);
  };
  return (
    <FieldSet>
      <FieldLegend variant="label">Reserve</FieldLegend>
      <FieldDescription>
        Percent of a pool's 5-hour window to leave for other apps. Once it's reached, the pool
        starts nothing new until the window resets; jobs already running finish, so leave room for
        them.
      </FieldDescription>
      {USAGE_POOLS.map((pool) => (
        <Field key={pool} orientation="horizontal">
          <FieldLabel htmlFor={`reserve-${pool}`}>{pool}</FieldLabel>
          <Input
            id={`reserve-${pool}`}
            type="number"
            className="w-20"
            min={0}
            max={99}
            placeholder="none"
            value={value[pool] ?? ""}
            onChange={(event) => set(pool, event.target.value)}
          />
        </Field>
      ))}
    </FieldSet>
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
              <TierBadge tier={tier} />
              <span className="font-normal text-muted-foreground">{TIER_ABOUT[tier]}</span>
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

/** A searchable pick of many: chips for what's chosen, type to filter the rest. */
function MultiPicker({
  items,
  value,
  onChange,
  placeholder,
  label,
}: {
  items: string[];
  value: string[];
  onChange: (value: string[]) => void;
  placeholder: string;
  label: (item: string) => string;
}) {
  const anchor = useComboboxAnchor();
  return (
    <Combobox
      multiple
      autoHighlight
      items={items}
      value={value}
      onValueChange={onChange}
      itemToStringLabel={label}
    >
      <ComboboxChips ref={anchor}>
        <ComboboxValue>
          {(chosen: string[]) => (
            <Fragment>
              {chosen.map((item) => (
                <ComboboxChip key={item}>{label(item)}</ComboboxChip>
              ))}
              <ComboboxChipsInput placeholder={chosen.length ? "" : placeholder} />
            </Fragment>
          )}
        </ComboboxValue>
      </ComboboxChips>
      <ComboboxContent anchor={anchor}>
        <ComboboxEmpty>Nothing matches</ComboboxEmpty>
        <ComboboxList>
          {(item: string) => (
            <ComboboxItem key={item} value={item}>
              {label(item)}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}

function TriggerFields({
  value,
  onChange,
}: {
  value: Settings["triggers"];
  onChange: (triggers: Settings["triggers"]) => void;
}) {
  const set = (change: Partial<Settings["triggers"]>) => onChange({ ...value, ...change });
  return (
    <FieldGroup>
      <FieldDescription>
        While the factory is on, it checks GitHub every 5 minutes in the repos it has jobs in, and
        queues one job per event.
      </FieldDescription>
      <Field orientation="horizontal">
        <Switch id="ci" checked={value.ci} onCheckedChange={(ci) => set({ ci })} />
        <FieldLabel htmlFor="ci">CI failing on the default branch queues a fix</FieldLabel>
      </Field>
      <Field orientation="horizontal">
        <Switch
          id="reviews"
          checked={value.reviews}
          onCheckedChange={(reviews) => set({ reviews })}
        />
        <FieldLabel htmlFor="reviews">
          Your review or comment on a factory PR queues a job to address it
        </FieldLabel>
      </Field>
      <Field orientation="horizontal">
        <FieldLabel htmlFor="label">
          Open issues with this label queue a job (empty: none)
        </FieldLabel>
        <Input
          id="label"
          className="w-32"
          value={value.label}
          onChange={(event) => set({ label: event.target.value })}
        />
      </Field>
    </FieldGroup>
  );
}

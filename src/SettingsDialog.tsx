import { type ComponentProps, Fragment, useEffect, useState } from "react";
import { GripVerticalIcon, PlusIcon, Settings2, XIcon } from "lucide-react";
import { api, type Act } from "@/api";
import { ReorderHandle } from "@/ReorderHandle";
import {
  presetId,
  TIERS,
  workersOf,
  USAGE_POOLS,
  type CommitIdentity,
  type Preset,
  EXPANDER,
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
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { AGENT_NAMES } from "@/backend/agents.ts";
import { agentName, repoName } from "@/format";
import { ChatAgentFields, Choice, RunFields, TuningFields } from "@/RunFields";
import { TierBadge } from "@/TierBadge";
import { ProviderLogo, providerOf, useModelLabel, WorkerName } from "@/WorkerName";
import { version } from "../package.json";

/** A gear button that opens the defaults every run starts from, and what auto mode may queue. */
export function SettingsDialog({ snapshot, act }: { snapshot: Snapshot; act: Act }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="ghost" size="icon" aria-label="Settings" />}>
        <Settings2 />
      </DialogTrigger>
      <AnchoredDialogContent className="sm:max-w-2xl">
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
  const [saveError, setSaveError] = useState<string>();
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
          setSaveError(undefined);
          try {
            await api.saveSettings(current);
            onSaved();
          } catch (error) {
            setSaveError((error as Error).message);
          }
        });
      }}
    >
      <Tabs defaultValue="runs">
        <TabsList>
          <TabsTrigger value="runs">Runs</TabsTrigger>
          <TabsTrigger value="workers">Workers</TabsTrigger>
          <TabsTrigger value="roles">Roles</TabsTrigger>
          <TabsTrigger value="auto">Auto mode</TabsTrigger>
          <TabsTrigger value="github">GitHub</TabsTrigger>
          <TabsTrigger value="chat">Live Agent</TabsTrigger>
          <TabsTrigger value="images">Images</TabsTrigger>
        </TabsList>
        <div className="mt-2 grid">
          <StackedTabsContent value="runs">
            <FieldGroup>
              <RunFields value={draft} onChange={setDraft} />
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
          <StackedTabsContent value="workers">
            <WorkerFields
              value={draft.presets}
              onChange={(presets) => setDraft({ ...draft, presets })}
            />
          </StackedTabsContent>
          <StackedTabsContent value="roles">
            <RoleFields
              presets={draft.presets}
              value={draft.tiers}
              onChange={(tiers) => setDraft({ ...draft, tiers })}
            />
          </StackedTabsContent>
          <StackedTabsContent value="auto">
            <FieldGroup>
              <FieldDescription>
                While the factory is on, auto mode keeps up to 5 jobs per worker queued, cheapest
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
          <StackedTabsContent value="github">
            <FieldGroup>
              <CommitIdentityFields
                value={draft.commitIdentity ?? { name: "", email: "" }}
                onChange={(commitIdentity) => setDraft((draft) => ({ ...draft, commitIdentity }))}
              />
              <TriggerFields
                value={draft.triggers}
                onChange={(triggers) => setDraft({ ...draft, triggers })}
              />
            </FieldGroup>
          </StackedTabsContent>
          <StackedTabsContent value="chat">
            <FieldGroup>
              <FieldDescription>
                The agent new chats start with. Earlier chats keep the agent they started with.
              </FieldDescription>
              <ChatAgentFields
                value={draft.chat}
                onChange={(chat) => setDraft({ ...draft, chat })}
              />
            </FieldGroup>
          </StackedTabsContent>
          <StackedTabsContent value="images">
            <Field>
              <FieldLabel htmlFor="image-expander">How codex expands a short prompt</FieldLabel>
              <Textarea
                id="image-expander"
                className="min-h-32"
                placeholder={EXPANDER}
                value={draft.imageExpander ?? ""}
                onChange={(event) =>
                  setDraft({ ...draft, imageExpander: event.target.value || undefined })
                }
              />
              <FieldDescription>
                Used when an image prompt is expanded first. Empty uses the text shown.
              </FieldDescription>
            </Field>
          </StackedTabsContent>
        </div>
      </Tabs>
      {saveError && <FieldError>{saveError}</FieldError>}
      <DialogFooter className="sm:items-center">
        <span className="text-xs text-muted-foreground sm:mr-auto">factory {version}</span>
        <Button type="submit" disabled={unchanged}>
          Save
        </Button>
      </DialogFooter>
    </form>
  );
}

/** The workers, in the order they take queue work: drag to reorder. */
function WorkerFields({
  value,
  onChange,
}: {
  value: Preset[];
  onChange: (presets: Preset[]) => void;
}) {
  const [dragging, setDragging] = useState<number>();
  const set = (index: number, preset: Preset) =>
    onChange(value.map((each, at) => (at === index ? preset : each)));
  const move = (from: number, to: number) => {
    const list = [...value];
    const [preset] = list.splice(from, 1);
    list.splice(to, 0, preset);
    onChange(list);
  };

  return (
    <FieldGroup>
      <FieldDescription>
        The queue goes to the first free worker, top to bottom. The number is how many run at once
        (empty: 1); 0 keeps one for the arrow next to Queue only. k ctx is the context size, in
        thousands of tokens, where the agent compacts (empty: 90 for Haiku, 200 otherwise).
      </FieldDescription>
      <ol className="flex flex-col gap-2">
        {value.map((preset, index) => (
          <li
            key={index}
            onDragOver={(event) => dragging !== undefined && event.preventDefault()}
            onDrop={() => {
              if (dragging !== undefined && dragging !== index) move(dragging, index);
              setDragging(undefined);
            }}
            onDragEnd={() => setDragging(undefined)}
            className="grid grid-cols-[auto_5.5rem_minmax(0,1fr)_6.5rem_3.5rem_4.5rem_auto] items-center gap-2 *:w-full"
          >
            <span
              draggable
              onDragStart={(event) => {
                event.dataTransfer.setDragImage(event.currentTarget.closest("li")!, 0, 0);
                setDragging(index);
              }}
              className="relative flex cursor-grab touch-none justify-center text-muted-foreground pointer-coarse:after:absolute pointer-coarse:after:-inset-3"
            >
              <GripVerticalIcon className="size-4" />
            </span>
            <Choice
              label="Worker agent"
              className="w-full"
              items={AGENT_NAMES.map((name) => ({ value: name, label: agentName(name) }))}
              value={preset.agent}
              onChange={(agent) => agent && set(index, { agent, workers: preset.workers })}
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
              placeholder="1"
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
              aria-label="Remove worker"
              onClick={() => onChange(value.filter((_, at) => at !== index))}
            >
              <XIcon />
            </Button>
          </li>
        ))}
      </ol>
      <Button
        type="button"
        variant="outline"
        className="self-start"
        onClick={() => onChange([...value, { agent: AGENT_NAMES[0] }])}
      >
        <PlusIcon /> Add worker
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

/** The percent of each provider's 5-hour window kept for other apps on the account; empty keeps none. */
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
        Percent of a provider's 5-hour window to leave for other apps. Once it's reached, its
        workers start nothing new until the window resets; jobs already running finish, so leave
        room for them.
      </FieldDescription>
      {USAGE_POOLS.map((pool) => (
        <Field key={pool} orientation="horizontal">
          <FieldLabel htmlFor={`reserve-${pool}`}>
            <ProviderLogo pool={pool} />
            {providerOf(pool).name}
          </FieldLabel>
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

/** Each role's workers, tried in order. In code, roles are tiers. */
function RoleFields({
  presets,
  value,
  onChange,
}: {
  presets: Preset[];
  value: Settings["tiers"];
  onChange: (tiers: Settings["tiers"]) => void;
}) {
  const [dragging, setDragging] = useState<{ tier: Tier; index: number }>();
  const modelLabel = useModelLabel();
  const byId = new Map(presets.map((preset) => [presetId(preset), preset]));
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
        A role is a kind of work and the workers that do it, first choice on top. Goals give each
        node a role. A queue item can get one from the arrow next to Queue; without one it takes any
        free worker, as does a role with nothing listed. Only workers that run (a count above 0) can
        be added.
      </FieldDescription>
      {TIERS.map((tier) => {
        const list = value[tier];
        const free = presets.filter(
          (preset) => workersOf(preset) > 0 && !list.includes(presetId(preset)),
        );
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
                  onDragOver={(event) => dragging?.tier === tier && event.preventDefault()}
                  onDrop={() => {
                    if (dragging?.tier === tier) move(tier, dragging.index, index);
                    setDragging(undefined);
                  }}
                  onDragEnd={() => setDragging(undefined)}
                  className="flex items-center gap-1 rounded-md border px-2 py-1 text-sm"
                >
                  <ReorderHandle
                    label={`${id} in ${tier}`}
                    index={index}
                    count={list.length}
                    onMove={(target) => move(tier, index, target)}
                    grip={{
                      draggable: true,
                      onDragStart: (event) => {
                        event.dataTransfer.setDragImage(event.currentTarget.closest("li")!, 0, 0);
                        setDragging({ tier, index });
                      },
                    }}
                  />
                  <span className="flex min-w-0 flex-1 items-center gap-1.5">
                    {index + 1}.
                    {byId.has(id) ? (
                      <WorkerName of={byId.get(id)!} />
                    ) : (
                      <span className="text-destructive">{id} (no such worker)</span>
                    )}
                    {byId.has(id) && workersOf(byId.get(id)!) === 0 && (
                      <span className="text-muted-foreground">not running</span>
                    )}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Remove from role"
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
                label={`Add a worker to ${tier}`}
                className="w-56"
                items={[
                  { value: "", label: "Add a worker…" },
                  ...free.map((preset) => ({
                    value: presetId(preset),
                    label: [modelLabel(preset), preset.effort].filter(Boolean).join(" · "),
                  })),
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

function CommitIdentityFields({
  value,
  onChange,
}: {
  value: CommitIdentity;
  onChange: (identity: CommitIdentity) => void;
}) {
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string>();
  async function suggest() {
    setLoading(true);
    setMessage(undefined);
    try {
      onChange(await api.githubProfile());
      setMessage("Profile filled in. Review the fields, then Save to apply it.");
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setLoading(false);
    }
  }
  return (
    <FieldSet>
      <FieldLegend>Commit identity</FieldLegend>
      <FieldDescription>
        Used as author and committer in Factory worktrees. Leave both blank to use Git
        configuration.
      </FieldDescription>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="commit-name">Name</FieldLabel>
          <Input
            id="commit-name"
            value={value.name}
            disabled={loading}
            onChange={(event) => onChange({ ...value, name: event.target.value })}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="commit-email">Email</FieldLabel>
          <Input
            id="commit-email"
            inputMode="email"
            value={value.email}
            disabled={loading}
            onChange={(event) => onChange({ ...value, email: event.target.value })}
          />
        </Field>
      </div>
      <div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={loading}
          onClick={() => void suggest()}
        >
          {loading ? "Reading GitHub profile…" : "Use GitHub profile"}
        </Button>
        {message && (
          <FieldDescription role="status" className="mt-2">
            {message}
          </FieldDescription>
        )}
      </div>
    </FieldSet>
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

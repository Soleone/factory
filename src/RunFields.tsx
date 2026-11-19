import { useEffect, useState } from "react";
import { api } from "@/api";
import { AGENT_NAMES, EFFORTS } from "@/backend/agents.ts";
import type { Model, Settings, Tuning } from "@/backend/types.ts";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Combobox,
  ComboboxCollection,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxInput,
  ComboboxItem,
  ComboboxLabel,
  ComboboxList,
} from "@/components/ui/combobox";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldSet,
  FieldLegend,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export type Run = Pick<Settings, "agents" | "limit" | "until">;

const DEFAULT = "default";
const LIMITS = [
  { value: "1", label: "1, stop at the first" },
  { value: "2", label: "2, one reset" },
  { value: "3", label: "3, two resets" },
  { value: "none", label: "No limit" },
];

/** Which agents work, with which model and effort, and when they stop: for a run or as the defaults. */
export function RunFields({ value, onChange }: { value: Run; onChange: (run: Run) => void }) {
  const setAgent = (name: string, change: Settings["agents"][string] | undefined) => {
    const agents = { ...value.agents };
    if (change) agents[name] = change;
    else delete agents[name];
    onChange({ ...value, agents });
  };

  return (
    <FieldGroup>
      <FieldSet>
        <FieldLegend variant="label">Agents</FieldLegend>
        {AGENT_NAMES.map((name) => {
          const tuning = value.agents[name];
          return (
            <Field key={name} orientation="horizontal">
              <Checkbox
                id={`agent-${name}`}
                checked={tuning !== undefined}
                onCheckedChange={(checked) => setAgent(name, checked ? {} : undefined)}
              />
              <FieldLabel htmlFor={`agent-${name}`} className="w-14 flex-none!">
                {name}
              </FieldLabel>
              <TuningFields
                agent={name}
                value={tuning}
                onChange={(change) => setAgent(name, change)}
              />
            </Field>
          );
        })}
      </FieldSet>
      <Field orientation="horizontal">
        <FieldContent>
          <FieldLabel>Usage limit hits per agent</FieldLabel>
          <FieldDescription>Once every agent is out, the factory turns off.</FieldDescription>
        </FieldContent>
        <Select
          items={LIMITS}
          value={value.limit === null ? "none" : String(value.limit)}
          onValueChange={(limit) =>
            onChange({ ...value, limit: limit === "none" ? null : Number(limit) })
          }
        >
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {LIMITS.map((limit) => (
              <SelectItem key={limit.value} value={limit.value}>
                {limit.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field orientation="horizontal">
        <FieldContent>
          <FieldLabel htmlFor="until">Start nothing new after</FieldLabel>
          <FieldDescription>Leave empty to keep going.</FieldDescription>
        </FieldContent>
        <Input
          id="until"
          type="time"
          className="w-28"
          value={value.until ?? ""}
          onChange={(event) => onChange({ ...value, until: event.target.value || undefined })}
        />
      </Field>
    </FieldGroup>
  );
}

let models: Promise<Record<string, Model[]>> | undefined;

/** The short list of models each agent offers, asked once per page; empty until it arrives. */
function useModels(): Record<string, Model[]> {
  const [loaded, setLoaded] = useState<Record<string, Model[]>>({});
  useEffect(() => {
    models ??= api.models();
    // Ask again next time the settings open.
    models.then(setLoaded, () => (models = undefined));
  }, []);
  return loaded;
}

/** An agent's model and effort; unset (or no value at all, for an agent not picked) means its default. */
export function TuningFields({
  agent,
  value,
  onChange,
}: {
  agent: string;
  value: Tuning | undefined;
  onChange: (tuning: Tuning) => void;
}) {
  const offered = useModels()[agent] ?? [];
  const levels = (model?: string) =>
    offered.find((each) => each.value === model)?.efforts ?? EFFORTS[agent];
  const efforts = [{ value: DEFAULT, label: "Default effort" }].concat(
    levels(value?.model).map((effort) => ({ value: effort, label: effort })),
  );
  const unset = (choice: string | null) => (choice === DEFAULT ? undefined : (choice ?? undefined));
  // An effort the new model doesn't have goes back to the default.
  const pickModel = (choice: string) => {
    const model = unset(choice);
    const effort = value?.effort && levels(model).includes(value.effort) ? value.effort : undefined;
    onChange({ ...value, model, effort });
  };

  return (
    <>
      <ModelPicker
        label={`${agent} model`}
        offered={offered}
        disabled={!value}
        value={value?.model ?? DEFAULT}
        onChange={pickModel}
      />
      <Choice
        label={`${agent} effort`}
        items={efforts}
        disabled={!value}
        value={value?.effort ?? DEFAULT}
        onChange={(effort) => onChange({ ...value, effort: unset(effort) })}
      />
    </>
  );
}

type Group = { value: string; items: Model[] };

/** Searchable, since Pi knows hundreds of models: the default, then the agent's short list, then the rest. */
function ModelPicker({
  label,
  offered,
  disabled,
  value,
  onChange,
}: {
  label: string;
  offered: Model[];
  disabled: boolean;
  value: string;
  onChange: (value: string) => void;
}) {
  const top: Model[] = [{ value: DEFAULT, label: "Default model", efforts: [], scoped: true }];
  // A model saved before it left the list stays selectable.
  if (value !== DEFAULT && !offered.some((model) => model.value === value))
    top.push({ value, label: value, efforts: [], scoped: true });
  const groups: Group[] = [
    { value: "", items: top },
    { value: "Scoped", items: offered.filter((model) => model.scoped) },
    { value: "All models", items: offered.filter((model) => !model.scoped) },
  ].filter((group) => group.items.length > 0);
  const selected = groups.flatMap((group) => group.items).find((model) => model.value === value);

  return (
    <Combobox
      items={groups}
      disabled={disabled}
      value={selected}
      onValueChange={(model: Model | null) => model && onChange(model.value)}
      isItemEqualToValue={(item: Model, other: Model) => item.value === other.value}
      autoHighlight
      filter={(model: Model, query: string) =>
        query
          .toLowerCase()
          .split(/\s+/)
          .every((word) => `${model.label} ${model.value}`.toLowerCase().includes(word))
      }
    >
      {/* Selected on focus, so typing searches instead of appending to the model's name. */}
      <ComboboxInput
        aria-label={label}
        className="w-full min-w-0 flex-1"
        disabled={disabled}
        onFocus={(event) => event.target.select()}
      />
      <ComboboxContent className="min-w-72">
        <ComboboxEmpty>No model matches</ComboboxEmpty>
        <ComboboxList>
          {(group: Group) => (
            <ComboboxGroup key={group.value} items={group.items}>
              {group.value && <ComboboxLabel>{group.value}</ComboboxLabel>}
              <ComboboxCollection>
                {(model: Model) => (
                  <ComboboxItem key={model.value} value={model}>
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate">{model.label}</span>
                      {model.value !== DEFAULT && model.value !== model.label && (
                        <span className="truncate text-xs text-muted-foreground">
                          {model.value}
                        </span>
                      )}
                    </span>
                  </ComboboxItem>
                )}
              </ComboboxCollection>
            </ComboboxGroup>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}

export function Choice({
  label,
  className,
  items,
  disabled,
  value,
  onChange,
}: {
  label: string;
  className?: string;
  items: { value: string; label: string }[];
  disabled?: boolean;
  value: string;
  onChange: (value: string | null) => void;
}) {
  return (
    <Select items={items} disabled={disabled} value={value} onValueChange={onChange}>
      <SelectTrigger aria-label={label} className={className}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

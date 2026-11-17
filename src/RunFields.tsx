import { AGENT_NAMES, EFFORTS } from "@/backend/agents.ts";
import type { Settings } from "@/backend/types.ts";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Field,
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
  { value: "1", label: "1: stop at the first limit hit" },
  { value: "2", label: "2: continue after one reset" },
  { value: "3", label: "3: continue after two resets" },
  { value: "none", label: "None: wait for every reset" },
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
          const efforts = [{ value: DEFAULT, label: "Default effort" }].concat(
            EFFORTS[name].map((effort) => ({ value: effort, label: effort })),
          );
          return (
            <Field key={name} orientation="horizontal">
              <Checkbox
                id={`agent-${name}`}
                checked={tuning !== undefined}
                onCheckedChange={(checked) => setAgent(name, checked ? {} : undefined)}
              />
              <FieldLabel htmlFor={`agent-${name}`} className="w-14 flex-none">
                {name}
              </FieldLabel>
              <Input
                aria-label={`${name} model`}
                placeholder="default model"
                disabled={!tuning}
                value={tuning?.model ?? ""}
                onChange={(event) =>
                  setAgent(name, { ...tuning, model: event.target.value || undefined })
                }
              />
              <Select
                items={efforts}
                disabled={!tuning}
                value={tuning?.effort ?? DEFAULT}
                onValueChange={(effort) =>
                  setAgent(name, {
                    ...tuning,
                    effort: effort === DEFAULT ? undefined : (effort ?? undefined),
                  })
                }
              >
                <SelectTrigger aria-label={`${name} effort`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {efforts.map((effort) => (
                    <SelectItem key={effort.value} value={effort.value}>
                      {effort.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          );
        })}
      </FieldSet>
      <Field>
        <FieldLabel>Usage limit hits per agent</FieldLabel>
        <Select
          items={LIMITS}
          value={value.limit === null ? "none" : String(value.limit)}
          onValueChange={(limit) =>
            onChange({ ...value, limit: limit === "none" ? null : Number(limit) })
          }
        >
          <SelectTrigger>
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
        <FieldDescription>
          An agent out of limits stops; once every agent has stopped, the factory turns off.
        </FieldDescription>
      </Field>
      <Field>
        <FieldLabel htmlFor="until">Start nothing new after</FieldLabel>
        <Input
          id="until"
          type="time"
          value={value.until ?? ""}
          onChange={(event) => onChange({ ...value, until: event.target.value || undefined })}
        />
        <FieldDescription>Leave empty to keep going.</FieldDescription>
      </Field>
    </FieldGroup>
  );
}

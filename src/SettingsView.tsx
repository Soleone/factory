import { useEffect, useState } from "react";
import { api, type Act } from "@/api";
import type { Settings, Snapshot } from "@/backend/types.ts";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { repoName } from "@/format";
import { RunFields } from "@/RunFields";

/** The defaults every run starts from, and what auto mode may queue. */
export function SettingsView({ snapshot, act }: { snapshot: Snapshot; act: Act }) {
  const [draft, setDraft] = useState<Settings>(snapshot.settings);
  const [plays, setPlays] = useState<string[]>([]);
  const [repos, setRepos] = useState<string[]>([]);
  // The Auto switch in the header saves on its own; this form never changes it.
  const current = { ...draft, auto: { ...draft.auto, on: snapshot.settings.auto.on } };
  const saved = JSON.stringify(current) === JSON.stringify(snapshot.settings);

  useEffect(() => {
    void api.candidates().then((candidates) => {
      setPlays([...new Set(candidates.items.map((item) => item.play))].sort());
      setRepos([...new Set(candidates.items.map((item) => item.repo))].sort());
    });
  }, [snapshot.candidates.at]);

  const auto = draft.auto;
  return (
    <form
      className="flex max-w-xl flex-col gap-8 pt-2"
      onSubmit={(event) => {
        event.preventDefault();
        void act(() => api.saveSettings(current));
      }}
    >
      <RunFields value={draft} onChange={(run) => setDraft({ ...draft, ...run })} />
      <Field>
        <FieldLabel htmlFor="timeout">Minutes before an agent is stopped</FieldLabel>
        <Input
          id="timeout"
          type="number"
          min={1}
          value={draft.timeout}
          onChange={(event) => setDraft({ ...draft, timeout: Number(event.target.value) })}
        />
      </Field>
      <FieldSet>
        <FieldLegend>Auto mode</FieldLegend>
        <FieldDescription>
          While the factory is on, auto mode keeps up to 5 of its jobs per agent queued, taken from
          workwork, cheapest attention first. It never queues a candidate that already had a job.
        </FieldDescription>
        <FieldGroup>
          <Field>
            <FieldLabel>Levels</FieldLabel>
            <ToggleGroup
              multiple
              variant="outline"
              value={auto.levels}
              onValueChange={(levels) => setDraft({ ...draft, auto: { ...auto, levels } })}
            >
              {["auto", "skim", "decide"].map((level) => (
                <ToggleGroupItem key={level} value={level}>
                  {level}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </Field>
          <Field>
            <FieldLabel>Plays</FieldLabel>
            <ToggleGroup
              multiple
              variant="outline"
              className="flex-wrap"
              value={auto.plays}
              onValueChange={(chosen) => setDraft({ ...draft, auto: { ...auto, plays: chosen } })}
            >
              {plays.map((play) => (
                <ToggleGroupItem key={play} value={play}>
                  {play}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <FieldDescription>None selected means every play.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel>Repos</FieldLabel>
            <ToggleGroup
              multiple
              variant="outline"
              className="flex-wrap"
              value={auto.repos}
              onValueChange={(chosen) => setDraft({ ...draft, auto: { ...auto, repos: chosen } })}
            >
              {repos.map((repo) => (
                <ToggleGroupItem key={repo} value={repo}>
                  {repoName(repo)}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <FieldDescription>
              The repos workwork found. None selected means every repo.
            </FieldDescription>
          </Field>
        </FieldGroup>
      </FieldSet>
      <div className="flex gap-2">
        <Button type="submit" disabled={saved}>
          {saved ? "Saved" : "Save"}
        </Button>
        {!saved && (
          <Button type="button" variant="ghost" onClick={() => setDraft(snapshot.settings)}>
            Discard
          </Button>
        )}
      </div>
    </form>
  );
}

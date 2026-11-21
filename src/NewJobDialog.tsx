import { useEffect, useState } from "react";
import { api, type Act } from "@/api";
import { TIERS, type Tier } from "@/backend/types.ts";
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
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { repoName } from "@/format";

/** Queues one job of the user's own: a prompt for a tier, in a repo, without workwork. */
export function NewJobDialog({
  act,
  open,
  onOpenChange,
}: {
  act: Act;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [repos, setRepos] = useState<string[]>([]);
  const [repo, setRepo] = useState("");
  const [tier, setTier] = useState<Tier>("builder");
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");

  useEffect(() => {
    if (open) void api.candidates().then((listing) => setRepos(listing.repos));
  }, [open]);

  const submit = () =>
    act(async () => {
      await api.ownJob({ repo, tier, title, prompt });
      setTitle("");
      setPrompt("");
      onOpenChange(false);
    });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>New job</DialogTitle>
          <DialogDescription>
            One task of your own, for a single agent. It goes into your picks, ahead of auto jobs.
          </DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel>Repo</FieldLabel>
              <Select
                items={repos.map((path) => ({ value: path, label: repoName(path) }))}
                value={repo}
                onValueChange={(value) => setRepo(value ?? "")}
              >
                <SelectTrigger aria-label="Repo">
                  <SelectValue placeholder="Pick a repo" />
                </SelectTrigger>
                <SelectContent alignItemWithTrigger={false}>
                  {repos.map((path) => (
                    <SelectItem key={path} value={path}>
                      {repoName(path)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel>Tier</FieldLabel>
              <Select
                items={TIERS.map((value) => ({ value, label: value }))}
                value={tier}
                onValueChange={(value) => value && setTier(value)}
              >
                <SelectTrigger aria-label="Tier">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent alignItemWithTrigger={false}>
                  {TIERS.map((value) => (
                    <SelectItem key={value} value={value}>
                      {value}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
          <Field>
            <FieldLabel htmlFor="job-title">Title</FieldLabel>
            <Input
              id="job-title"
              placeholder="The prompt's first line"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="job-prompt">Prompt</FieldLabel>
            <Textarea
              id="job-prompt"
              autoFocus
              className="min-h-64"
              placeholder="What to do, where, how to check it, and what not to touch."
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
            />
            <FieldDescription>
              Markdown. The agent gets it as written, in a fresh worktree of the repo's default
              branch.
            </FieldDescription>
          </Field>
          <DialogFooter>
            <Button disabled={!repo || !prompt.trim()} onClick={submit}>
              Queue it
            </Button>
          </DialogFooter>
        </FieldGroup>
      </DialogContent>
    </Dialog>
  );
}

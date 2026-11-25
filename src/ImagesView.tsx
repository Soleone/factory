import { useState, type ClipboardEvent } from "react";
import { ImagePlusIcon, RotateCcwIcon, Trash2Icon, XIcon } from "lucide-react";
import { api, type Act } from "@/api";
import type { ImageRun, Snapshot } from "@/backend/types.ts";
import type { AgentImage } from "@/components/soleone/agent";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/soleone/tooltip/tooltip";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { AnchoredDialogContent } from "@/components/variants/dialog";
import { confirm } from "@/Confirm";
import { ago, repoName } from "@/format";

const NO_PROJECT = "none";
const imageUrl = (run: ImageRun, file: string) => `/images/${run.id}/${file}`;

/** Image prompts for codex, and what it made of each: generated outside every repo, to pick from. */
export function ImagesView({
  snapshot,
  act,
  projects,
}: {
  snapshot: Snapshot;
  act: Act;
  projects: string[];
}) {
  const [references, setReferences] = useState<AgentImage[]>([]);
  const [shown, setShown] = useState<{ run: ImageRun; file: string }>();
  const run = shown && snapshot.images.find((each) => each.id === shown.run.id);

  return (
    <div className="flex flex-col gap-8 pt-2">
      <ImageForm
        act={act}
        projects={projects}
        references={references}
        onReferencesChange={setReferences}
      />
      {snapshot.images.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No images yet</EmptyTitle>
            <EmptyDescription>What codex generates shows up here.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="flex flex-col gap-6">
          {snapshot.images.map((each) => (
            <RunCard
              key={each.id}
              run={each}
              act={act}
              onOpen={(file) => setShown({ run: each, file })}
            />
          ))}
        </div>
      )}
      <Dialog open={run !== undefined} onOpenChange={(open) => !open && setShown(undefined)}>
        {run && shown && (
          <ImageDialog
            key={`${run.id}/${shown.file}`}
            run={run}
            file={shown.file}
            act={act}
            onReference={async () => {
              setReferences([...references, await fetchImage(imageUrl(run, shown.file))]);
              setShown(undefined);
              window.scrollTo({ top: 0, behavior: "smooth" });
            }}
          />
        )}
      </Dialog>
    </div>
  );
}

function ImageForm({
  act,
  projects,
  references,
  onReferencesChange,
}: {
  act: Act;
  projects: string[];
  references: AgentImage[];
  onReferencesChange: (references: AgentImage[]) => void;
}) {
  const [repo, setRepo] = useState(NO_PROJECT);
  const [prompt, setPrompt] = useState("");
  const [expand, setExpand] = useState(true);
  const [variants, setVariants] = useState(1);
  const [pasteError, setPasteError] = useState<string>();

  function paste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = [...event.clipboardData.files].filter((file) => file.type.startsWith("image/"));
    if (files.length === 0) return;
    event.preventDefault();
    setPasteError(undefined);
    Promise.all(files.map(readImage)).then(
      (pasted) => onReferencesChange([...references, ...pasted]),
      () => setPasteError("Could not read the pasted image."),
    );
  }

  const submit = () =>
    act(async () => {
      await api.generateImages({
        prompt,
        repo: repo === NO_PROJECT ? undefined : repo,
        expand,
        variants,
        references,
      });
      setPrompt("");
      onReferencesChange([]);
    });

  return (
    <FieldGroup>
      <Field>
        <FieldLabel htmlFor="image-prompt">Prompt</FieldLabel>
        <Textarea
          id="image-prompt"
          className="min-h-24"
          placeholder="What to draw. Paste images here to use them as references."
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onPaste={paste}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && prompt.trim())
              void submit();
          }}
        />
        {references.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {references.map((image, index) => (
              <div key={index} className="relative">
                <img
                  src={`data:${image.mimeType};base64,${image.data}`}
                  alt={`Reference ${index + 1}`}
                  className="size-14 rounded-md border object-cover"
                />
                <Button
                  variant="secondary"
                  size="icon-xs"
                  className="absolute -top-1.5 -right-1.5"
                  aria-label={`Remove reference ${index + 1}`}
                  onClick={() => onReferencesChange(references.filter((each) => each !== image))}
                >
                  <XIcon />
                </Button>
              </div>
            ))}
          </div>
        )}
        <FieldDescription>{pasteError ?? "Ctrl+Enter generates."}</FieldDescription>
      </Field>
      <div className="flex flex-wrap items-end gap-x-6 gap-y-4">
        <Field className="w-56">
          <FieldLabel>Project</FieldLabel>
          <Select
            items={[
              { value: NO_PROJECT, label: "No project" },
              ...projects.map((path) => ({ value: path, label: repoName(path) })),
            ]}
            value={repo}
            onValueChange={(value) => setRepo(value ?? NO_PROJECT)}
          >
            <SelectTrigger aria-label="Project">
              <SelectValue />
            </SelectTrigger>
            <SelectContent alignItemWithTrigger={false}>
              <SelectItem value={NO_PROJECT}>No project</SelectItem>
              {projects.map((path) => (
                <SelectItem key={path} value={path}>
                  {repoName(path)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field className="w-auto">
          <FieldLabel>Variants of each</FieldLabel>
          <ToggleGroup
            variant="outline"
            value={[String(variants)]}
            onValueChange={(value) => value[0] && setVariants(Number(value[0]))}
          >
            {["1", "2", "3", "4"].map((value) => (
              <ToggleGroupItem key={value} value={value} aria-label={`${value} variants`}>
                {value}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </Field>
        <Field orientation="horizontal" className="w-auto">
          <Switch id="image-expand" checked={expand} onCheckedChange={setExpand} />
          <FieldLabel htmlFor="image-expand">Expand the prompt first</FieldLabel>
        </Field>
        <Button className="ml-auto" disabled={!prompt.trim()} onClick={submit}>
          <ImagePlusIcon /> Generate
        </Button>
      </div>
    </FieldGroup>
  );
}

function RunCard({
  run,
  act,
  onOpen,
}: {
  run: ImageRun;
  act: Act;
  onOpen: (file: string) => void;
}) {
  const groups = new Map<string, ImageRun["images"]>();
  for (const image of run.images)
    groups.set(image.name, [...(groups.get(image.name) ?? []), image]);
  const remove = async () => {
    if (
      await confirm({
        title: "Delete these images?",
        description: "The prompt and every image it made are deleted.",
        action: "Delete",
        destructive: true,
      })
    )
      await act(() => api.removeImages(run.id));
  };

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <p className="line-clamp-3 text-sm whitespace-pre-line">{run.prompt}</p>
          <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <StateBadge run={run} />
            {run.repo && <span>{repoName(run.repo)}</span>}
            <span>{ago(run.added)}</span>
            {run.variants > 1 && <span>{run.variants} variants each</span>}
          </p>
        </div>
        {(run.state === "done" || run.state === "failed") && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Generate again"
                  onClick={() => act(() => api.retryImages(run.id))}
                />
              }
            >
              <RotateCcwIcon />
            </TooltipTrigger>
            <TooltipContent>Generate again</TooltipContent>
          </Tooltip>
        )}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Delete"
                disabled={run.state === "running"}
                onClick={remove}
              />
            }
          >
            <Trash2Icon />
          </TooltipTrigger>
          <TooltipContent>Delete</TooltipContent>
        </Tooltip>
      </div>
      {run.error && (
        <p className="text-sm wrap-anywhere whitespace-pre-line text-destructive">{run.error}</p>
      )}
      {run.brief && (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">Expanded prompt</summary>
          <p className="mt-2 whitespace-pre-line">{run.brief}</p>
        </details>
      )}
      {(run.state === "queued" || run.state === "running") && (
        <div className="flex flex-wrap gap-2">
          {Array.from({ length: run.variants }, (_, index) => (
            <Skeleton key={index} className="size-40" />
          ))}
        </div>
      )}
      {[...groups].map(([name, images]) => (
        <div key={name} className="flex flex-col gap-1.5">
          {name && groups.size > 1 && <p className="text-xs text-muted-foreground">{name}</p>}
          <div className="flex flex-wrap gap-2">
            {images.map((image) => (
              <button
                key={image.file}
                type="button"
                className="overflow-hidden rounded-lg border focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                aria-label={`Open ${name || image.file}`}
                onClick={() => onOpen(image.file)}
              >
                <img
                  src={imageUrl(run, image.file)}
                  alt={name}
                  loading="lazy"
                  className="size-40 object-cover"
                />
              </button>
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}

function StateBadge({ run }: { run: ImageRun }) {
  if (run.state === "running")
    return (
      <Badge variant="outline">
        <Spinner /> generating
      </Badge>
    );
  if (run.state === "queued") return <Badge variant="outline">queued</Badge>;
  if (run.state === "failed") return <Badge variant="destructive">failed</Badge>;
  return null;
}

/** One image large, with what to do with it: open it, reuse it as a reference, or add it to the project. */
function ImageDialog({
  run,
  file,
  act,
  onReference,
}: {
  run: ImageRun;
  file: string;
  act: Act;
  onReference: () => Promise<void>;
}) {
  const image = run.images.find((each) => each.file === file);
  const [where, setWhere] = useState("");
  const [queued, setQueued] = useState(false);

  return (
    <AnchoredDialogContent className="sm:max-w-4xl">
      <DialogHeader>
        <DialogTitle>{image?.name || "Image"}</DialogTitle>
      </DialogHeader>
      <a href={imageUrl(run, file)} target="_blank" rel="noreferrer">
        <img
          src={imageUrl(run, file)}
          alt={image?.name ?? ""}
          className="mx-auto max-h-[60dvh] rounded-lg object-contain"
        />
      </a>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" onClick={() => act(onReference)}>
          Use as reference
        </Button>
        <Button
          variant="outline"
          render={<a href={imageUrl(run, file)} download={`${run.id}-${file}`} />}
        >
          Download
        </Button>
      </div>
      {run.repo && (
        <Field>
          <FieldLabel htmlFor="image-where">Add to {repoName(run.repo)}</FieldLabel>
          <div className="flex gap-2">
            <Input
              id="image-where"
              placeholder="Where it goes and what uses it (optional)"
              value={where}
              onChange={(event) => setWhere(event.target.value)}
            />
            <Button
              disabled={queued}
              onClick={() =>
                act(async () => {
                  await api.useImage(run.id, file, where);
                  setQueued(true);
                })
              }
            >
              {queued ? "Queued" : "Queue job"}
            </Button>
          </div>
          <FieldDescription>
            A grunt job copies it into the project and opens a PR. Until then it stays out of the
            repo.
          </FieldDescription>
        </Field>
      )}
    </AnchoredDialogContent>
  );
}

function readImage(file: Blob) {
  return new Promise<AgentImage>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = reader.result as string;
      resolve({ mimeType: file.type, data: url.slice(url.indexOf(",") + 1) });
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function fetchImage(url: string) {
  return readImage(await (await fetch(url)).blob());
}

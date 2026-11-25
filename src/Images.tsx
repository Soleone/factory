import { createContext, useContext, useState, type ClipboardEvent } from "react";
import { ImagePlusIcon, XIcon } from "lucide-react";
import { api, type Act } from "@/api";
import { IMAGE_AGENT } from "@/backend/agents.ts";
import { workersOf, type Job, type MadeImage, type Snapshot } from "@/backend/types.ts";
import type { AgentImage } from "@/components/soleone/agent";
import { Button } from "@/components/ui/button";
import { Dialog, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { AnchoredDialogContent } from "@/components/variants/dialog";
import { repoName } from "@/format";

const NO_PROJECT = "none";
const imageUrl = (job: Job, file: string) => `/images/${job.id}/${file}`;
/** Every image the job's attempts made, oldest first. */
const madeBy = (job: Job) => job.attempts.flatMap((attempt) => attempt.images ?? []);

/** Starts a new image job with this image as a reference; absent where Add work isn't at hand. */
export const UseAsReference = createContext<((image: AgentImage) => void) | undefined>(undefined);

/** A result row's look at what an image job made: its latest images, small. */
export function Thumbnails({ job }: { job: Job }) {
  const latest = job.attempts.findLast((attempt) => attempt.images?.length)?.images ?? [];
  if (latest.length === 0) return null;
  return (
    <div className="flex gap-1.5 pt-1.5">
      {latest.map((image) => (
        <img
          key={image.file}
          src={imageUrl(job, image.file)}
          alt={image.name}
          loading="lazy"
          className="size-14 rounded-md border object-cover"
        />
      ))}
    </div>
  );
}

/** Everything an image job made, by what it shows, each opening large. */
export function Gallery({ job, act }: { job: Job; act: Act }) {
  const [shown, setShown] = useState<string>();
  const onReference = useContext(UseAsReference);
  const { variants } = job.image!;
  const brief = job.attempts.findLast((attempt) => attempt.brief)?.brief;
  const groups = new Map<string, MadeImage[]>();
  for (const image of madeBy(job))
    groups.set(image.name, [...(groups.get(image.name) ?? []), image]);

  return (
    <div className="flex flex-col gap-4 pb-3">
      {brief && (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">Expanded prompt</summary>
          <p className="mt-2 whitespace-pre-line">{brief}</p>
        </details>
      )}
      {job.state === "running" && (
        <div className="flex flex-wrap gap-2">
          {Array.from({ length: variants }, (_, index) => (
            <Skeleton key={index} className="size-40" />
          ))}
        </div>
      )}
      {groups.size === 0 && job.state !== "running" && (
        <p className="text-sm text-muted-foreground">No images yet.</p>
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
                onClick={() => setShown(image.file)}
              >
                <img
                  src={imageUrl(job, image.file)}
                  alt={name}
                  loading="lazy"
                  className="size-40 object-cover"
                />
              </button>
            ))}
          </div>
        </div>
      ))}
      <Dialog open={shown !== undefined} onOpenChange={(open) => !open && setShown(undefined)}>
        {shown && (
          <ImageDialog
            key={shown}
            job={job}
            file={shown}
            act={act}
            onReference={
              onReference &&
              (async () => {
                onReference(await fetchImage(imageUrl(job, shown)));
                setShown(undefined);
              })
            }
          />
        )}
      </Dialog>
    </div>
  );
}

/** Queues an image job for codex workers. */
export function ImageForm({
  snapshot,
  act,
  projects,
  references,
  onReferencesChange,
  onQueued,
}: {
  snapshot: Snapshot;
  act: Act;
  projects: string[];
  references: AgentImage[];
  onReferencesChange: (references: AgentImage[]) => void;
  onQueued: () => void;
}) {
  const [repo, setRepo] = useState(NO_PROJECT);
  const [prompt, setPrompt] = useState("");
  const [expand, setExpand] = useState(true);
  const [variants, setVariants] = useState(1);
  const [pasteError, setPasteError] = useState<string>();
  const codexWorkers = snapshot.settings.presets.some(
    (preset) => preset.agent === IMAGE_AGENT && workersOf(preset) > 0,
  );
  const when = !codexWorkers
    ? "Add a codex worker under Settings, Workers to run them."
    : snapshot.on
      ? "A codex worker takes it from the queue."
      : "They run while the factory is on.";

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
      onReferencesChange([]);
      onQueued();
    });

  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-muted-foreground">
        Images from codex, kept outside the repo until you add one. They show under Results. {when}
      </p>
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
          <FieldDescription>{pasteError ?? "Ctrl+Enter queues it."}</FieldDescription>
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
            <ImagePlusIcon /> Queue
          </Button>
        </div>
      </FieldGroup>
    </div>
  );
}

/** One image large, with what to do with it: open it, reuse it as a reference, or add it to the project. */
function ImageDialog({
  job,
  file,
  act,
  onReference,
}: {
  job: Job;
  file: string;
  act: Act;
  onReference?: () => Promise<void>;
}) {
  const image = madeBy(job).find((each) => each.file === file);
  const [where, setWhere] = useState("");
  const [queued, setQueued] = useState(false);

  return (
    <AnchoredDialogContent className="sm:max-w-4xl">
      <DialogHeader>
        <DialogTitle>{image?.name || "Image"}</DialogTitle>
      </DialogHeader>
      <a href={imageUrl(job, file)} target="_blank" rel="noreferrer">
        <img
          src={imageUrl(job, file)}
          alt={image?.name ?? ""}
          className="mx-auto max-h-[60dvh] rounded-lg object-contain"
        />
      </a>
      <div className="flex flex-wrap items-center gap-2">
        {onReference && (
          <Button variant="outline" onClick={() => act(onReference)}>
            Use as reference
          </Button>
        )}
        <Button
          variant="outline"
          render={<a href={imageUrl(job, file)} download={`${job.id}-${file}`} />}
        >
          Download
        </Button>
      </div>
      {job.item.repo && (
        <Field>
          <FieldLabel htmlFor="image-where">Add to {repoName(job.item.repo)}</FieldLabel>
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
                  await api.useImage(job.id, file, where);
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

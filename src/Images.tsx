import {
  createContext,
  useContext,
  useState,
  type ClipboardEvent,
  type ComponentProps,
} from "react";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  DownloadIcon,
  FolderInputIcon,
  ImagePlusIcon,
  XIcon,
} from "lucide-react";
import { api, type Act } from "@/api";
import { IMAGE_AGENT } from "@/backend/agents.ts";
import { workersOf, type Job, type MadeImage, type Snapshot } from "@/backend/types.ts";
import type { AgentImage } from "@/components/soleone/agent";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/soleone/tooltip/tooltip";
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

/** The latest attempt's images, each `size` across. */
export function Thumbnails({ job, size }: { job: Job; size: string }) {
  const latest = job.attempts.findLast((attempt) => attempt.images?.length)?.images ?? [];
  if (latest.length === 0) return null;
  return (
    <span className="flex shrink-0 gap-1">
      {latest.map((image) => (
        <img
          key={image.file}
          src={imageUrl(job, image.file)}
          alt={image.name}
          loading="lazy"
          className={`${size} rounded-sm border object-cover`}
        />
      ))}
    </span>
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
              (async (file) => {
                onReference(await fetchImage(imageUrl(job, file)));
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

/**
 * One image large, arrows or the side buttons browsing the job's others, with one bar of what to
 * do with it: reuse it as a reference, download it, or add it to the project.
 */
function ImageDialog({
  job,
  file,
  act,
  onReference,
}: {
  job: Job;
  file: string;
  act: Act;
  onReference?: (file: string) => Promise<void>;
}) {
  const images = madeBy(job);
  const [index, setIndex] = useState(() => images.findIndex((each) => each.file === file));
  const [where, setWhere] = useState("");
  const [queued, setQueued] = useState<string[]>([]);
  const image = images[index];
  const url = imageUrl(job, image.file);
  const project = job.item.repo && repoName(job.item.repo);
  const move = (by: number) => {
    setIndex((at) => (at + by + images.length) % images.length);
    setWhere("");
  };

  return (
    <AnchoredDialogContent
      className="sm:max-w-4xl"
      onKeyDown={(event) => {
        if (event.altKey || event.ctrlKey || event.metaKey) return;
        // The details dialog behind listens for number keys on the document to switch tabs.
        if (/^[1-9]$/.test(event.key)) event.stopPropagation();
        if ((event.target as HTMLElement).closest("input")) return;
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          event.preventDefault();
          move(event.key === "ArrowLeft" ? -1 : 1);
        }
      }}
    >
      <DialogHeader>
        <DialogTitle>
          {image.name || "Image"}
          {images.length > 1 && (
            <span
              role="status"
              className="ml-2 text-sm font-normal text-muted-foreground tabular-nums"
            >
              {index + 1} / {images.length}
            </span>
          )}
        </DialogTitle>
      </DialogHeader>
      {/* A fixed height, so the bar below stays put while browsing images of other shapes. */}
      <div className="relative flex h-[60dvh] items-center justify-center">
        <a href={url} target="_blank" rel="noreferrer" className="contents">
          <img
            src={url}
            alt={image.name}
            className="max-h-full max-w-full rounded-lg object-contain"
          />
        </a>
        {images.length > 1 && (
          <>
            <Button
              variant="outline"
              size="icon"
              aria-label="Previous image"
              className="absolute left-0"
              onClick={() => move(-1)}
            >
              <ChevronLeftIcon />
            </Button>
            <Button
              variant="outline"
              size="icon"
              aria-label="Next image"
              className="absolute right-0"
              onClick={() => move(1)}
            >
              <ChevronRightIcon />
            </Button>
          </>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {onReference && (
          <IconAction label="Use as reference" onClick={() => act(() => onReference(image.file))}>
            <ImagePlusIcon />
          </IconAction>
        )}
        <IconAction label="Download" render={<a href={url} download={`${job.id}-${image.file}`} />}>
          <DownloadIcon />
        </IconAction>
        {project && (
          <>
            <Input
              aria-label={`Where it goes in ${project}`}
              // A phone gives it a row of its own, above the buttons.
              className="flex-1 max-sm:order-first max-sm:basis-full"
              placeholder="Where it goes and what uses it (optional)"
              value={where}
              onChange={(event) => setWhere(event.target.value)}
            />
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    disabled={queued.includes(image.file)}
                    onClick={() =>
                      act(async () => {
                        await api.useImage(job.id, image.file, where);
                        setQueued((files) => [...files, image.file]);
                      })
                    }
                  />
                }
              >
                <FolderInputIcon data-icon="inline-start" />
                {queued.includes(image.file) ? "Queued" : `Add to ${project}`}
              </TooltipTrigger>
              <TooltipContent>
                A grunt job copies it into {project} and opens a PR. Until then it stays out of the
                repo.
              </TooltipContent>
            </Tooltip>
          </>
        )}
      </div>
    </AnchoredDialogContent>
  );
}

function IconAction({ label, ...props }: { label: string } & ComponentProps<typeof Button>) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={<Button variant="outline" size="icon" aria-label={label} {...props} />}
      />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
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

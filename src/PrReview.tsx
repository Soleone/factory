import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import Markdown, { type MarkdownToJSX } from "markdown-to-jsx/react";
import { Children, isValidElement, useEffect, useRef, useState, type ComponentProps } from "react";
import { api } from "@/api";
import { Button } from "@/components/ui/button";
import { Dialog, DialogTitle } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { TabbedDialogContent } from "@/components/variants/dialog";
import { diffRows } from "@/diff";

const LINK_PROPS = {
  className: "underline underline-offset-4",
  target: "_blank",
  rel: "noreferrer",
};

/** GitHub-flavored PR bodies, styled with the theme since the page has no prose styles. */
export const MARKDOWN: MarkdownToJSX.Options = {
  // Blocks land straight in the scroll box, which spaces them.
  wrapper: null,
  overrides: {
    h1: { props: { className: "mt-3 text-base font-semibold first:mt-0" } },
    h2: { props: { className: "mt-3 font-semibold first:mt-0" } },
    h3: { props: { className: "mt-2 font-medium first:mt-0" } },
    ul: { props: { className: "list-disc pl-5" } },
    ol: { props: { className: "list-decimal pl-5" } },
    a: { props: LINK_PROPS },
    code: { props: { className: "rounded bg-muted px-1 font-mono text-xs" } },
    pre: { props: { className: "overflow-auto rounded-md bg-muted p-2" } },
    blockquote: { props: { className: "border-l-2 pl-3 text-muted-foreground" } },
    table: { props: { className: "border-collapse text-xs" } },
    th: { props: { className: "border px-2 py-1 text-left font-medium" } },
    td: { props: { className: "border px-2 py-1" } },
  },
};

export type PrDetails = { body?: string; diff?: string; error?: string };

/** The PR's body and diff from GitHub, asked for once `wanted`, so a look at the summary costs no call. */
export function usePrDetails(jobId: string, wanted: boolean): PrDetails {
  const [details, setDetails] = useState<PrDetails>({});
  const asked = details.body !== undefined || details.error !== undefined;

  useEffect(() => {
    if (!wanted || asked) return;
    let current = true;
    api.prDetails(jobId).then(
      (loaded) => current && setDetails(loaded),
      (failure: Error) => current && setDetails({ error: failure.message }),
    );
    return () => {
      current = false;
    };
  }, [jobId, wanted, asked]);

  return details;
}

function Loading({ error }: { error?: string }) {
  return error ? (
    <p role="status" className="text-destructive">
      Could not load the PR: {error}
    </p>
  ) : (
    <p role="status" className="flex items-center gap-2 text-muted-foreground">
      <Spinner /> Asking GitHub…
    </p>
  );
}

function DescriptionImage(props: ComponentProps<"img">) {
  if (!props.src) return <img {...props} />;
  return (
    <button
      type="button"
      data-description-image
      aria-label={props.alt ? `Enlarge image: ${props.alt}` : "Enlarge image"}
      className="max-w-full cursor-zoom-in rounded-sm align-middle focus-visible:outline-2 focus-visible:outline-ring"
    >
      <img {...props} />
    </button>
  );
}

/** Keep image buttons outside links, without removing linked text alongside an image. */
function DescriptionLink({ children, ...props }: ComponentProps<"a">) {
  const parts = Children.toArray(children);
  const isImage = (part: (typeof parts)[number]) =>
    isValidElement(part) && part.type === DescriptionImage;
  if (!parts.some(isImage)) return <a {...props}>{children}</a>;

  const groups: (typeof parts)[] = [];
  for (const part of parts) {
    const last = groups.at(-1);
    if (last && !isImage(last[0]!) && !isImage(part)) last.push(part);
    else groups.push([part]);
  }
  return groups.map((group, index) =>
    isImage(group[0]!) ? (
      group[0]
    ) : (
      <a key={index} {...props}>
        {group}
      </a>
    ),
  );
}

const DESCRIPTION_MARKDOWN: MarkdownToJSX.Options = {
  ...MARKDOWN,
  overrides: {
    ...MARKDOWN.overrides,
    a: { props: LINK_PROPS, component: DescriptionLink },
    img: { component: DescriptionImage },
  },
};

export function PrBody({ details }: { details: PrDetails }) {
  const description = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [images, setImages] = useState<{ src: string; alt: string }[]>([]);
  const [index, setIndex] = useState(0);
  const current = images[index];
  const move = (by: number) => setIndex((i) => (i + by + images.length) % images.length);

  function show(button: HTMLButtonElement) {
    // Read the rendered order, including images in lists, tables, and raw HTML.
    const thumbnails = Array.from(
      description.current!.querySelectorAll<HTMLImageElement>("[data-description-image] > img"),
    );
    const clicked = thumbnails.findIndex((image) => image.parentElement === button);
    if (clicked < 0) return;
    trigger.current = button;
    setImages(thumbnails.map(({ src, currentSrc, alt }) => ({ src: currentSrc || src, alt })));
    setIndex(clicked);
    setOpen(true);
  }

  if (details.body === undefined) return <Loading error={details.error} />;
  return (
    <>
      <div
        ref={description}
        className="flex max-w-prose flex-col gap-2 text-sm leading-relaxed wrap-anywhere"
        onClick={(event) => {
          const button = (event.target as HTMLElement).closest<HTMLButtonElement>(
            "button[data-description-image]",
          );
          if (button) show(button);
        }}
      >
        {details.body.trim() ? (
          <Markdown options={DESCRIPTION_MARKDOWN}>{details.body}</Markdown>
        ) : (
          <p className="text-muted-foreground">This PR has no description.</p>
        )}
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <TabbedDialogContent
          className="top-4 h-[calc(100dvh-2rem)] max-h-none sm:max-w-[calc(100%-2rem)]"
          finalFocus={trigger}
          onKeyDown={(event) => {
            if (event.altKey || event.ctrlKey || event.metaKey) return;
            // The details dialog listens for number keys on the document to switch tabs.
            if (/^[1-9]$/.test(event.key)) event.stopPropagation();
            if (event.key.toLowerCase() === "x") {
              event.preventDefault();
              setOpen(false);
            } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
              event.preventDefault();
              move(event.key === "ArrowLeft" ? -1 : 1);
            }
          }}
        >
          <DialogTitle className="sr-only">Description images</DialogTitle>
          {current && (
            <img
              src={current.src}
              alt={current.alt}
              className="mt-6 min-h-0 w-full flex-1 object-contain"
            />
          )}
          <div className="flex items-center justify-center gap-3">
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="Previous image"
              disabled={images.length < 2}
              onClick={() => move(-1)}
            >
              <ChevronLeftIcon />
            </Button>
            <span role="status" className="tabular-nums">
              {index + 1} / {images.length}
            </span>
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="Next image"
              disabled={images.length < 2}
              onClick={() => move(1)}
            >
              <ChevronRightIcon />
            </Button>
          </div>
        </TabbedDialogContent>
      </Dialog>
    </>
  );
}

/** The diff beside its changed files, each with its own count, to jump to. */
export function PrDiff({ details }: { details: PrDetails }) {
  const scroller = useRef<HTMLPreElement>(null);
  const headers = useRef(new Map<string, HTMLElement>());
  const [current, setCurrent] = useState<string>();
  if (details.diff === undefined) return <Loading error={details.error} />;

  const rows = diffRows(details.diff);
  const files: { name: string; added: number; removed: number }[] = [];
  for (const row of rows) {
    if (row.file) files.push({ name: row.file, added: 0, removed: 0 });
    else if (row.new !== undefined && row.old === undefined) files.at(-1)!.added++;
    else if (row.old !== undefined && row.new === undefined) files.at(-1)!.removed++;
  }

  return (
    <div className="grid h-full min-h-0 gap-3 md:grid-cols-[14rem_1fr]">
      <nav
        aria-label="Changed files"
        className="flex gap-0.5 overflow-auto max-md:pb-1 md:flex-col"
      >
        {files.map((file) => (
          <button
            key={file.name}
            type="button"
            aria-current={file.name === current}
            onClick={() => {
              setCurrent(file.name);
              const header = headers.current.get(file.name);
              if (header && scroller.current) scroller.current.scrollTop = header.offsetTop;
            }}
            className="flex shrink-0 items-center gap-2 rounded-md px-2 py-1 text-left text-xs hover:bg-muted aria-[current=true]:bg-muted"
          >
            {/* Right to left, so a long path loses its start and keeps the file name. */}
            <span className="min-w-0 flex-1 truncate [direction:rtl] max-md:max-w-48">
              {file.name}
            </span>
            <span className="whitespace-nowrap tabular-nums">
              <span className="text-success">+{file.added}</span>{" "}
              <span className="text-destructive">−{file.removed}</span>
            </span>
          </button>
        ))}
      </nav>
      <pre
        ref={scroller}
        tabIndex={0}
        className="relative min-h-0 overflow-auto rounded-md border bg-muted/50 p-3 font-mono text-xs leading-relaxed"
      >
        {rows.map((row, index) => (
          <span
            key={index}
            ref={(element) => {
              if (row.file && element) headers.current.set(row.file, element);
            }}
            className={`flex ${diffLineClass(row.text)}`}
          >
            <span className="w-[5ch] shrink-0 pr-2 text-right text-muted-foreground/60 select-none">
              {row.old}
            </span>
            <span className="w-[5ch] shrink-0 pr-2 text-right text-muted-foreground/60 select-none">
              {row.new}
            </span>
            <span>{row.text || " "}</span>
          </span>
        ))}
      </pre>
    </div>
  );
}

function diffLineClass(line: string): string {
  if (line.startsWith("diff --git")) return "mt-3 font-semibold text-foreground first:mt-0";
  if (/^(\+\+\+|---|index |@@)/.test(line)) return "text-muted-foreground";
  if (line.startsWith("+")) return "bg-success/10 text-success";
  if (line.startsWith("-")) return "bg-destructive/10 text-destructive";
  return "";
}

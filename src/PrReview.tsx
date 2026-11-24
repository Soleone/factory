import Markdown, { type MarkdownToJSX } from "markdown-to-jsx/react";
import { useEffect, useRef, useState } from "react";
import { api } from "@/api";
import { diffRows } from "@/diff";
import { Spinner } from "@/components/ui/spinner";

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
    a: {
      props: { className: "underline underline-offset-4", target: "_blank", rel: "noreferrer" },
    },
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

export function PrBody({ details }: { details: PrDetails }) {
  if (details.body === undefined) return <Loading error={details.error} />;
  return (
    <div className="flex max-w-prose flex-col gap-2 text-sm leading-relaxed wrap-anywhere">
      {details.body.trim() ? (
        <Markdown options={MARKDOWN}>{details.body}</Markdown>
      ) : (
        <p className="text-muted-foreground">This PR has no description.</p>
      )}
    </div>
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

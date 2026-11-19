import { ExternalLinkIcon } from "lucide-react";
import Markdown, { type MarkdownToJSX } from "markdown-to-jsx/react";
import { useEffect, useState } from "react";
import { api } from "@/api";
import type { Pr } from "@/backend/types.ts";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

const SCROLL =
  "max-h-[60dvh] overflow-auto rounded-md border bg-muted/50 p-3 font-mono text-xs leading-relaxed";

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

/** The PR's description and diff in a popup, so a review doesn't need a trip to GitHub. */
export function PrReview({ jobId, url, pr }: { jobId: string; url: string; pr: Pr }) {
  return (
    <Dialog>
      <DialogTrigger render={<Button variant="link" size="xs" />}>Review</DialogTrigger>
      <DialogContent className="sm:max-w-4xl">
        <DialogHeader className="mr-8">
          <DialogTitle>{pr.title}</DialogTitle>
          <DialogDescription>
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1"
            >
              {url.replace("https://github.com/", "")} <ExternalLinkIcon className="size-3" />
            </a>
          </DialogDescription>
        </DialogHeader>
        <Details jobId={jobId} pr={pr} />
      </DialogContent>
    </Dialog>
  );
}

function Details({ jobId, pr }: { jobId: string; pr: Pr }) {
  const [details, setDetails] = useState<{ body: string; diff: string }>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let current = true;
    api.prDetails(jobId).then(
      (loaded) => current && setDetails(loaded),
      (failure: Error) => current && setError(failure.message),
    );
    return () => {
      current = false;
    };
  }, [jobId]);

  if (error)
    return (
      <p role="status" className="text-destructive">
        Could not load the PR: {error}
      </p>
    );
  if (!details)
    return (
      <p role="status" className="flex items-center gap-2 text-muted-foreground">
        <Spinner /> Asking GitHub…
      </p>
    );
  return (
    <Tabs defaultValue="description" className="min-w-0">
      <TabsList>
        <TabsTrigger value="description">Description</TabsTrigger>
        <TabsTrigger value="diff">
          Diff
          <span className="text-success">+{pr.additions}</span>
          <span className="text-destructive">−{pr.deletions}</span>
        </TabsTrigger>
      </TabsList>
      <TabsContent value="description">
        <div
          tabIndex={0}
          className={`${SCROLL} flex flex-col gap-2 font-sans text-sm wrap-anywhere`}
        >
          {details.body.trim() ? (
            <Markdown options={MARKDOWN}>{details.body}</Markdown>
          ) : (
            "This PR has no description."
          )}
        </div>
      </TabsContent>
      <TabsContent value="diff">
        <pre tabIndex={0} className={SCROLL}>
          {details.diff.split("\n").map((line, index) => (
            <span key={index} className={`block ${diffLineClass(line)}`}>
              {line || " "}
            </span>
          ))}
        </pre>
      </TabsContent>
    </Tabs>
  );
}

function diffLineClass(line: string): string {
  if (line.startsWith("diff --git")) return "mt-3 font-semibold text-foreground first:mt-0";
  if (/^(\+\+\+|---|index |@@)/.test(line)) return "text-muted-foreground";
  if (line.startsWith("+")) return "bg-success/10 text-success";
  if (line.startsWith("-")) return "bg-destructive/10 text-destructive";
  return "";
}

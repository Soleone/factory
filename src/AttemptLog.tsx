import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";

export function AttemptLog({ path, agent }: { path: string; agent: string }) {
  const url = `/${path}`;
  return (
    <Popover>
      <PopoverTrigger render={<Button variant="link" size="xs" />}>Log</PopoverTrigger>
      <PopoverContent className="w-xl max-w-[calc(100vw-2rem)]">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <PopoverHeader>
            <PopoverTitle>Agent log</PopoverTitle>
            <PopoverDescription>{agent}</PopoverDescription>
          </PopoverHeader>
          <a
            className="text-xs underline underline-offset-4"
            href={url}
            target="_blank"
            rel="noreferrer"
          >
            Open raw log
          </a>
        </div>
        <LogBody url={url} />
      </PopoverContent>
    </Popover>
  );
}

function LogBody({ url }: { url: string }) {
  const [text, setText] = useState<string>();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) throw new Error(`Log request failed: ${response.status}`);
        const raw = await response.text();
        if (!controller.signal.aborted) setText(readableLog(raw));
      } catch {
        if (!controller.signal.aborted) setFailed(true);
      }
    })();
    return () => controller.abort();
  }, [url]);

  if (failed)
    return (
      <p role="status" className="text-destructive">
        Could not load the log. Reopen it to try again.
      </p>
    );
  if (text === undefined)
    return (
      <p role="status" className="flex items-center gap-2 text-muted-foreground">
        <Spinner /> Loading log…
      </p>
    );
  if (!text.trim())
    return <p className="text-muted-foreground">This attempt did not write any log output.</p>;
  return (
    <pre
      tabIndex={0}
      className="max-h-[min(28rem,50dvh)] overflow-auto rounded-md border bg-muted/50 p-3 font-mono text-xs leading-relaxed wrap-anywhere whitespace-pre-wrap focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      {text}
    </pre>
  );
}

function readableLog(raw: string): string {
  if (!raw.trimStart().startsWith("{")) return raw;
  try {
    const entry = JSON.parse(raw);
    // Claude prints a result envelope; Pi and setup failures already print readable text.
    if (entry?.type === "result" && typeof entry.result === "string" && entry.result.trim())
      return entry.result;
    return JSON.stringify(entry, null, 2);
  } catch {
    return raw;
  }
}

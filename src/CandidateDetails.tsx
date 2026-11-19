import { InfoIcon } from "lucide-react";
import Markdown from "markdown-to-jsx/react";
import { useEffect, useState, type ReactNode } from "react";
import { api } from "@/api";
import type { Item } from "@/backend/types.ts";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/soleone/tooltip/tooltip";
import { itemTitle } from "@/format";
import { MARKDOWN, SCROLL } from "@/PrReview";

/** From `workwork --help`. */
const LEVELS: Record<string, string> = {
  auto: "a check defines correct, so a digest is enough",
  skim: "same behavior and a small diff, to skim and accept",
  decide: "changes behavior or needs your product judgment",
};

/** The task an agent gets for a candidate, behind a small button so the list stays compact. */
export function CandidateDetails({
  item,
  play,
  children,
}: {
  item: Item;
  /** What the item's play does, once workwork has said. */
  play: string | undefined;
  children: ReactNode;
}) {
  return (
    <Dialog>
      <Tooltip>
        <TooltipTrigger
          render={
            <DialogTrigger
              render={<Button variant="ghost" size="icon-sm" aria-label="What this does" />}
            />
          }
        >
          <InfoIcon />
        </TooltipTrigger>
        <TooltipContent>What this does</TooltipContent>
      </Tooltip>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader className="mr-8">
          <DialogTitle>{itemTitle(item)}</DialogTitle>
          <DialogDescription>
            {item.label} · {item.play} · {item.level}
            {LEVELS[item.level] && `: ${LEVELS[item.level]}`}
          </DialogDescription>
          {play && <p className="text-sm">{play}</p>}
        </DialogHeader>
        <Task item={item} />
        <DialogFooter>{children}</DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Task({ item }: { item: Item }) {
  const [prompt, setPrompt] = useState<string>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let current = true;
    api.prompt(item).then(
      (loaded) => current && setPrompt(loaded),
      (failure: Error) => current && setError(failure.message),
    );
    return () => {
      current = false;
    };
  }, [item]);

  if (error)
    return (
      <p role="status" className="text-destructive">
        Could not load the task: {error}
      </p>
    );
  if (prompt === undefined)
    return (
      <p role="status" className="flex items-center gap-2 text-muted-foreground">
        <Spinner /> Asking workwork…
      </p>
    );
  return (
    <div tabIndex={0} className={`${SCROLL} flex flex-col gap-2 font-sans text-sm wrap-anywhere`}>
      {/* The coding standard every prompt ends with says nothing about this task. */}
      <Markdown options={MARKDOWN}>{prompt.split("\n## Standard")[0]}</Markdown>
    </div>
  );
}

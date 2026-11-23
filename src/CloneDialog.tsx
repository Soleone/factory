import { type RefObject, useEffect, useState } from "react";
import { api, type Act } from "@/api";
import type { GithubRepo } from "@/backend/repos.ts";
import { Button } from "@/components/ui/button";
import { Dialog, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AnchoredDialogContent } from "@/components/variants/dialog";
import { Input } from "@/components/ui/input";
import { ItemGroup } from "@/components/ui/item";
import { Spinner } from "@/components/ui/spinner";
import { Row } from "@/Row";

export function CloneDialog({
  act,
  open,
  onOpenChange,
  onCloned,
  finalFocus,
}: {
  act: Act;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCloned: () => void;
  finalFocus: RefObject<HTMLButtonElement | null>;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <AnchoredDialogContent className="sm:max-w-xl" finalFocus={finalFocus}>
        <DialogHeader>
          <DialogTitle>Clone a repo</DialogTitle>
          <DialogDescription>
            Your GitHub repos that aren't cloned yet, newest first. Once cloned, workwork looks for
            work in it.
          </DialogDescription>
        </DialogHeader>
        <RepoList act={act} onCloned={onCloned} />
      </AnchoredDialogContent>
    </Dialog>
  );
}

/** Mounted only while the dialog is open, so every opening asks GitHub again. */
function RepoList({ act, onCloned }: { act: Act; onCloned: () => void }) {
  const [listing, setListing] = useState<Awaited<ReturnType<typeof api.repos>>>();
  const [failure, setFailure] = useState<string>();
  const [search, setSearch] = useState("");
  const [cloning, setCloning] = useState<string>();

  useEffect(() => {
    void api.repos().then(setListing, (error: Error) => setFailure(error.message));
  }, []);

  if (failure) return <p className="text-sm text-destructive">{failure}</p>;
  if (!listing)
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner /> Asking GitHub
      </p>
    );

  const query = search.toLowerCase();
  const shown = listing.repos.filter(
    (repo) =>
      repo.name.toLowerCase().includes(query) || repo.description.toLowerCase().includes(query),
  );
  const clone = (repo: GithubRepo) =>
    act(async () => {
      setCloning(repo.name);
      try {
        await api.clone(repo.name);
        onCloned();
        setListing({ ...listing, repos: listing.repos.filter((other) => other !== repo) });
      } finally {
        setCloning(undefined);
      }
    });

  return (
    <div className="flex min-h-0 flex-col gap-3">
      <p className="text-sm text-muted-foreground">Clones into {listing.root}/</p>
      <Input
        placeholder={`Search ${listing.repos.length} repos`}
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      <ItemGroup className="max-h-[50svh] overflow-y-auto">
        {shown.map((repo) => (
          <Row
            key={repo.name}
            title={repo.name}
            meta={[repo.description, `created ${repo.createdAt.slice(0, 10)}`]
              .filter(Boolean)
              .join(" · ")}
          >
            <Button
              variant="outline"
              size="sm"
              disabled={cloning !== undefined}
              onClick={() => clone(repo)}
            >
              {cloning === repo.name && <Spinner />} Clone
            </Button>
          </Row>
        ))}
        {shown.length === 0 && (
          <p className="text-sm text-muted-foreground">
            {listing.repos.length ? "No repo matches." : "Every repo of yours is cloned."}
          </p>
        )}
      </ItemGroup>
    </div>
  );
}

import { FolderGit2 } from "lucide-react";
import { useEffect, useState } from "react";
import { api, type Act } from "@/api";
import type { GithubRepo } from "@/backend/repos.ts";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/soleone/tooltip/tooltip";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ItemGroup } from "@/components/ui/item";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Row } from "@/Row";

/** A button that lists your GitHub repos not cloned under $SRC yet, to clone one so workwork finds it. */
export function CloneDialog({ act }: { act: Act }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <DialogTrigger
              render={<Button variant="ghost" size="icon" aria-label="Clone a repo" />}
            />
          }
        >
          <FolderGit2 />
        </TooltipTrigger>
        <TooltipContent>Clone a repo</TooltipContent>
      </Tooltip>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Clone a repo</DialogTitle>
          <DialogDescription>
            Your GitHub repos that aren't cloned yet, newest first. Once cloned, workwork looks for
            work in it.
          </DialogDescription>
        </DialogHeader>
        <RepoList act={act} />
      </DialogContent>
    </Dialog>
  );
}

/** Mounted only while the dialog is open, so every opening asks GitHub again. */
function RepoList({ act }: { act: Act }) {
  const [listing, setListing] = useState<Awaited<ReturnType<typeof api.repos>>>();
  const [failure, setFailure] = useState<string>();
  const [folder, setFolder] = useState<string>();
  const [search, setSearch] = useState("");
  const [cloning, setCloning] = useState<string>();

  useEffect(() => {
    void api.repos().then(
      (result) => {
        setListing(result);
        setFolder(result.usual);
      },
      (error: Error) => setFailure(error.message),
    );
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
        await api.clone(repo.name, folder!);
        setListing({ ...listing, repos: listing.repos.filter((other) => other !== repo) });
      } finally {
        setCloning(undefined);
      }
    });

  return (
    <div className="flex min-h-0 flex-col gap-3">
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">Into {listing.root}/</span>
        <Select value={folder} onValueChange={(value) => setFolder(value ?? undefined)}>
          <SelectTrigger size="sm" aria-label="Folder">
            <SelectValue placeholder="folder" />
          </SelectTrigger>
          <SelectContent>
            {listing.folders.map((name) => (
              <SelectItem key={name} value={name}>
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
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
              disabled={!folder || cloning !== undefined}
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

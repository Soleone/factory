import { useCallback, useEffect, useState } from "react";
import type {
  Blueprint,
  Candidates,
  CommitIdentity,
  Job,
  Model,
  Pin,
  ResultsPage,
  RunRequest,
  Snapshot,
  Tier,
} from "./backend/types.ts";
import type { clonableRepos } from "./backend/repos.ts";
import type { AgentImage } from "./components/soleone/agent";
import type { DialogAnswer } from "./pi";

async function call<T>(
  method: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(path, {
    method,
    signal,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result;
}

export const api = {
  results: (repo: string | null, limit: number, signal: AbortSignal) => {
    const query = new URLSearchParams({ limit: String(limit) });
    if (repo) query.set("repo", repo);
    return call<ResultsPage>("GET", `/api/results?${query}`, undefined, signal);
  },
  projects: (signal: AbortSignal) => call<string[]>("GET", "/api/projects", undefined, signal),
  candidates: () =>
    call<{ at: string | null; items: Candidates["items"]; repos: string[]; root: string }>(
      "GET",
      "/api/candidates",
    ),
  refreshCandidates: () => call("POST", "/api/candidates/refresh"),
  blueprints: () => call<Blueprint[]>("GET", "/api/blueprints"),
  /** Saves one of the user's own, replacing theirs of the same name. */
  saveBlueprint: (blueprint: Omit<Blueprint, "custom">) =>
    call("PUT", "/api/blueprints", blueprint),
  deleteBlueprint: (name: string) => call("POST", "/api/blueprints/delete", { name }),
  /** Queues every candidate the blueprint finds in the repo, on-request ones included. */
  runBlueprint: (name: string, repo: string) =>
    call<Job[]>("POST", "/api/blueprints/run", { name, repo }),
  /** What an agent is told to do for the candidate. */
  prompt: (item: { repo: string; id: string }) =>
    call<string>("POST", "/api/candidates/prompt", { repo: item.repo, id: item.id }),
  /** What an agent is or was told to do for the job. */
  jobPrompt: (id: string) => call<string>("GET", `/api/jobs/${id}/prompt`),
  repos: () => call<Awaited<ReturnType<typeof clonableRepos>>>("GET", "/api/repos"),
  clone: (name: string) => call("POST", "/api/repos/clone", { name }),
  /** Without a pin, the job goes to the first free worker, on its model and effort. */
  queue: (items: { repo: string; id: string }[], pin?: Pin) =>
    call("POST", "/api/jobs", { items, pin }),
  /** A waiting job's new role or worker; an empty pin lets any free worker take it. */
  pin: (id: string, pin: Pin) => call("POST", `/api/jobs/${id}/pin`, pin),
  /** A job of your own: a prompt for a tier, without workwork. */
  ownJob: (job: { repo: string; prompt: string; tier: Tier; title: string; machine: boolean }) =>
    call<Job>("POST", "/api/jobs/own", job),
  remove: (id: string) => call("POST", `/api/jobs/${id}/remove`),
  retry: (id: string) => call("POST", `/api/jobs/${id}/retry`),
  /** Answers the question a blocked job's agent asked, which picks its session up again, or else its oldest assumption. */
  answer: (id: string, text: string, re?: number) =>
    call("POST", `/api/jobs/${id}/answer`, { text, re }),
  /** A goal's approve, pause, resume or cancel. */
  goal: (id: string, action: "approve" | "pause" | "resume" | "cancel") =>
    call("POST", `/api/jobs/${id}/${action}`),
  /** Without `repo`, `project` names a new one to create. */
  /** Downloads the goal's export zip; it gathers PRs from GitHub, so it can take a while. */
  exportGoal: async (id: string, slug: string) => {
    const response = await fetch(`/api/jobs/${id}/export`);
    if (!response.ok) throw new Error((await response.json()).error);
    const link = document.createElement("a");
    link.href = URL.createObjectURL(await response.blob());
    link.download = `factory-goal-${slug}.zip`;
    link.click();
    URL.revokeObjectURL(link.href);
  },
  newGoal: (goal: { title: string; brief: string; repo?: string; project?: string }) =>
    call<Job>("POST", "/api/goals", goal),
  importPlan: (plan: string) => call<Job>("POST", "/api/goals/import", { plan }),
  /** A goal node that hasn't started, on another tier or dropped. */
  retier: (id: string, tier: Tier) => call("POST", `/api/jobs/${id}/tier`, { tier }),
  drop: (id: string) => call("POST", `/api/jobs/${id}/drop`),
  replan: (id: string, why: string) => call("POST", `/api/jobs/${id}/replan`, { why }),
  /** The user checked what the job couldn't; without a need, all of it. */
  verify: (id: string, need?: string) => call("POST", `/api/jobs/${id}/verify`, { need }),
  followup: (id: string, task: string) => call("POST", `/api/jobs/${id}/followup`, { task }),
  review: (id: string) => call("POST", `/api/jobs/${id}/review`, {}),
  prDetails: (id: string) => call<{ body: string; diff: string }>("GET", `/api/jobs/${id}/pr`),
  merge: (id: string) => call("POST", `/api/jobs/${id}/merge`),
  rebase: (id: string) => call("POST", `/api/jobs/${id}/rebase`),
  mergeTrain: (ids: string[]) => call("POST", "/api/train", { ids }),
  close: (id: string) => call("POST", `/api/jobs/${id}/close`),
  move: (id: string, index: number) => call("POST", `/api/jobs/${id}/move`, { index }),
  models: () => call<Record<string, Model[]>>("GET", "/api/models"),
  saveSettings: (settings: Snapshot["settings"]) => call("PUT", "/api/settings", settings),
  githubProfile: () => call<CommitIdentity>("GET", "/api/github-profile"),
  turnOn: (run: RunRequest) => call("POST", "/api/on", run),
  turnOff: () => call("POST", "/api/off"),
  chat: (message: string, images: AgentImage[]) => call("POST", "/api/chat", { message, images }),
  abortChat: () => call("POST", "/api/chat/abort"),
  answerChat: (answer: { id: string } & DialogAnswer) => call("POST", "/api/chat/answer", answer),
  newChat: () => call("POST", "/api/chat/new"),
  openChat: (id: string) => call("POST", "/api/chat/open", { id }),
  /** Queues an image job, which a codex worker takes while the factory runs. */
  generateImages: (request: {
    prompt: string;
    repo?: string;
    expand: boolean;
    variants: number;
    references: AgentImage[];
  }) => call<Job>("POST", "/api/images", request),
  /** Queues a job that adds the image to the image job's project by PR. */
  useImage: (id: string, file: string, where: string) =>
    call<Job>("POST", "/api/images/use", { id, file, where }),
};

/** Runs a change against the factory; the page reloads after it and shows what went wrong, if anything. */
export type Act = (change: () => Promise<unknown>) => Promise<void>;

/** The factory's state, polled every few seconds and right after every change. */
export function useFactory(): {
  snapshot?: Snapshot;
  error?: string;
  dismiss: () => void;
  act: Act;
} {
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [error, setError] = useState<string>();

  const reload = useCallback(
    () =>
      call<Snapshot>("GET", "/api/state").then(setSnapshot, (failure: Error) =>
        setError(`Can't reach factory serve: ${failure.message}`),
      ),
    [],
  );

  useEffect(() => {
    const load = () =>
      void call<Snapshot>("GET", "/api/state").then(setSnapshot, (failure: Error) =>
        setError(`Can't reach factory serve: ${failure.message}`),
      );
    load();
    const timer = setInterval(load, 3000);
    return () => clearInterval(timer);
  }, []);

  const act = useCallback<Act>(
    async (change) => {
      try {
        await change();
        setError(undefined);
      } catch (failure) {
        setError((failure as Error).message);
      }
      await reload();
    },
    [reload],
  );

  return { snapshot, error, dismiss: () => setError(undefined), act };
}

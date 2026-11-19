import { useCallback, useEffect, useState } from "react";
import type { Candidates, Model, Play, Preset, Snapshot } from "./backend/types.ts";
import type { clonableRepos } from "./backend/repos.ts";
import type { DialogAnswer } from "./pi";

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result;
}

export const api = {
  candidates: () => call<Candidates | { at: null; items: [] }>("GET", "/api/candidates"),
  refreshCandidates: () => call("POST", "/api/candidates/refresh"),
  plays: () => call<Play[]>("GET", "/api/plays"),
  /** What an agent is told to do for the candidate. */
  prompt: (item: { repo: string; id: string }) =>
    call<string>("POST", "/api/candidates/prompt", { repo: item.repo, id: item.id }),
  repos: () => call<Awaited<ReturnType<typeof clonableRepos>>>("GET", "/api/repos"),
  clone: (name: string, folder: string) => call("POST", "/api/repos/clone", { name, folder }),
  /** Without a pin, the job goes to whichever agent is free first, on its run's model and effort. */
  queue: (items: { repo: string; id: string }[], pin?: Preset) =>
    call("POST", "/api/jobs", { items, pin }),
  remove: (id: string) => call("POST", `/api/jobs/${id}/remove`),
  retry: (id: string) => call("POST", `/api/jobs/${id}/retry`),
  /** Answers the question a blocked job's agent asked; the job goes back in the queue. */
  answer: (id: string, text: string) => call("POST", `/api/jobs/${id}/answer`, { text }),
  followup: (id: string, task: string) => call("POST", `/api/jobs/${id}/followup`, { task }),
  review: (id: string, agent: string) => call("POST", `/api/jobs/${id}/review`, { agent }),
  prDetails: (id: string) => call<{ body: string; diff: string }>("GET", `/api/jobs/${id}/pr`),
  merge: (id: string) => call("POST", `/api/jobs/${id}/merge`),
  rebase: (id: string) => call("POST", `/api/jobs/${id}/rebase`),
  mergeTrain: (ids: string[]) => call("POST", "/api/train", { ids }),
  close: (id: string) => call("POST", `/api/jobs/${id}/close`),
  move: (id: string, index: number) => call("POST", `/api/jobs/${id}/move`, { index }),
  models: () => call<Record<string, Model[]>>("GET", "/api/models"),
  saveSettings: (settings: Snapshot["settings"]) => call("PUT", "/api/settings", settings),
  turnOn: (run: Pick<Snapshot["settings"], "agents" | "limit" | "until">) =>
    call("POST", "/api/on", run),
  turnOff: () => call("POST", "/api/off"),
  chat: (message: string) => call("POST", "/api/chat", { message }),
  abortChat: () => call("POST", "/api/chat/abort"),
  answerChat: (answer: { id: string } & DialogAnswer) => call("POST", "/api/chat/answer", answer),
  resetChat: () => call("POST", "/api/chat/reset"),
};

/** Runs a change against the factory; the page reloads after it and shows what went wrong, if anything. */
export type Act = (change: () => Promise<unknown>) => Promise<void>;

/** The factory's state, polled every few seconds and right after every change. */
export function useFactory(): { snapshot?: Snapshot; error?: string; act: Act } {
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

  return { snapshot, error, act };
}

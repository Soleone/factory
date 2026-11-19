import { useCallback, useEffect, useState } from "react";
import type { Candidates, Snapshot } from "./backend/types.ts";

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
  queue: (items: { repo: string; id: string }[], agent?: string) =>
    call("POST", "/api/jobs", { items, agent }),
  remove: (id: string) => call("POST", `/api/jobs/${id}/remove`),
  retry: (id: string) => call("POST", `/api/jobs/${id}/retry`),
  merge: (id: string) => call("POST", `/api/jobs/${id}/merge`),
  rebase: (id: string) => call("POST", `/api/jobs/${id}/rebase`),
  close: (id: string) => call("POST", `/api/jobs/${id}/close`),
  move: (id: string, index: number) => call("POST", `/api/jobs/${id}/move`, { index }),
  saveSettings: (settings: Snapshot["settings"]) => call("PUT", "/api/settings", settings),
  turnOn: (run: Pick<Snapshot["settings"], "agents" | "limit" | "until">) =>
    call("POST", "/api/on", run),
  turnOff: () => call("POST", "/api/off"),
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

import { useState } from "react";

/** Sets one value in the page's query string, without a reload or a history entry; empty removes it. */
export function setQueryParam(name: string, value: string): void {
  const params = new URLSearchParams(location.search);
  if (value) params.set(name, value);
  else params.delete(name);
  history.replaceState(null, "", params.size ? `?${params}` : location.pathname);
}

/** View state kept in the page's query string, so a link opens the same view. */
export function useQueryParam(name: string, fallback: string): [string, (value: string) => void] {
  const [value, setValue] = useState(
    () => new URLSearchParams(location.search).get(name) ?? fallback,
  );
  const set = (next: string) => {
    setQueryParam(name, next === fallback ? "" : next);
    setValue(next);
  };
  return [value, set];
}

import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { join, relative, resolve, sep } from "node:path";
import { PAGE } from "./page.ts";
import { readLedger, runningPid } from "./state.ts";

/** Serves the page, the state it renders, and the prompts and logs under runs/. Never changes anything. */
export function serve(state: string, port: number, host: string): Server {
  const runs = join(state, "runs");
  return createServer((request, response) => {
    // Run and item folders are [\w.-] only, so the path needs no decoding.
    const path = new URL(request.url ?? "/", "http://factory").pathname;
    if (path === "/") return send(response, "text/html; charset=utf-8", PAGE);
    if (path === "/state.json")
      return send(response, "application/json", JSON.stringify(snapshot(state)));
    const file = resolve(state, `.${path}`);
    if (file.startsWith(runs + sep) && existsSync(file) && statSync(file).isFile())
      return send(response, "text/plain; charset=utf-8", readFileSync(file));
    response.writeHead(404).end("not found");
  }).listen(port, host, () => console.log(`factory: serving http://${host}:${port}`));
}

function snapshot(state: string) {
  const path = join(state, "status.json");
  return {
    running: runningPid() !== undefined,
    status: existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null,
    // Paths under runs/ are where the server serves them.
    results: readLedger(state)
      .reverse()
      .map((entry) => ({ ...entry, log: relative(state, entry.log) })),
  };
}

function send(response: ServerResponse, type: string, body: string | Buffer): void {
  response.writeHead(200, { "content-type": type, "cache-control": "no-store" }).end(body);
}

// pn dev: the API from source, restarted on change, and Vite with hot reload in front of it.
// Uses the real state folder: the page is only useful against your actual queue.
import { spawn } from "node:child_process";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const children = [
  run("api", ["--watch-path=src/backend", "src/backend/cli.ts", "serve", "--port", "7041"]),
  // Vite directly, not the vp wrapper: vp exits on SIGTERM without stopping its Vite child.
  run("vite", ["node_modules/vite/dist/vite/node/cli.js", "dev", ...process.argv.slice(2)]),
];

function run(name, args) {
  const child = spawn(process.execPath, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (data) => process.stdout.write(prefix(name, data)));
  child.stderr.on("data", (data) => process.stderr.write(prefix(name, data)));
  child.on("exit", (code) => {
    for (const other of children) other.kill();
    process.exitCode = code ?? 1;
  });
  return child;
}

function prefix(name, data) {
  return String(data).replace(/^(?=.)/gm, `[${name}] `);
}

for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    for (const child of children) child.kill();
  });

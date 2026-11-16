/** The one page `factory serve` shows: it polls /state.json and renders workers, queue and results. */
export const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>factory</title>
<style>
  :root {
    --bg: #f7f7f5; --card: #fff; --text: #1d1d1b; --muted: #6b6b66; --line: #e4e4df;
    --done: #1f7a3d; --failed: #b42318; --timeout: #b54708; --limited: #475467; --working: #175cd3;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #141413; --card: #1e1e1c; --text: #ecece8; --muted: #9a9a93; --line: #2e2e2b;
      --done: #4ade80; --failed: #f87171; --timeout: #fb923c; --limited: #94a3b8; --working: #60a5fa;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.45 system-ui, sans-serif; }
  main { max-width: 860px; margin: 0 auto; padding: 20px 16px 48px; }
  header { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; margin-bottom: 4px; }
  h1 { font-size: 22px; margin: 0; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin: 28px 0 8px; }
  h3 { font-size: 13px; font-weight: 600; color: var(--muted); margin: 18px 0 6px; }
  a { color: var(--working); text-decoration: none; }
  a:hover { text-decoration: underline; }
  .muted { color: var(--muted); }
  .small { font-size: 13px; }
  .list { background: var(--card); border: 1px solid var(--line); border-radius: 10px; }
  .row { padding: 10px 14px; border-top: 1px solid var(--line); overflow-wrap: anywhere; }
  .row:first-child { border-top: 0; }
  .top { display: flex; gap: 8px; align-items: baseline; }
  .top .title { flex: 1; min-width: 0; }
  .badge { flex: none; font-size: 12px; font-weight: 600; padding: 1px 7px; border-radius: 99px;
    border: 1px solid currentColor; text-transform: lowercase; }
  .done { color: var(--done); } .failed { color: var(--failed); } .timeout { color: var(--timeout); }
  .limited, .stopped, .idle, .level { color: var(--limited); }
  .working, .running { color: var(--working); } .sleeping { color: var(--timeout); }
  .error { color: var(--failed); font-size: 13px; }
  .links { display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 13px; margin-top: 2px; }
  .empty { padding: 12px 14px; color: var(--muted); }
  code { font-size: 12px; }
</style>
</head>
<body>
<main>
  <header><h1>factory</h1><span id="summary" class="muted">loading</span></header>
  <div id="counts" class="small muted"></div>
  <h2>Workers</h2><div id="workers" class="list"></div>
  <h2 id="queue-title">Queue</h2><div id="queue" class="list"></div>
  <h2>Results</h2><div id="results"></div>
</main>
<script>
const esc = (text) => String(text ?? "").replace(/[&<>"']/g, (c) => "&#" + c.charCodeAt(0) + ";");
const time = (iso) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const day = (iso) => new Date(iso).toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const repo = (path) => path.split("/").filter(Boolean).at(-1);
const badge = (text, kind = text) => '<span class="badge ' + esc(kind) + '">' + esc(text) + "</span>";
const list = (rows, empty) => rows.length ? rows.join("") : '<div class="empty">' + empty + "</div>";
// Run ids are ISO times without colons: 2026-11-16T013000.
const runTime = (run) => run.replace(/T(\\d\\d)(\\d\\d)(\\d\\d)$/, "T$1:$2:$3Z");

function render({ running, status, results }) {
  const summary = [running ? badge("running") : badge("stopped")];
  if (status) {
    summary.push("run started " + day(runTime(status.run)));
    if (status.until) summary.push("until " + time(status.until));
  }
  document.getElementById("summary").innerHTML = summary.join(" · ");
  const counts = status?.counts;
  document.getElementById("counts").textContent = counts
    ? "this run: " + counts.done + " done, " + counts.failed + " failed, " + counts.timeout + " timed out, " + counts.limited + " limited"
    : "";

  document.getElementById("workers").innerHTML = list((status?.workers ?? []).map((worker) => {
    const what = worker.item ?? (worker.until ? "until " + time(worker.until) : worker.reason ?? "");
    return '<div class="row"><div class="top"><b>' + esc(worker.agent) + "</b>" + badge(worker.state) +
      '<span class="title">' + esc(what) + '</span></div><div class="small muted">since ' + time(worker.since) +
      ", limits hit " + worker.limits + "</div></div>";
  }), "no run yet");

  const queue = status?.queue ?? [];
  document.getElementById("queue-title").textContent = "Queue (" + queue.length + ")";
  document.getElementById("queue").innerHTML = list(queue.map((item) =>
    '<div class="row"><div class="top">' + badge(item.level, "level") + '<span class="title">' + esc(item.title) +
    '</span></div><div class="small muted">' + esc(repo(item.repo)) + " · " + esc(item.id) +
    " · " + esc(item.play) + "</div></div>"), running ? "empty; workwork is asked again when it runs dry" : "empty");

  const runs = new Map();
  for (const entry of results) runs.set(entry.run, [...(runs.get(entry.run) ?? []), entry]);
  document.getElementById("results").innerHTML = runs.size === 0 ? '<div class="list"><div class="empty">nothing done yet</div></div>' :
    [...runs].map(([run, entries]) => "<h3>Run " + day(runTime(run)) + '</h3><div class="list">' + entries.map(result).join("") + "</div>").join("");
}

function result(entry) {
  const minutes = Math.round((Date.parse(entry.end) - Date.parse(entry.start)) / 60000);
  const links = [];
  if (entry.url) links.push('<a href="' + esc(entry.url) + '">' + esc(entry.url.replace("https://github.com/", "")) + "</a>");
  links.push('<a href="/' + esc(entry.log) + '">log</a>');
  links.push('<a href="/' + esc(entry.log.replace(/agent\\.log$/, "prompt.md")) + '">prompt</a>');
  return '<div class="row"><div class="top">' + badge(entry.outcome) + '<span class="title">' + esc(entry.title ?? entry.id) +
    '</span></div><div class="small muted">' + esc(repo(entry.repo)) + " · " + esc(entry.id) + " · " + esc(entry.agent) +
    " · " + time(entry.start) + ", " + minutes + " min</div>" +
    (entry.error ? '<div class="error">' + esc(entry.error.split("\\n")[0]) + "</div>" : "") +
    (entry.worktree ? '<div class="small">unpushed work kept in <code>' + esc(entry.worktree) + "</code></div>" : "") +
    '<div class="links">' + links.join("") + "</div></div>";
}

async function refresh() {
  try {
    const response = await fetch("/state.json", { cache: "no-store" });
    render(await response.json());
  } catch (error) {
    document.getElementById("summary").textContent = "can't reach factory serve: " + error.message;
  }
}
refresh();
setInterval(refresh, 10000);
</script>
</body>
</html>
`;

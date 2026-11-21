# Plan format: factory-plan/1

A plan describes one goal as a graph of nodes, for `factory goal import` (or `factory goal check` to validate only). Factory's own decomposer writes it, and so can any other tool. JSON, or YAML when the file ends in `.yaml` or `.yml`.

```json
{
  "format": "factory-plan/1",
  "goal": {
    "title": "GPUI client for Tasks",
    "repo": "/home/me/src/tasks",
    "branch": "goal/gpui-client",
    "summary": "Markdown: what done looks like, constraints, links to specs.",
    "gates": ["cargo test -p tasks-gpui"],
    "budget": { "attempts": 200 },
    "allowUp": true,
    "replanTier": "builder"
  },
  "nodes": [
    {
      "key": "skeleton",
      "title": "Crate skeleton with a window and the stdio backend client",
      "tier": "builder",
      "prompt": "Markdown. Self-contained: what to build, where, how to verify, what not to touch.",
      "after": [],
      "touches": ["gpui/**"],
      "gates": ["cargo build -p tasks-gpui"],
      "needs": [],
      "checkpoint": false,
      "parent": "foundation",
      "review": "builder"
    }
  ]
}
```

## Goal

| Field | Meaning |
| --- | --- |
| `title` | Shown on the page and in the final PR. |
| `repo` | Absolute path of a git clone with an `origin`. |
| `branch` | Optional, `goal/<slug>`: the integration branch, created on origin from its default branch. Without it the slug comes from the title. |
| `summary` | Every node's prompt starts from it. It is also the start of the goal memory, `.factory/<slug>.md`. |
| `gates` | Commands run on the integration branch after every merge into it. A failing one pauses the goal and queues a fix. |
| `budget` | Optional. At `attempts` attempts the goal waits for approval; approving adds the same again. |
| `allowUp` | Optional, default false. A node may run on a higher tier than its own when its own is busy or limited, never on a lower one. |
| `replanTier` | Optional, default `builder`: the tier replans run on. |

## Nodes

| Field | Meaning |
| --- | --- |
| `key` | Unique in the plan: lowercase letters, digits, `.`, `_`, `-`. Names the node's branch, `node/<slug>/<key>`. |
| `title` | One line. |
| `tier` | `communicator`, `builder` or `grunt` (below). |
| `prompt` | The task, self-contained. Factory adds the goal summary, the memory file, what the node's dependencies delivered, and how to deliver. |
| `after` | Keys this node waits for. A key with children (a milestone) is done when they all are. |
| `touches` | Globs of files the node changes. Nodes whose globs overlap never run at the same time. An empty list means it may touch anything, so it runs alone. |
| `gates` | Commands run in the node's worktree when its agent stops; it only counts as done when they pass. A failing gate goes back to the agent, up to two times. |
| `needs` | Optional: capabilities to verify with, like `display`, `gpu` or `android-emulator`. A node whose needs no worker has still runs, and lands on the unverified checklist. |
| `checkpoint` | Optional: once this node merges, the goal waits for the user's approval. |
| `parent` | Optional key: makes the parent a milestone. A milestone done rebases the integration branch onto main and queues a replan. |
| `review` | Optional tier: before the node merges, an agent of that tier reviews its branch; findings become a fix on it. |

## Tiers

Pick the lowest tier that will get a node right; tiers are the main lever on cost.

- `communicator`: the most capable and most limited. The decomposition itself, UX and visual design, user-facing copy, anything judged by taste.
- `builder`: intelligent and thorough, not a great communicator. Architecture, foundations other nodes build on, tricky logic, reviews.
- `grunt`: follows a detailed spec with little judgment, very cheap. Anything a detailed prompt makes mechanical. A more detailed grunt prompt costs less than a higher tier.

Each node should fit comfortably in one session of its tier, well under the tier's compaction threshold (about 200k tokens).

## Validation

`factory goal check` and every import and replan apply these, listing every problem at once:

- `format` is `factory-plan/1`; the goal has a title, a summary, gates, and a repo that is a git repository.
- Keys are unique; `after` and `parent` name existing keys; neither forms a cycle.
- Every node has a non-empty title and prompt, a known tier, and `after`, `touches` and `gates` lists (they may be empty).
- A replan keeps every node that is done, running or waiting to merge exactly as it is (prompt, tier, after).

A rejected plan changes nothing.

## Schema

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "factory-plan/1",
  "type": "object",
  "required": ["format", "goal", "nodes"],
  "properties": {
    "format": { "const": "factory-plan/1" },
    "goal": {
      "type": "object",
      "required": ["title", "repo", "summary", "gates"],
      "properties": {
        "title": { "type": "string", "minLength": 1 },
        "repo": { "type": "string", "minLength": 1 },
        "branch": { "type": "string", "pattern": "^goal/[a-z0-9][a-z0-9._-]*$" },
        "summary": { "type": "string", "minLength": 1 },
        "gates": { "type": "array", "items": { "type": "string" } },
        "budget": {
          "type": "object",
          "required": ["attempts"],
          "properties": { "attempts": { "type": "integer", "minimum": 1 } }
        },
        "allowUp": { "type": "boolean" },
        "replanTier": { "enum": ["communicator", "builder", "grunt"] }
      }
    },
    "nodes": {
      "type": "array",
      "minItems": 1,
      "items": {
        "type": "object",
        "required": ["key", "title", "tier", "prompt", "after", "touches", "gates"],
        "properties": {
          "key": { "type": "string", "pattern": "^[a-z0-9][a-z0-9._-]*$" },
          "title": { "type": "string", "minLength": 1 },
          "tier": { "enum": ["communicator", "builder", "grunt"] },
          "prompt": { "type": "string", "minLength": 1 },
          "after": { "type": "array", "items": { "type": "string" } },
          "touches": { "type": "array", "items": { "type": "string" } },
          "gates": { "type": "array", "items": { "type": "string" } },
          "needs": { "type": "array", "items": { "type": "string" } },
          "checkpoint": { "type": "boolean" },
          "parent": { "type": "string" },
          "review": { "enum": ["communicator", "builder", "grunt"] }
        }
      }
    }
  }
}
```

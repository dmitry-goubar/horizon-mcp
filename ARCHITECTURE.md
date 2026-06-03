# System architecture

This document describes how `horizon-mcp` fits into the larger two-part system it
was built for, and the rule that decides where any given feature belongs. For the
server's *internal* implementation (PowerShell execution, P/Invoke, transport), see
the **Architecture** section of [README.md](README.md).

## The two parts

The system is split across two repositories with a one-directional dependency:

```
  ┌─────────────────────┐         ┌──────────────────────────┐
  │   horizon-monitor    │  uses   │       horizon-mcp        │
  │  (application layer) │ ──────▶ │   (capability layer)     │
  │                      │   MCP   │                          │
  │  • UI / presentation │         │  • screenshot / ocr      │
  │  • config & state    │         │  • click / type / keys   │
  │  • orchestration loop│         │  • window & clipboard    │
  │  • "which / when /   │         │  • stateless primitives  │
  │     what's new"      │         │                          │
  └─────────────────────┘         └──────────────────────────┘
        private, personal                 public, MIT, reusable
```

**`horizon-mcp` is hands and eyes. `horizon-monitor` is the brain and the face.**

This is the classic **mechanism vs. policy** boundary:

| | `horizon-mcp` (MCP server) | `horizon-monitor` (app) |
|---|---|---|
| Role | Capability provider | Orchestration + presentation |
| Knows about | Windows, pixels, keys, clipboard | The user's apps and workflows (e.g. Teams, "the group I monitor") |
| State | **Stateless** — each tool call is atomic | **Stateful** — config, history, what's been seen |
| Domain | App-agnostic, generic | Specific to the user's workflow |
| Audience | *Any* MCP client (Claude Code, Claude Desktop, the monitor app) | The human user |
| Distribution | Public, MIT, reusable | Private, personal |
| Examples | `screenshot`, `click`, `ocr`, `key_combo` | "poll every 5 min", "notify me", "which group" |

### The dependency is one-directional

`horizon-monitor` depends on `horizon-mcp`; **never the reverse**. The server must
never learn what Teams is, what a "message" is, or which group the user watches. The
moment an app-specific tool (`read_teams_messages`) lands in the server, its personal
workflow is welded into a public, reusable capability layer — breaking both reuse and
the public/private boundary.

## The rule: where does a feature go?

Decompose the feature into individual actions and route each by its nature:

- **Generic, stateless, app-agnostic, reusable → server.**
  e.g. "OCR a region", "find a template image on screen", "drag from A to B".
- **App-specific, stateful, or about presentation / scheduling / policy → app.**
  e.g. "monitor the *Project X* Teams group every 5 minutes and notify me".

### Worked example

> "Navigate to the Horizon window, find Teams, open/switch/start it, and read the
> latest messages in a group the user monitors."

This is **both — split by layer**:

| Step | Layer | Why |
|---|---|---|
| Focus the Horizon window | **server** (`focus_window`) | generic primitive |
| Screenshot / scan the screen | **server** (`screenshot`, `ocr`) | generic primitive |
| *Decide* where Teams is, *decide* it's the right group | **reasoning** (see below) | judgment, not a primitive |
| Click / double-click / Alt-Tab to open or switch | **server** (`click`, `double_click`, `key_combo`) | generic primitive |
| Scroll, read message text | **server** (`scroll`, `ocr`) | generic primitive |
| Know *which* group to monitor | **app** | config / state |
| Diff "latest" vs. already-seen, dedup | **app** | state |
| Notify the user / show in UI / log | **app** | presentation |

**Every mechanical action is already a server primitive. Everything about *which*,
*when*, *what's new*, and *show me* belongs to the app.** This feature needs no new
server tool.

The one *generic* enhancement it would benefit from is making `ocr` return **bounding
boxes per line**, so the reasoning layer can click located text by coordinate cheaply
instead of paying Vision tokens to re-locate it. That stays app-agnostic, so it is a
legitimate server addition — "read Teams messages" is not.

## Where the reasoning lives

The server provides mechanism; the app provides policy; but the *judgment* that binds
them ("that icon is Teams", "this message is new") is **Claude's reasoning at runtime**,
not hardcoded in either repo. This makes the design choice for `horizon-monitor`
explicit:

- **Agentic monitor (recommended).** The app embeds an LLM (Claude API / Agent SDK),
  connects to `horizon-mcp` as an MCP client, and runs the orchestration loop
  (*every 5 min: screenshot → locate Teams → read group → if new, notify*). Claude
  interprets the pixels; the server performs the actions; the app owns the loop, the
  config, and the UI. Robust to layout changes.
- **Scripted monitor (avoid).** Hardcoded coordinates and fixed input sequences. Brittle
  — any UI change breaks it, and the "intelligence" has nowhere to live.

## Why two repos, not one

The repositories stay separate by design:

- **Reuse.** `horizon-mcp` is generic and public; Claude Desktop, Claude Code, and the
  monitor app all consume it unchanged. Merging would couple a reusable library to one
  private workflow.
- **Boundary hygiene.** Public/MIT capability code and private/personal workflow code
  have different audiences and lifecycles. Keeping them apart prevents personal config
  or app logic from leaking into the public repo.
- **Independent versioning and testing.** Each side ships and is tested on its own
  cadence.

### Running and developing

- **Using the server from the app.** `horizon-mcp` is registered at **user scope** (in
  `~/.claude.json`), so every project — including `horizon-monitor` — sees the desktop
  tools without sharing a codebase. Integration is achieved without a merge.
- **Day-to-day development.** Keep one Claude Code session per repo. This preserves the
  commit-scope discipline (see the `commit-mcp` skill) and keeps context focused.
- **Cross-cutting change.** For a change that genuinely spans both sides (e.g. adding
  OCR bounding boxes here *and* consuming them in the monitor), open one session at the
  common parent directory so it sees both repos — but be deliberate about which repo
  each commit lands in.

## Summary

- Two repos, one-directional dependency: `monitor → mcp`.
- The server stays a dumb, generic, stateless capability layer.
- The app owns all workflow-specific policy, state, and presentation.
- Claude is the reasoning that binds mechanism to policy at runtime.
- User-scoped MCP registration gives integration without merging.

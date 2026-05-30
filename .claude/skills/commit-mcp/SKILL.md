---
name: commit-mcp
description: Commit and push changes in the horizon-mcp repo the safe way. Use whenever the user asks to commit and/or push in this project. Rebuilds the committed dist/ so it stays in sync with src/, scans for secrets, commits with a clean message, and pushes to origin.
---

# commit-mcp

Commit and push workflow for **horizon-mcp**. This repo commits its compiled
output (`dist/index.js`) so the MCP server runs without a build step — the build
must therefore be re-run before every commit that touches `src/`, or `dist/`
silently goes stale.

Run these steps in order. Stop and report if any step fails.

## 1. Rebuild so dist/ matches src/

```bash
npm run build
```

A clean `git status` afterward means `dist/` was already in sync. If `dist/index.js`
shows as modified, that change must be included in the commit — never commit a `src/`
change without its rebuilt `dist/`.

## 2. Check what is staged-worthy and scan for secrets

```bash
git status --short
git diff --stat
```

Then scan tracked + about-to-be-tracked content for accidental secrets/PII. This repo
is **public**:

```bash
git grep -nIE "(password|secret|token|api[_-]?key|PRIVATE KEY|proton\.me|goucan)" -- ':!package-lock.json' ':!dist' || echo "clean"
```

Confirm local-only files stay ignored — `.mcp.json` (holds an absolute local path),
`.env*`, `node_modules/`, `*.log`, and `.claude/settings.local.json` must never be
staged. `git status` should not list any of them.

## 3. Commit

Stage explicitly (avoid blanket `git add -A` so ignored/stray files can't slip in):

```bash
git add <the files you intend to commit>
```

Write the message with **one `-m` flag per paragraph**. Do NOT use a PowerShell
here-string (`@'...'@`) — the Bash tool does not understand it and will inject literal
`@` characters into the message. End with the Co-Authored-By trailer:

```bash
git commit \
  -m "Short imperative subject (<=72 chars)" \
  -m "Body paragraph explaining what changed and why." \
  -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

Verify the message is clean before pushing:

```bash
git show -s --format='%s' HEAD
```

## 4. Push

`main` is the default branch and this repo's established workflow commits directly to
it. Push to origin:

```bash
git push origin main
```

If the message of a commit that was *just* pushed needs fixing, amend and use
`git push --force-with-lease origin main` (only safe for a commit no one else has pulled).

## 5. Confirm

```bash
git fetch -q origin && git rev-list --left-right --count HEAD...origin/main
```

`0	0` means local and remote are in sync. Report the final short hash and subject.

## Scope

This skill only operates on the horizon-mcp repo. If a change actually belongs to
horizon-monitor, stop and tell the user — that is a separate repo with its own terminal.

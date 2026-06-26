# Multi-Workspace (Projects + Workspace Sidebar) for TerminalX

**Status:** Design Specification
**Date:** 2026-06-25
**Author:** TerminalX Team
**Version:** 1.0-draft
**Backs GitHub issue:** #12

---

## Executive Summary

Today TerminalX presents a **flat list of tmux sessions**. A user creating
work on three branches ends up with three loose sessions, each with its own
worktree, with no UI grouping and no notion of "the repo this belongs to". The
`createGitWorktreeForSession` flow (`src/lib/git-worktree.ts`) already produces
exactly the right primitive — a branch + an isolated worktree + a session
started inside it — but nothing groups those sessions or treats the
worktree-backed unit as a first-class, nameable, archivable object.

This spec introduces **Projects** (a group of workspaces, keyed by a git repo
root) and **Workspaces** (a branch + worktree + its sessions), surfaced through
a **left sidebar** modeled on Conductor's workspace sidebar. A project row shows
a name and a **count badge** of its workspaces; the active project row exposes a
**gear** (project settings) and a **`+`** (new workspace) affordance. **New
workspace (`⌘N`)** creates a branch + worktree + an initial AI/bash session in
one action. Each workspace is **named after its branch**, owns its sessions, its
copied env, and its worktree, and supports **rename**, **archive**, and
**collapse/expand**.

The design is **additive and backward compatible**: it sits on top of the
existing `SessionMeta` / worktree model. A new `workspaces.json` store (analog to
Conductor's per-workspace records) groups existing sessions; sessions without a
workspace continue to render in an "Ungrouped" bucket.

---

## Conductor UI reference (from screenshots)

The authoritative UI facts this feature is built to match (extracted from the
Conductor product screenshots). TerminalX mirrors the **shape and affordances**,
not Conductor's internal naming.

### Workspace sidebar (the primary surface for this spec)

- **Projects group workspaces.** A project row shows a **name + a count badge**
  (e.g. `Starter project  3` = 3 workspaces under it).
- On the **active** project row, two icons appear: a **gear** (project settings)
  and a **`+`** (add workspace).
- A project (e.g. `terminalx-app-mono`) contains **child workspace rows**, each
  **named after its branch** (e.g. `Screenshot feature co…`, truncated with an
  ellipsis when long).
- The **`+` tooltip is "New workspace ⌘N"** — the canonical create entry point.

### Per-workspace setup / isolation (from the session chat + diff panel)

- Conductor **copies an `.env` "if you have one"** into the new workspace.
- Conductor **injects a per-workspace `CONDUCTOR_PORT`** env var so preview/run
  servers in different workspaces don't collide on the same port. TerminalX's
  analog is **`TERMINALX_PORT`** (see §3.4).

### Repo vs User scope, committed repo config

- Settings have a **User** scope and a **Repo** scope (two top-level tabs).
- Repo config lives in a **committed TOML** (`.conductor/settings.toml`) with an
  **"Edit settings.toml"** affordance on repo-scoped screens. TerminalX's analog
  is a committed **`.terminalx/settings.toml`** (defined fully in the
  `workspace-config` spec; this spec only consumes its project-level defaults).

> **Naming note.** Where Conductor says `CONDUCTOR_PORT` / `.conductor/settings.toml`,
> TerminalX uses `TERMINALX_PORT` / `.terminalx/settings.toml`. Where Conductor
> says "project" we keep "project"; where it says "workspace" we keep
> "workspace". These map cleanly because TerminalX already keys worktrees by repo
> root: `git-worktree.ts` hashes the repo root into every worktree dir name via
> its `repoHash(repoRoot)` helper. Note `repoHash` is **private** today, so reusing
> that key for the project id requires exporting it (or re-deriving the same hash);
> see §1.2 for the required additive change.

### What we explicitly do NOT invent

We do **not** add a separate "PR review / diff / checks" surface here — that is
one tabbed panel owned by sibling specs (`diff-viewer`, `checks-dashboard`,
`pr-review`, `github-integration`). This spec only **routes** the user into a
workspace; the right-hand review panel is out of scope and referenced, not
redefined.

---

## 1. Concepts & Data Model

### 1.1 The three nouns

| Noun          | Definition                                                                   | Backed by (existing)                                                                                                                | New store                             |
| ------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| **Project**   | A git repository, keyed by its absolute repo root. Groups workspaces.        | `getGitDirectoryInfo().root`; project id derived from `repoRoot` via the `projectId(repoRoot)` helper in `workspaces.ts` (see §1.2) | `workspaces.json` (project records)   |
| **Workspace** | A branch + its worktree + the sessions opened in it. Named after the branch. | `CreatedGitWorktree` (`repoRoot`/`worktreePath`/`branch`)                                                                           | `workspaces.json` (workspace records) |
| **Session**   | A single tmux pane (`bash`/`claude`/`codex`). Unchanged.                     | `SessionMeta` in `src/lib/ai-sessions.ts`                                                                                           | —                                     |

A workspace is the missing middle layer: one project → many workspaces → many
sessions. Conductor's sidebar count badge is exactly `project.workspaces.length`.

### 1.2 New types — `src/lib/workspaces.ts`

A **new** module, parallel to the existing `src/lib/ai-sessions.ts` (same
atomic-write + `withLock` pattern, same `data/` directory, same `0o600` mode).

```typescript
// src/lib/workspaces.ts
import * as path from "path";
import { ensureSecureDir } from "./secure-dir";

export type WorkspaceStatus = "active" | "archived";

export interface ProjectRecord {
  /** Stable id = projectId(repoRoot) (8 hex chars; see derivation below). */
  id: string;
  /** Absolute git repo root (canonical key). */
  repoRoot: string;
  /** Display name. Defaults to path.basename(repoRoot) (== repoName). */
  name: string;
  /** UI: whether the project row is expanded in the sidebar. */
  collapsed: boolean;
  createdAt: string;
  createdBy?: string;
}

export interface WorkspaceRecord {
  /** Stable id, slug-unique within a project: `${projectId}-${branchSlug}`. */
  id: string;
  /** Owning project id (== projectId(repoRoot); see derivation below). */
  projectId: string;
  /** Display name. Defaults to the branch; user-renamable. */
  name: string;
  /** The git branch this workspace owns. */
  branch: string;
  /** Absolute worktree path (== CreatedGitWorktree.worktreePath). */
  worktreePath: string;
  /** Per-workspace injected port (TERMINALX_PORT analog of CONDUCTOR_PORT). */
  port?: number;
  /** Session names (tmux session names) opened in this workspace. */
  sessionNames: string[];
  status: WorkspaceStatus;
  createdAt: string;
  createdBy?: string;
  archivedAt?: string;
}

export interface WorkspaceStore {
  projects: ProjectRecord[];
  workspaces: WorkspaceRecord[];
}
```

**Project-id derivation (required additive change).** The project id must be the
**same 8-hex value** that `git-worktree.ts` already bakes into every worktree
directory name (`${repoName}-${repoHash(repoRoot)}-${branchPathSlug(branch)}`),
so the sidebar id and the on-disk worktree agree. But `repoHash` is a **private
(non-exported)** function in `git-worktree.ts` today — it cannot be imported from
`workspaces.ts` as-is. This spec therefore requires one of the following
**additive** changes (treated as a Phase-1 task, §7), with the first preferred:

1. **Export `repoHash` (and `worktreesBaseDir`) from `git-worktree.ts`** and have
   `workspaces.ts` define `export const projectId = repoHash;` so the derivation
   is shared from a single source. `worktreesBaseDir` is also referenced by §3.1
   and §5 and is private today, so it must be exported alongside.
2. **Or** define a self-contained `projectId(repoRoot)` in `workspaces.ts` that
   reproduces the exact hash (`crypto.createHash("sha1").update(repoRoot)
.digest("hex").slice(0, 8)`). This avoids touching `git-worktree.ts` but
   **duplicates** the hashing logic — the two must be kept byte-for-byte
   identical or worktree dir names and project ids will diverge.

> Wherever this spec writes `projectId(repoRoot)` it means this helper. The
> earlier wording that treated `repoHash` as already-importable was incorrect:
> exporting it (or re-deriving it) is a required code change, on par with the
> `createSession` env arg and the optional `SessionMeta.workspaceId` field below.

**Why a separate store, not a field on `SessionMeta`?** A workspace can outlive a
session (you can close all panes and reopen later), can hold _multiple_ sessions,
and needs project-level grouping. Embedding it in `SessionMeta` would duplicate
project/workspace rows per session. The link is `WorkspaceRecord.sessionNames[]`
↔ `SessionMeta.name`.

### 1.3 Relationship to existing `SessionMeta`

`SessionMeta` (in `src/lib/ai-sessions.ts`) is **unchanged in shape** but gains
one **optional, backward-compatible** field so a session can point back to its
workspace without a reverse scan:

```typescript
export interface SessionMeta {
  name: string;
  kind: SessionKind;
  createdAt: string;
  createdBy?: string;
  managed?: boolean;
  cwd?: string;
  worktree?: { repoRoot: string; path: string; branch: string };
  workspaceId?: string; // NEW: optional FK into workspaces.json
}
```

`workspaceId` is **optional**. Existing sessions load fine without it
(`listMetadata()` JSON-parses as-is). The sidebar tolerates `SessionMeta` whose
`worktree` exists but whose workspace record is missing (see §1.4 reconciliation).

### 1.4 Reconciliation / migration (no destructive migration)

On first load of the sidebar, `reconcileWorkspaces()`:

1. Reads `listMetadata()` (existing sessions) and `git worktree list` per repo.
2. For every `SessionMeta` with a `worktree`, ensures a `ProjectRecord` exists
   for `worktree.repoRoot` (id = `projectId(repoRoot)`, §1.2) and a
   `WorkspaceRecord` exists for `worktree.branch`, then appends the session to
   `sessionNames`.
3. Sessions **without** a `worktree` (plain `bash`/`claude` in a normal cwd) are
   left ungrouped — the sidebar renders them under a synthetic **"Ungrouped"**
   bucket, not under a project.
4. Workspaces whose worktree path no longer exists on disk are marked
   `status: "archived"` (lazy GC; see §6.3 edge cases).

This means **existing installs light up immediately** with zero data loss: their
worktree-backed sessions get grouped, everything else stays flat.

---

## 2. API Routes

New route group `/api/workspaces`, mirroring the existing `/api/sessions`
conventions (Next.js App Router `route.ts`, `getUserScoping(req.headers)`,
`audit(...)`, `TERMINUS_READ_ONLY` guard). Verified existing analog:
`src/app/api/sessions/route.ts`.

### 2.1 `GET /api/workspaces`

Returns the reconciled tree for the sidebar.

```jsonc
// 200 OK
{
  "projects": [
    {
      "id": "a1b2c3d4",
      "name": "terminalx-app-mono",
      "repoRoot": "/Users/msb/conductor/workspaces/terminalx-app-mono/sacramento",
      "collapsed": false,
      "workspaceCount": 3, // drives the sidebar count badge
      "workspaces": [
        {
          "id": "a1b2c3d4-screenshot-feature-comparison",
          "name": "Screenshot feature comparison",
          "branch": "screenshot-feature-comparison",
          "worktreePath": ".../.terminalx-worktrees/sacramento-a1b2c3d4-screenshot-feature-comparison",
          "port": 41877,
          "status": "active",
          "sessions": [
            /* annotated TmuxSession[] as today */
          ],
        },
      ],
    },
  ],
  "ungrouped": [
    /* annotated TmuxSession[] with no worktree */
  ],
}
```

Scoping: when `shouldScope`, filter sessions via `canAccessSession(username,
"user", s.name)` exactly as `GET /api/sessions` does, then drop empty
workspaces/projects from the response for that user.

### 2.2 `POST /api/workspaces` — New workspace (`⌘N`)

The headline action. Composes the **existing** primitives in one call:
`createGitWorktreeForSession` → `createSession` → `saveMeta` →
`saveWorkspace`.

Request:

```jsonc
{
  "repoRoot": "/abs/path/to/repo", // or cwd; resolved like POST /api/sessions
  "branch": "feature/login", // validated by validateGitBranchName()
  "name": "Login flow", // optional; defaults to branch
  "kind": "claude", // initial session kind: bash|claude|codex
  "dangerouslySkipPermissions": true, // only honored for kind === "claude"
  "copyEnv": true, // copy .env into worktree (default true)
}
```

Server flow (reusing verified functions):

```typescript
// 1. worktree (throws "Branch already exists" etc. — surfaced verbatim today)
const wt = createGitWorktreeForSession(repoRoot, branch); // git-worktree.ts

// 2. per-workspace port (TERMINALX_PORT analog), see §3.4
//    non-fatal: undefined when the range is exhausted (warning surfaced, §6.2)
const port = allocateWorkspacePort();   // number | undefined

// 3. optional env copy (Conductor's ".env if you have one"), see §3.3
if (copyEnv) copyEnvIntoWorktree(wt.repoRoot, wt.worktreePath);

// 4. initial session, started in the worktree with the injected port
const sessionName = scopedSessionName(slug(name || branch), username);
const command = commandForKind(kind, { dangerouslySkipPermissions });
createSession(sessionName, command ?? undefined, wt.startDir, {
  env: port !== undefined ? { TERMINALX_PORT: String(port) } : {}, // see §3.4; omitted when no free port
});

// 5. persist both records
await saveMeta({ name: sessionName, kind, createdAt, managed: true,
                 cwd: wt.startDir,
                 worktree: { repoRoot: wt.repoRoot, path: wt.worktreePath, branch: wt.branch },
                 workspaceId });
await saveWorkspace({ id: workspaceId, projectId: projectId(wt.repoRoot), ... }); // projectId helper, §1.2
```

On any failure after the worktree is created, **roll back the worktree** exactly
as `POST /api/sessions` already does via `removeGitWorktree(wt.worktreePath,
wt.repoRoot)`.

Response: `201` with the new project + workspace + initial session; the client
then `router.push(\`/workspace/${sessionName}\`)`(the existing route group`src/app/(app)/workspace/[session]`).

### 2.3 `POST /api/workspaces/[id]/sessions`

Open an **additional** session inside an existing workspace (no new worktree;
`cwd = workspace.worktreePath`, same injected `TERMINALX_PORT`). Appends to
`sessionNames`.

### 2.4 `PATCH /api/workspaces/[id]` — rename / collapse

```jsonc
{ "name": "Renamed workspace" }      // workspace rename (display only; branch unchanged)
{ "collapsed": true }                // project collapse/expand (on /api/workspaces/projects/[id])
```

Renaming **does not** rename the git branch or the tmux session — it only updates
`WorkspaceRecord.name`. (Branch rename is deliberately out of scope: it would
require `git branch -m` + worktree move and risks losing PR association.)

### 2.5 `POST /api/workspaces/[id]/archive`

Archives a workspace:

1. `killSession(name)` + `deleteMeta(name)` for each session in `sessionNames`
   (same calls as `DELETE /api/sessions`).
2. `removeGitWorktree(worktreePath, repoRoot)` (verified export in
   `git-worktree.ts`).
3. Set `status: "archived"`, `archivedAt`. **The branch is preserved** (we only
   remove the worktree, not the ref) so an open PR keeps working — matching
   Conductor's "Archive" button on the review panel, which detaches the workspace
   but leaves the PR/branch intact.

`DELETE /api/workspaces/[id]` is the destructive variant (also deletes the branch
via `git branch -D`); gated behind an explicit confirm and `TERMINUS_READ_ONLY`.

### 2.6 Route summary

| Method   | Route                           | Action                                         |
| -------- | ------------------------------- | ---------------------------------------------- |
| `GET`    | `/api/workspaces`               | Reconciled project→workspace→session tree      |
| `POST`   | `/api/workspaces`               | New workspace (branch+worktree+session) — `⌘N` |
| `POST`   | `/api/workspaces/[id]/sessions` | Add a session to a workspace                   |
| `PATCH`  | `/api/workspaces/[id]`          | Rename workspace                               |
| `PATCH`  | `/api/workspaces/projects/[id]` | Collapse/expand / rename project               |
| `POST`   | `/api/workspaces/[id]/archive`  | Archive (keep branch)                          |
| `DELETE` | `/api/workspaces/[id]`          | Destroy (remove worktree + branch)             |

---

## 3. Per-Workspace Isolation

### 3.1 Worktree isolation (already exists)

Each workspace owns a worktree under the worktrees base dir —
`TERMINALX_WORKTREES_ROOT` or `<root>/.terminalx-worktrees` — named
`${repoName}-${repoHash(repoRoot)}-${branchPathSlug(branch)}` (verified in
`git-worktree.ts`). Filesystem isolation is therefore free; this spec only adds
the grouping layer above it. Note the base-dir resolver (`worktreesBaseDir()`)
and `repoHash` are **private** in `git-worktree.ts` today; if this layer needs to
resolve the base dir or the hash directly it must export them (§1.2 Phase-1 task).

### 3.2 Session isolation

A session's `cwd` (and tmux `-c`) is the workspace's `worktreePath` (or
`startDir`). Sessions never share a worktree across workspaces because the
worktree path is unique per branch per repo.

### 3.3 Env file copy (Conductor's ".env if you have one")

`copyEnvIntoWorktree(repoRoot, worktreePath)` copies `repoRoot/.env` →
`worktreePath/.env` **only if** the source exists and the destination does not
(`git worktree add` does not carry over gitignored files). Best-effort, never
fatal — mirrors Conductor copying the `.env` "if you have one". Path-validated
with `resolveSafePath` + `assertNotSensitivePath` (verified in `file-service.ts`)
to keep it inside `TERMINUS_ROOT`.

### 3.4 Per-workspace port (`TERMINALX_PORT`, the `CONDUCTOR_PORT` analog)

The central isolation primitive for **run/preview** servers, so two workspaces
running `npm run dev` don't both grab `:3000`.

- `allocateWorkspacePort()` picks a free TCP port (probe in a configurable range,
  default `40000–49999`, retrying on `EADDRINUSE`) and records it on
  `WorkspaceRecord.port`. Reused on re-open so a workspace keeps a stable port.
  Returns `undefined` (not throws) when the range is exhausted, so create stays
  non-fatal (§6.2): the workspace is created port-less and `TERMINALX_PORT` is
  simply not injected.
- The port is injected into the session's environment as **`TERMINALX_PORT`**.
  This requires a **small additive change to `createSession`** (verified current
  signature `createSession(name, command?, cwd?)` in `src/lib/tmux.ts`) to accept
  an optional `{ env?: Record<string,string> }` and pass it through tmux
  `new-session` via `-e KEY=VALUE` flags:

```typescript
// src/lib/tmux.ts — additive 4th arg, backward compatible
export function createSession(
  name: string,
  command?: string,
  cwd?: string,
  opts?: { env?: Record<string, string> }
): void {
  const args = ["new-session", "-d", "-s", safeName];
  if (cwd) args.push("-c", cwd);
  for (const [k, v] of Object.entries(opts?.env ?? {})) args.push("-e", `${k}=${v}`);
  if (command) args.push(command);
  // ...unchanged...
}
```

Setup/run scripts (defined in `.terminalx/settings.toml`, owned by the
`workspace-config` spec) read `TERMINALX_PORT` to bind their dev server, e.g.
`next dev -p "$TERMINALX_PORT"`.

### 3.5 Project-level config (User vs Repo scope)

Project defaults (default session kind, default `dangerouslySkipPermissions`,
copy-env on/off, port range) come from the committed **`.terminalx/settings.toml`**
at the repo root (Repo scope) and fall back to User-scope settings. This spec
**consumes** that config; the file format and the "Edit settings.toml" editor
affordance are defined in `workspace-config.spec.md`. The gear icon on the active
project row (§4) opens that Repo-scope settings surface.

---

## 4. UI: Workspace Sidebar

### 4.1 Component tree

New left sidebar, rendered in the real app shell
`src/components/layout/AppShell.tsx`. (`src/app/(app)/layout.tsx` is only a 12-line
thin wrapper that renders `<AppShell>`; the actual shell — and the flat session
list — live in `AppShell.tsx`.) Note there are **two** flat session-list surfaces
today, and the grouped tree must replace/reconcile **both**:

1. **`AppShell.tsx`'s `LeftSidebar`** — the current left sidebar, which renders
   sessions via `useSessions()` + `sessions.map(...)` through its `SidebarSession`
   / `KindGlyph` components (`AppShell.tsx` lines ~21, 53, 133). This is the
   surface the new `WorkspaceSidebar` directly replaces.
2. **`DashboardView.tsx`'s session list** — the dashboard's own
   `sessions.map((s) => ...)` grid with its `KindIcon` (line ~36, used at ~108).
   This must be reconciled to render inside workspace groups (or defer to the
   shared tree) so the two surfaces don't disagree.

The existing per-session row rendering and kind-icon glyphs from both surfaces are
reused for the leaf `SessionRow`.

```
<WorkspaceSidebar>                         // src/components/workspace/WorkspaceSidebar.tsx
  <ProjectRow project>                     // name + count badge; gear + "+" on active
    <ProjectHeader>
      <Folder/FolderOpen icon/>            // reuse lucide Folder/FolderOpen (already imported)
      <ProjectName/>
      <CountBadge value={workspaceCount}/> // "3"
      {isActive && <GearButton onClick=openProjectSettings/>}      // → Repo-scope settings
      {isActive && <PlusButton title="New workspace  ⌘N"/>}        // → NewWorkspaceDialog
      <ChevronToggle collapsed/>           // collapse/expand
    </ProjectHeader>
    {!collapsed && project.workspaces.map(w =>
      <WorkspaceRow workspace=w>           // named after branch; truncated w/ ellipsis
        <GitBranch icon/>                  // reuse lucide GitBranch (already imported)
        <WorkspaceName title={fullName}/>  // CSS truncate; tooltip = full name
        <StatusDot status/>                // active / archived
        <WorkspaceMenu>                    // ⋯ : Rename, Open new session, Archive, Delete
        {w.sessions.map(s => <SessionRow session=s/>)}  // existing row component
      </WorkspaceRow>
    )}
  </ProjectRow>
  <UngroupedGroup sessions={ungrouped}/>   // flat sessions with no worktree
  <NewWorkspaceDialog/>                     // see §4.3
</WorkspaceSidebar>
```

### 4.2 Sidebar behaviors (mapped to Conductor)

| Conductor affordance                          | TerminalX behavior                                      | Backed by               |
| --------------------------------------------- | ------------------------------------------------------- | ----------------------- |
| Project row name + count badge `3`            | `project.name` + `workspaceCount` badge                 | `GET /api/workspaces`   |
| Gear on active project                        | Opens Repo-scope settings (`.terminalx/settings.toml`)  | `workspace-config` spec |
| `+` on active project                         | Opens NewWorkspaceDialog                                | `POST /api/workspaces`  |
| `+` tooltip "New workspace ⌘N"                | Tooltip text + global `⌘N` shortcut                     | §4.4                    |
| Workspace named after branch                  | `WorkspaceRecord.name` defaults to `branch`             | §1.2                    |
| Long names truncated `Screenshot feature co…` | CSS `truncate` + `title` tooltip                        | —                       |
| Collapse/expand                               | `ChevronToggle` → `PATCH .../projects/[id] {collapsed}` | §2.4                    |

### 4.3 New Workspace dialog

Reuses the existing worktree-create UI in `DashboardView.tsx` (branch input with
`feature/` default, repo/HEAD note, kind selector, `dangerouslySkipPermissions`
checkbox for claude) but always creates a **workspace** (worktree implied), not a
loose session:

- **Workspace name** (optional, defaults to branch).
- **Branch** — validated client+server by `validateGitBranchName` semantics
  (letters/numbers/`/._-`, no leading `-`, `git check-ref-format`). Inline error
  on `Branch already exists`.
- **Initial session kind** — `bash` / `claude` / `codex` (the only valid kinds;
  verified `isValidKind`).
- **Copy `.env`** toggle (default on).
- Submit → `POST /api/workspaces` → `router.push(/workspace/<sessionName>)`.

### 4.4 Keyboard

- `⌘N` (Ctrl+N on non-mac): open NewWorkspaceDialog scoped to the active project.
- `⌘⇧N`: open NewWorkspaceDialog with the repo picker (choose a different repo).
- Registered in the app shell; matches the Conductor "New workspace ⌘N" tooltip.

### 4.5 Routing into a workspace

Opening a workspace navigates to its first/active session via the **existing**
route group `src/app/(app)/workspace/[session]/page.tsx`
(`router.push(\`/workspace/${encodeURIComponent(sessionName)}\`)`— the same call`DashboardView.tsx` already makes). No new route is required for the workspace
terminal view; the right-hand review panel (diff/checks/PR) is the sibling specs'
surface and attaches there.

---

## 5. State, Persistence, Concurrency

- Store file: `data/workspaces.json`, written via the **same** atomic
  (`*.tmp` + `rename`) + `withLock` serialization pattern used by
  `ai-sessions.ts`, `mode: 0o600`, dir via `ensureSecureDir` (verified helper).
- `data/` already holds `users.json` and `recordings/` — `workspaces.json` slots
  in beside `ai-sessions.json`.
- All mutations go through `saveWorkspace` / `deleteWorkspace` / `saveProject`
  under the write lock; the sidebar GET is lock-free (read-only JSON parse with a
  try/catch fallback to `{ projects: [], workspaces: [] }`).
- Source of truth for _liveness_ remains tmux (`listSessions()`); `workspaces.json`
  is the grouping/metadata layer and is reconciled against tmux + `git worktree
list` on every GET (§1.4).

---

## 6. Acceptance Criteria & Edge Cases

### 6.1 Acceptance criteria

- [ ] Sidebar shows projects, each with a **count badge** equal to its workspace
      count; the active project shows a **gear** and a **`+`**.
- [ ] **`+` / `⌘N`** creates a branch + worktree + initial session in one action
      and routes to it; the new workspace appears under its project, **named after
      the branch**.
- [ ] Long workspace names are **truncated with an ellipsis** and show the full
      name on hover.
- [ ] Each workspace is **isolated**: its sessions run in its own worktree, get a
      copied `.env` (when present), and a unique injected **`TERMINALX_PORT`**.
- [ ] A workspace can hold **multiple sessions**; opening another session adds to
      the same worktree (no new branch).
- [ ] **Rename** changes only the display name (branch + tmux session untouched).
- [ ] **Archive** kills the sessions and removes the worktree but **keeps the
      branch** (PR survives); **Delete** also removes the branch.
- [ ] Project rows **collapse/expand** and the state persists.
- [ ] **Existing installs**: worktree-backed sessions are auto-grouped on first
      load; non-worktree sessions render under **Ungrouped**; **no data loss**.
- [ ] All write routes honor `TERMINUS_READ_ONLY` and user scoping exactly like
      `/api/sessions`.

### 6.2 Validation & errors

- Branch validation surfaces `validateGitBranchName` errors verbatim
  (`Branch name is required`, `Branch already exists`, `Invalid Git branch name`).
- `repoRoot` resolved + checked with `resolveSafePath` / `assertNotSensitivePath`;
  a non-repo dir yields `Selected directory is not inside a Git repository`.
- Port allocation failure (range exhausted) is **non-fatal**: the workspace is
  still created and `POST /api/workspaces` returns the normal **`201`** with
  `port` omitted and a `warning` field (e.g.
  `"No free port in range; TERMINALX_PORT not injected"`). Run scripts fall back
  to their own default. (Port exhaustion does not fail the create — that would
  contradict the `201` create contract in §2.6; only the optional port injection
  is skipped.)

### 6.3 Edge cases

| Case                                   | Handling                                                                                                                               |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Worktree deleted on disk out-of-band   | Reconcile marks workspace `archived`; sidebar shows it greyed with a "missing worktree" hint and a Restore (re-`worktree add`) action. |
| tmux session killed externally         | Removed from `sessionNames` on next GET; empty active workspace stays (re-openable) until archived.                                    |
| Branch already exists                  | `POST /api/workspaces` returns the verbatim error; no worktree/session created.                                                        |
| Two repos with same basename           | Disambiguated by `projectId(repoRoot)` (the repo-root hash, §1.2) in the project id; sidebar may show the parent dir as a subtitle.    |
| Same branch name in two repos          | Different projects → different `projectId` prefix in workspace id; no collision.                                                       |
| `.env` exists in both src and worktree | Copy skipped (never overwrites an existing worktree `.env`).                                                                           |
| Archive while a session is attached    | Detach + kill (same as `DELETE /api/sessions` on managed sessions); refuse if not TerminalX-managed (`ensureManagedSession`).          |
| Port conflict at run time              | `TERMINALX_PORT` is unique per workspace; if a user hardcodes a port in their script, that's on them — we only inject the env var.     |
| `TERMINUS_READ_ONLY=true`              | All `POST/PATCH/DELETE` workspace routes return `403`, mirroring `/api/sessions`.                                                      |

---

## 7. Implementation Plan

### Phase 1 — Data layer (no UI)

- [ ] `src/lib/workspaces.ts`: types, `WorkspaceStore`, atomic store
      (`saveWorkspace`/`deleteWorkspace`/`saveProject`/`listStore`), `reconcileWorkspaces()`.
- [ ] **Export `repoHash` (and `worktreesBaseDir`) from `git-worktree.ts`** — both
      are private today (verified: no `export`). Then define
      `export const projectId = repoHash` in `workspaces.ts`. (Alternative: re-derive
      the identical hash in `workspaces.ts`; see §1.2.) `ProjectRecord.id` /
      `WorkspaceRecord.projectId` cannot be computed without this.
- [ ] Add optional `workspaceId` to `SessionMeta` (`src/lib/ai-sessions.ts`).
- [ ] `allocateWorkspacePort()` + `copyEnvIntoWorktree()` helpers.
- [ ] Additive `opts.env` arg on `createSession` (`src/lib/tmux.ts`) → tmux `-e`.

### Phase 2 — API

- [ ] `GET/POST /api/workspaces`, `POST /api/workspaces/[id]/sessions`,
      `PATCH /api/workspaces/[id]`, `PATCH /api/workspaces/projects/[id]`,
      `POST /api/workspaces/[id]/archive`, `DELETE /api/workspaces/[id]`.
- [ ] Reuse `createGitWorktreeForSession` / `removeGitWorktree` / `createSession`
      / `saveMeta` / scoping / audit / read-only guards.

### Phase 3 — UI

- [ ] `WorkspaceSidebar`, `ProjectRow`, `WorkspaceRow`, `NewWorkspaceDialog`
      under `src/components/workspace/`.
- [ ] Mount sidebar in `src/components/layout/AppShell.tsx`, replacing its
      `LeftSidebar` flat session list (`AppShell.tsx` lines ~21/53/133). NOTE:
      `src/app/(app)/layout.tsx` is just a thin `<AppShell>` wrapper — do not mount
      there. Also reconcile `DashboardView`'s second session list (its
      `sessions.map` + `KindIcon`) to render inside workspace groups (reuse session
      row + `KindIcon`).
- [ ] `⌘N` / `⌘⇧N` shortcuts; gear → Repo-scope settings.
- [ ] `useWorkspaces()` hook (parallels `useSessions`).

### Phase 4 — Polish

- [ ] Collapse/expand persistence, archived/missing-worktree states, Restore.
- [ ] Empty/loading/error states; ungrouped bucket.
- [ ] Tests (§8) + docs.

---

## 8. Testing Strategy

### 8.1 Unit

- `workspaces.ts`: store round-trip, atomic write under concurrent `saveWorkspace`,
  `reconcileWorkspaces()` grouping of legacy worktree sessions, ungrouped bucket.
- `allocateWorkspacePort()`: returns a free port, retries past `EADDRINUSE`,
  returns `undefined` when range exhausted (and the route degrades to a port-less
  `201` with a `warning`, §6.2).
- `copyEnvIntoWorktree()`: copies when src exists + dst absent; no-op otherwise;
  rejects sensitive paths.
- `createSession` env passthrough: tmux invoked with `-e TERMINALX_PORT=...`.

### 8.2 Integration (API)

- `POST /api/workspaces` happy path: worktree + session + records created, port
  injected, response routes to session.
- Rollback: force `createSession` to throw → `removeGitWorktree` called, no
  orphan records.
- `Branch already exists` → verbatim error, nothing created.
- `archive` keeps the branch, removes the worktree, kills sessions.
- `delete` removes the branch.
- Read-only + scoping parity with `/api/sessions`.

### 8.3 E2E

- Create a workspace from the `+`, see it under its project with the count badge
  incremented, land in its terminal.
- Open a second session in the same workspace; both share the worktree + port.
- Rename a workspace (display only); collapse/expand the project (persists).
- Archive a workspace; its branch still resolves (`git rev-parse`).
- Long branch name truncates with a tooltip.

---

## 9. Cross-Spec Boundaries

| Surface                                                                                                        | Owner                                                                | This spec's relationship                                                                                                                                            |
| -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Committed repo config + "Edit settings.toml" + User/Repo scope                                                 | `workspace-config.spec.md`                                           | Consumes project defaults; gear opens it                                                                                                                            |
| Right-hand review panel (All files / Changes / Checks / Review; PR link, Merged/open/draft, Continue, Archive) | `diff-viewer`, `checks-dashboard`, `pr-review`, `github-integration` | We route into a workspace's session; that panel attaches there. The workspace **Archive** action is the same intent as the panel's Archive button (keep branch/PR). |
| Session kinds & providers                                                                                      | `extended-session-types.spec.md`                                     | New-workspace dialog's "initial session kind" picker reuses whatever kinds that spec exposes; today `bash`/`claude`/`codex`.                                        |

---

## 10. Glossary

- **Project** — a git repo (keyed by repo root) grouping its workspaces.
- **Workspace** — a branch + its worktree + the sessions opened in it; named
  after the branch; rename/archive/collapse.
- **Session** — a single tmux pane (`bash`/`claude`/`codex`); unchanged.
- **`TERMINALX_PORT`** — per-workspace injected port; TerminalX analog of
  Conductor's `CONDUCTOR_PORT`.
- **`.terminalx/settings.toml`** — committed repo config; analog of Conductor's
  `.conductor/settings.toml` (defined in `workspace-config`).
- **Worktree base dir** — `TERMINALX_WORKTREES_ROOT` or
  `<root>/.terminalx-worktrees` (see `git-worktree.ts`).

---

End of Specification

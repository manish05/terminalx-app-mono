# TerminalX Archive & Cleanup Specification

**Feature:** Workspace/session archiving, auto-archive policy, archive browser + restore, and recordings cleanup
**Backs GitHub issue:** #9
**Version:** 1.0
**Date:** 2026-06-25
**Tech stack:** Next.js 16 App Router, custom Node server (`server/index.ts`), React 19, shadcn/ui, Tailwind 4, react-resizable-panels v4.9

---

## 1. Overview

When an AI/terminal session has been driven to completion — its branch landed via a merged PR — its git worktree, tmux session, and recordings all linger and accumulate. **Archive** is the lifecycle action that "closes the books" on a session: it marks the session archived, optionally tears down its worktree, and schedules the associated recordings for cleanup, while preserving enough metadata to **restore** (recreate the worktree from its branch) later.

This spec covers four facets that share one data model and one API surface:

1. **Manual archive** — the prominent **Archive** button in the review/diff panel (enabled once the PR is `Merged`), and an equivalent action in the workspace sidebar.
2. **Auto-archive policy** — age-based sweeps and on-PR-merge auto-archive, mirroring the recordings retention sweep that already exists.
3. **Archive browser + restore** — a panel listing archived sessions with a one-click **Restore** that recreates the worktree from the recorded branch.
4. **Cleanup** — coordinated removal of the worktree (`removeGitWorktree`) and recordings (`*.jsonl`) for an archived session, with a retention grace period. (Per-session log cleanup is **out of scope** — TerminalX has no session-scoped logs today; see §8.2.)

### 1.1 Conductor analog being mirrored

In Conductor, the review panel's **Archive** button retires a workspace once its PR shows **Merged** (see the Conductor UI reference below). Conductor archives the workspace and reclaims its worktree. TerminalX's analog archives the `SessionMeta` and reclaims the git worktree created by `createGitWorktreeForSession`, but keeps TerminalX naming (`.terminalx-worktrees/`, `TERMINALX_*` env, `data/ai-sessions.json`).

---

## 2. Conductor UI reference (from screenshots)

These are the authoritative Conductor UI facts this feature depends on. TerminalX UI must agree with this surface (it is the same panel that the diff-viewer, checks-dashboard, and pr-review specs target).

### 2.1 Review / diff panel (the home of "Archive")

The review surface is **one** right-hand panel attached to a session, with:

- **Top status bar:**
  - `#1 ↗` — link out to the PR.
  - A **status pill**: `Merged` (also `Open` / `Draft`).
  - A **Continue** button.
  - A prominent **Archive** button. **Archive is the action this spec implements.** It is contextually emphasized once the PR is **Merged**.
- **Tabs:** `All files`, `Changes` (count badge, e.g. `1`), `Checks`, `Review` (eye icon).
- **File rows:** path with the filename emphasized (e.g. `.conductor/settings.toml`), a `+19` added-lines count, and a small file/status icon.

> Cross-cutting takeaway: the diff viewer, checks dashboard, PR review, and **archive** are facets of this _single_ review panel + status bar. Archive lives in the status bar; it is not its own screen.

### 2.2 Workspace sidebar

- **Projects** group workspaces. A project row shows a name + a **count badge** (e.g. `Starter project  3` = 3 workspaces) and, on the active project, a **gear** (settings) icon and a **+** (add) icon (`New workspace  ⌘N`).
- A project (e.g. `terminalx-app-mono`) has child workspaces named after their branch, e.g. `Screenshot feature co…` (truncated). **Archived** workspaces should drop out of this live count and move to an archive view.

### 2.3 Repo config & per-workspace port (context, not implemented here)

- Repo config lives in a committed TOML (`.conductor/settings.toml`); the TerminalX analog is a committed repo config (`.terminalx/settings.toml`) with an **Edit settings.toml**-style affordance, plus a **User vs Repo** scope split in Settings. Archive/auto-archive **policy defaults** belong in this repo config (see §7).
- Conductor injects a per-**workspace** `CONDUCTOR_PORT` via its run script (`PORT=$CONDUCTOR_PORT npm run dev`); the custom server reads `PORT`. This is workspace-level, not per-worktree, and there is **no** TerminalX-native per-worktree port variable (`CONDUCTOR_PORT`/`TERMINALX_PORT` appear nowhere in `src/` or `server/`). Restore does not need to handle a port at all — the normal run/setup flow already supplies `PORT` (see §6.3).

### 2.4 Settings shell (where policy is configured)

- Two scope tabs: **User** and **Repo**.
- User-scope left nav: General, Account, Models, Harnesses, Environment, Git, Appearance; **More** group: Experimental, Advanced.
- Archive policy toggles live under a new **Archive** section (User defaults) with Repo overrides written to `.terminalx/settings.toml`.

---

## 3. Verified codebase grounding

Every reference below was read from the repo.

| Concern                        | Symbol / path                                                                                                                                                                                        | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Session metadata + persistence | `SessionMeta`, `listMetadata`, `saveMeta`, `deleteMeta`, `getMeta` — `src/lib/ai-sessions.ts`                                                                                                        | JSON at `data/ai-sessions.json`, atomic temp-file write under a promise `writeLock`. `SessionMeta` has `name, kind, createdAt, createdBy?, managed?, cwd?, worktree?{repoRoot,path,branch}`. **No `archived` field today — this spec adds it.**                                                                                                                                                                                            |
| Session kinds                  | `SessionKind = "bash" \| "claude" \| "codex"` — `src/lib/ai-sessions.ts`                                                                                                                             |                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Worktree create                | `createGitWorktreeForSession(selectedDirectory, rawBranch): CreatedGitWorktree` — `src/lib/git-worktree.ts`                                                                                          | Creates `git worktree add -b <branch> <path>` under `worktreesBaseDir()`; **fails if the branch already exists** (`branchExists`) — restore must handle an existing branch (see §6).                                                                                                                                                                                                                                                       |
| Worktree remove                | `removeGitWorktree(worktreePath, repoRoot): void` — `src/lib/git-worktree.ts`                                                                                                                        | Best-effort `git worktree remove --force`.                                                                                                                                                                                                                                                                                                                                                                                                 |
| Worktree base dir              | `worktreesBaseDir()` — `src/lib/git-worktree.ts`                                                                                                                                                     | `TERMINALX_WORKTREES_ROOT` or `<root>/.terminalx-worktrees`; mode `0o700`.                                                                                                                                                                                                                                                                                                                                                                 |
| Repo info / branch validation  | `getGitDirectoryInfo`, `validateGitBranchName` — `src/lib/git-worktree.ts`                                                                                                                           | Reused by restore to re-resolve repo root and validate the branch.                                                                                                                                                                                                                                                                                                                                                                         |
| Sessions API                   | `GET/POST/DELETE` — `src/app/api/sessions/route.ts`; `DELETE` — `src/app/api/sessions/[name]/route.ts`                                                                                               | `GET` annotates each tmux session with `meta.worktree`, `managed`, telegram. `DELETE` does `killSession` + `deleteMeta`. The archive routes mirror these auth/scope patterns.                                                                                                                                                                                                                                                              |
| Tmux                           | `listSessions`, `killSession`, `createSession` — `src/lib/tmux.ts` (imported in routes)                                                                                                              | Archive needs `killSession`; restore needs `createSession`.                                                                                                                                                                                                                                                                                                                                                                                |
| Auth scoping                   | `getUserScoping(headers)` → `{username, role, shouldScope, hasIdentity}`; `canAccessSession(username, role, name)`; `scopedSessionName(name, username)` — `src/lib/session-scope.ts`                 | Non-admins are scoped to their own sessions. Archive/restore reuse this verbatim.                                                                                                                                                                                                                                                                                                                                                          |
| Audit                          | `audit(event, {username?, detail?})`, `AuditEvent` union — `src/lib/audit-log.ts`                                                                                                                    | **The union must be extended** with `session_archived`, `session_restored`, `session_cleanup` — `audit()` only accepts members of `AuditEvent`.                                                                                                                                                                                                                                                                                            |
| Recordings                     | `listRecordings`, `getRecordingMeta`, `getRecordingPath`, `sweepExpiredRecordings` — `src/lib/session-recorder.ts`; routes `src/app/api/recordings/route.ts`, `src/app/api/recordings/[id]/route.ts` | Files at `data/recordings/<sanitize(sessionId)>-<ts>.jsonl`. `RecordingMeta.sessionId` ties a recording back to a session. Existing age sweep keyed on `TERMINUS_RECORDING_RETENTION_DAYS`. Cleanup reuses this matching.                                                                                                                                                                                                                  |
| Logs                           | `listLogFiles` — `src/lib/log-streamer.ts`; route `src/app/api/logs/route.ts`; WS `/ws/logs/:encodedPath` — `server/index.ts`                                                                        | Admin-only listing. **`listLogFiles()` scans `TERMINUS_LOG_PATHS` (default `/var/log,~/.pm2/logs`) for `.log/.out/.err` files — these are PM2/system log dirs with NO linkage to TerminalX sessions, worktrees, or `cwd`. There is no per-session log file and no session→log mapping. Worktrees live under `.terminalx-worktrees/`, which is not in `TERMINUS_LOG_PATHS`. Per-session log cleanup is therefore out of scope (see §8.2).** |
| Settings UI                    | `src/components/settings/SettingsView.tsx`                                                                                                                                                           | Host for the new Archive policy section.                                                                                                                                                                                                                                                                                                                                                                                                   |
| Dashboard / right panel        | `src/components/dashboard/DashboardView.tsx`                                                                                                                                                         | Host for the Archive button + Archive browser.                                                                                                                                                                                                                                                                                                                                                                                             |
| Read-only guard                | `process.env.TERMINUS_READ_ONLY === "true"` (in sessions routes)                                                                                                                                     | Archive/restore/cleanup mutating routes must honor it.                                                                                                                                                                                                                                                                                                                                                                                     |

> Naming note: existing recordings code uses the legacy `TERMINUS_*` prefix (`TERMINUS_RECORD_SESSIONS`, `TERMINUS_RECORDING_RETENTION_DAYS`, `TERMINUS_READ_ONLY`, `TERMINUS_ROOT`). New archive env vars use the **`TERMINALX_*`** prefix per project convention; see §7.

---

## 4. Data model

### 4.1 `SessionMeta` extension

Extend the existing interface in `src/lib/ai-sessions.ts` (additive, backward-compatible — old records simply lack the field, which reads as "not archived"):

```typescript
// src/lib/ai-sessions.ts (extended)

export type SessionKind = "bash" | "claude" | "codex";

export interface ArchiveInfo {
  /** When the session was archived (ISO 8601). */
  archivedAt: string;
  /** Who archived it (TerminalX username), or "system" for auto-archive. */
  archivedBy: string;
  /** Why it was archived. */
  reason: "manual" | "pr-merged" | "age";
  /** Snapshot needed to restore the worktree later. Captured because the live
   *  tmux session and worktree dir may be gone after cleanup. */
  restore?: {
    repoRoot: string; // info.root at archive time
    branch: string; // worktree.branch
    startSubdir?: string; // relative subdir the session started in, if any
    kind: SessionKind; // recreate with the same CLI kind
  };
  /** Whether the worktree dir was removed at archive time. */
  worktreeRemoved: boolean;
  /** PR context that triggered/justified the archive, if known. */
  pr?: {
    number: number;
    url: string;
    state: "merged" | "closed";
    mergedAt?: string;
  };
  /** Cleanup bookkeeping (recordings). Absent until cleanup runs.
   *  No `logsDeleted`: TerminalX has no session-scoped logs (see §8.2). */
  cleanup?: {
    cleanedAt: string;
    recordingsDeleted: number;
  };
  /** Earliest time a retention sweep may hard-delete artifacts for this
   *  archived session (archivedAt + TERMINALX_ARCHIVE_RETENTION_DAYS). */
  purgeAfter?: string;
}

export interface SessionMeta {
  name: string;
  kind: SessionKind;
  createdAt: string;
  createdBy?: string;
  managed?: boolean;
  cwd?: string;
  worktree?: {
    repoRoot: string;
    path: string;
    branch: string;
  };
  /** Present iff the session has been archived. Absence == active. */
  archived?: ArchiveInfo;
}
```

**Why store `archived` on `SessionMeta` rather than a new file:** `ai-sessions.ts` already owns atomic, lock-guarded persistence (`withLock` + temp-file rename) and is the single source of truth `GET /api/sessions` reads from. Archived records stay in `data/ai-sessions.json` (they are not deleted by `deleteMeta`); they are simply filtered out of the live session list and surfaced via a dedicated archive endpoint.

### 4.2 New helper functions (`src/lib/ai-sessions.ts`)

```typescript
/** Active sessions = metadata with no `archived` field. */
export function listActiveMetadata(): SessionMeta[] {
  return listMetadata().filter((m) => !m.archived);
}

/** Archived sessions, newest first. */
export function listArchivedMetadata(): SessionMeta[] {
  return listMetadata()
    .filter((m): m is SessionMeta & { archived: ArchiveInfo } => Boolean(m.archived))
    .sort((a, b) => (a.archived.archivedAt < b.archived.archivedAt ? 1 : -1));
}

export function isArchived(name: string): boolean {
  return Boolean(getMeta(name)?.archived);
}

/** Mark a session archived (mutates + persists via saveMeta's lock). */
export async function archiveMeta(name: string, info: ArchiveInfo): Promise<void> {
  const meta = getMeta(name);
  if (!meta) throw new Error("Unknown session");
  await saveMeta({ ...meta, archived: info });
}

/** Clear the archived flag (used by restore). */
export async function unarchiveMeta(name: string): Promise<void> {
  const meta = getMeta(name);
  if (!meta) throw new Error("Unknown session");
  const next = { ...meta };
  delete next.archived;
  await saveMeta(next);
}
```

> `GET /api/sessions` is updated to annotate against `listActiveMetadata()` (so archived names no longer appear as live sessions even if a stray tmux session lingers), and to surface `archived` when present for the UI.

### 4.3 Audit events

Extend the `AuditEvent` union in `src/lib/audit-log.ts` — `audit()` is typed to that union and will not compile with unknown strings:

```typescript
export type AuditEvent =
  | /* ...existing... */
  | "session_archived"
  | "session_restored"
  | "session_cleanup";
```

---

## 5. API surface

All routes follow the existing patterns in `src/app/api/sessions/route.ts`: `getUserScoping(req.headers)` for auth, `canAccessSession` for non-admin scoping, `TERMINUS_READ_ONLY` guard on mutations, `audit(...)` on success.

### 5.1 `POST /api/sessions/[name]/archive`

Archive a single session.

**Request body:**

```json
{
  "removeWorktree": true,
  "reason": "manual",
  "pr": {
    "number": 1,
    "url": "https://github.com/org/repo/pull/1",
    "state": "merged",
    "mergedAt": "2026-06-25T10:00:00Z"
  }
}
```

- `removeWorktree` (boolean, default `true`) — if true, call `removeGitWorktree(meta.worktree.path, meta.worktree.repoRoot)` and set `worktreeRemoved`. The branch is **not** deleted (restore relies on it).
- `reason` (`"manual" | "pr-merged" | "age"`, default `"manual"`).
- `pr` (optional) — PR context for the status pill / browser.
- `killTmux` (boolean, default `true`) — `killSession(name)` so the tmux session is reclaimed.

**Behavior:**

1. Validate name (`/^[a-zA-Z0-9_.\-]+$/`); resolve scoping; reject if `shouldScope && !canAccessSession`.
2. `getMeta(name)`; 404 if missing; **409** if already `archived`.
3. Capture `restore` snapshot from `meta.worktree` (repoRoot, branch) + `meta.kind` + relative `startSubdir` derived from `meta.cwd` vs `worktree.path`.
4. If `killTmux`: `ensureManagedSession(name)` then `killSession(name)` (ignore "session not found").
5. If `removeWorktree` and `meta.worktree`: `removeGitWorktree(path, repoRoot)`.
6. Compute `purgeAfter = archivedAt + TERMINALX_ARCHIVE_RETENTION_DAYS`.
7. `archiveMeta(name, info)`.
8. `audit("session_archived", { username, detail: `${name} (${reason})` })`.

**Response 200:** `{ success: true, archived: ArchiveInfo }`.

**Errors:** 400 invalid name, 403 access denied / read-only, 404 unknown session, 409 already archived, 500.

### 5.2 `POST /api/sessions/[name]/restore`

Recreate a worktree for an archived session and (optionally) relaunch its session.

**Request body:** `{ "relaunch": true }`

**Behavior:**

1. Scope/validate as above. `getMeta(name)`; 404 if missing; **409** if not archived.
2. Resolve `restore` snapshot. Re-validate repo with `getGitDirectoryInfo(repoRoot)`; validate branch with `validateGitBranchName(branch)`.
3. **Branch-exists handling (important):** `createGitWorktreeForSession` throws `"Branch already exists"` when the branch is present — which it almost always is after a merge. Restore therefore does **not** reuse `createGitWorktreeForSession` directly; it calls a new `attachGitWorktreeForBranch(repoRoot, branch)` helper (see §6.2) that runs `git worktree add <path> <branch>` (no `-b`) against the existing branch, with the same path/slug/safety logic.
4. If `relaunch`: rebuild the start dir (`worktreePath` + `startSubdir`), `createSession(scopedName, commandForKind(kind), startDir)`.
5. `unarchiveMeta(name)` and `saveMeta` the refreshed `worktree` (new path) + `cwd`.
6. `audit("session_restored", { username, detail: name })`.

**Response 200:** `{ success: true, name, worktree: { repoRoot, path, branch }, relaunched: boolean }`.

**Errors:** 400 (branch no longer exists / invalid), 403, 404, 409 (not archived), 500.

### 5.3 `GET /api/sessions/archived`

List archived sessions for the archive browser.

- Scope to the caller (non-admins see only `createdBy === username`).
- Returns `listArchivedMetadata()` joined with whether the recorded branch still exists (`branchExists`) so the UI can disable **Restore** when the branch is gone, and a recording count (for the cleanup preview).

**Response 200:**

```json
{
  "archived": [
    {
      "name": "alice.fix-login",
      "kind": "claude",
      "createdAt": "2026-06-20T09:00:00Z",
      "createdBy": "alice",
      "archived": {
        "archivedAt": "2026-06-25T10:00:00Z",
        "archivedBy": "alice",
        "reason": "pr-merged",
        "worktreeRemoved": true,
        "restore": { "repoRoot": "/repo", "branch": "fix-login", "kind": "claude" },
        "pr": { "number": 1, "url": "https://github.com/org/repo/pull/1", "state": "merged" },
        "purgeAfter": "2026-07-25T10:00:00Z"
      },
      "branchExists": true,
      "artifacts": { "recordings": 3 }
    }
  ]
}
```

### 5.4 `POST /api/sessions/[name]/cleanup`

Hard-delete the archived session's recordings and/or the metadata record itself. (Logs are **not** a cleanup target — see §8.2.)

**Request body:** `{ "recordings": true, "purgeMeta": false }`

**Behavior (admin-or-owner, read-only guarded):**

1. 409 if not archived (cleanup only operates on archived sessions).
2. **Recordings:** match `listRecordings()` where `RecordingMeta.sessionId === name`, delete each via the recording path (reuse the sanitize/path logic in `session-recorder.ts`; add `deleteRecording(id)` there — see §8). Count deletions.
3. Record `cleanup` on `ArchiveInfo`. If `purgeMeta`, call `deleteMeta(name)` to drop the record entirely.
4. `audit("session_cleanup", { username, detail: `${name} r=${recordingsDeleted}` })`.

**Response 200:** `{ success: true, recordingsDeleted, metaPurged }`.

### 5.5 Updated `GET /api/sessions`

Change the annotation source from `listMetadata()` to `listActiveMetadata()` so archived names are excluded from the live list, and include `archived` in the payload when a stray tmux session matches an archived record (so the UI can show an "archived — restore?" affordance rather than treating it as live).

---

## 6. Worktree lifecycle

### 6.1 Archive (teardown)

```
Active session ──Archive──▶ kill tmux (killSession)
                          └▶ removeGitWorktree(path, repoRoot)   [removeWorktree=true]
                          └▶ branch is preserved (NOT deleted)
                          └▶ SessionMeta.archived = { ..., restore:{repoRoot,branch,kind} }
```

The branch must survive teardown because restore recreates the worktree from it. `removeGitWorktree` only runs `git worktree remove --force` (verified in `git-worktree.ts`) — it does not delete branches, so this is safe.

### 6.2 Restore (recreate) — new helper

`createGitWorktreeForSession` cannot be reused for restore because it always passes `-b <branch>` and pre-checks `branchExists`, throwing on the (typical) already-merged branch. Add a sibling in `src/lib/git-worktree.ts`:

```typescript
/** Recreate a worktree for an EXISTING branch (restore path). Mirrors the
 *  safety/slug/path logic of createGitWorktreeForSession but uses
 *  `git worktree add <path> <branch>` (no -b) so it attaches to a branch
 *  that already exists (e.g. after the PR merged). */
export function attachGitWorktreeForBranch(
  repoRoot: string,
  rawBranch: unknown
): CreatedGitWorktree {
  const root = resolveSafePath(repoRoot);
  assertNotSensitivePath(root);
  const info = getGitDirectoryInfo(root);
  if (!info.isRepo || !info.root) throw new Error("Not a Git repository");

  const branch = validateGitBranchName(rawBranch);
  if (!branchExists(info.root, branch)) {
    throw new Error("Branch no longer exists; cannot restore");
  }

  const baseDir = worktreesBaseDir();
  const repoName = info.repoName || path.basename(info.root);
  const worktreeName = `${repoName}-${repoHash(info.root)}-${branchPathSlug(branch)}`;
  const worktreePath = resolveSafePath(path.join(baseDir, worktreeName));
  assertNotSensitivePath(worktreePath);
  if (fs.existsSync(worktreePath)) {
    // Already attached (e.g. partial restore) — treat as success.
    return { repoRoot: info.root, worktreePath, startDir: worktreePath, branch };
  }

  try {
    git(["-C", info.root, "worktree", "add", worktreePath, branch], GIT_WORKTREE_TIMEOUT_MS);
  } catch (err) {
    throw new Error(`Failed to restore Git worktree: ${gitErrorMessage(err)}`);
  }
  return { repoRoot: info.root, worktreePath, startDir: worktreePath, branch };
}
```

(`branchExists`, `repoHash`, `branchPathSlug`, `worktreesBaseDir`, `git`, `gitErrorMessage` are existing module-private helpers in `git-worktree.ts`; they are reused here within the same module.)

### 6.3 Edge cases

- **Worktree removal fails** (locked/dirty): `removeGitWorktree` is best-effort and swallows errors. Archive still proceeds; set `worktreeRemoved: false` and surface a non-blocking warning. A later cleanup/retry can re-attempt.
- **Branch deleted upstream** before restore: `attachGitWorktreeForBranch` throws → 400; UI disables **Restore** when `branchExists` is false in the browser payload.
- **Per-workspace port:** there is **nothing for restore to re-establish.** The port is `CONDUCTOR_PORT`, supplied by Conductor's run script at the **workspace** level (`PORT=$CONDUCTOR_PORT npm run dev`); the server reads `PORT`. It is not per-worktree and there is no `TERMINALX_PORT` (neither variable exists in `src/`/`server/`). When `relaunch` recreates the session via `createSession`, the already-running server's `PORT` is unaffected, so restore persists/handles no port. (A TerminalX-native per-worktree port, if ever desired, would be a separate mechanism, not an existing analog.)
- **Stray tmux session** for an archived name: `GET /api/sessions` flags it (`archived` present) instead of listing it as healthy/live.
- **Read-only mode:** all mutating routes early-return 403 when `TERMINUS_READ_ONLY === "true"`.

---

## 7. Auto-archive policy

Two triggers, both opt-in, with defaults in **User settings** and overrides in the committed repo config (`.terminalx/settings.toml`, the analog of `.conductor/settings.toml`).

### 7.1 Triggers

1. **On PR merge** (`reason: "pr-merged"`) — when the review panel observes a PR transition to `Merged` (the Checks/PR layer; see `github-integration.spec.md` / `pr-review/`), it calls `POST /api/sessions/[name]/archive` with `reason: "pr-merged"` and the PR context. The **Archive** button is the manual equivalent of this same call.
2. **Age-based sweep** (`reason: "age"`) — a startup + interval sweep archives sessions whose `createdAt` exceeds `TERMINALX_ARCHIVE_AFTER_DAYS`, mirroring `sweepExpiredRecordings()` which keys on `TERMINUS_RECORDING_RETENTION_DAYS` and runs once at server start.

   > **Why `createdAt`, not last activity:** `SessionMeta` (`src/lib/ai-sessions.ts`) carries only `name, kind, createdAt, createdBy?, managed?, cwd?, worktree?` — there is **no `lastActivityAt` field**. Last-activity data exists only on the live `TmuxSession` (`lastActivity`, derived from `tmux list-sessions` in `src/lib/tmux.ts`), which the metadata sweep does not consult. The sweep therefore keys purely on `createdAt`. If activity-based sweeping is later wanted, it must either (a) join `listActiveMetadata()` against `listSessions()` to read tmux `lastActivity`, or (b) add a `lastActivityAt` field to `SessionMeta` as an explicit data-model change in §4.1 — neither is in scope here.

### 7.2 The sweep

Add `sweepStaleSessions()` to a new `src/lib/archive-sweep.ts`, invoked from `server/index.ts` at startup (alongside the existing `sweepExpiredRecordings()` call) and on an interval:

```typescript
// src/lib/archive-sweep.ts
export async function sweepStaleSessions(): Promise<{ archived: number }> {
  const days = numEnv("TERMINALX_ARCHIVE_AFTER_DAYS", 0); // 0 disables
  if (days <= 0) return { archived: 0 };
  const cutoff = Date.now() - days * 86_400_000;
  let archived = 0;
  for (const m of listActiveMetadata()) {
    // SessionMeta has no lastActivityAt; key on createdAt (see §7.1).
    const age = Date.parse(m.createdAt);
    if (Number.isFinite(age) && age < cutoff) {
      await archiveSessionInternal(m.name, {
        reason: "age",
        archivedBy: "system",
        removeWorktree: true,
      });
      archived++;
    }
  }
  return { archived };
}

export async function sweepArchivedArtifacts(): Promise<{ purged: number }> {
  const now = Date.now();
  let purged = 0;
  for (const m of listArchivedMetadata()) {
    if (m.archived.purgeAfter && Date.parse(m.archived.purgeAfter) < now) {
      await cleanupSessionInternal(m.name, { recordings: true, purgeMeta: true });
      purged++;
    }
  }
  return { purged };
}
```

`archiveSessionInternal` / `cleanupSessionInternal` are the shared implementations the API routes (§5.1, §5.4) also call, so manual and automatic paths are identical.

### 7.3 Env vars (TerminalX naming)

| Var                                 | Default    | Meaning                                                      |
| ----------------------------------- | ---------- | ------------------------------------------------------------ |
| `TERMINALX_ARCHIVE_AFTER_DAYS`      | `0` (off)  | Age threshold to auto-archive an inactive session.           |
| `TERMINALX_ARCHIVE_ON_PR_MERGE`     | `true`     | Auto-archive when the session's PR merges.                   |
| `TERMINALX_ARCHIVE_REMOVE_WORKTREE` | `true`     | Whether auto-archive tears down the worktree.                |
| `TERMINALX_ARCHIVE_RETENTION_DAYS`  | `0` (keep) | Grace period after archive before artifacts/meta are purged. |

Repo-scoped overrides live under an `[archive]` table in `.terminalx/settings.toml`:

```toml
# .terminalx/settings.toml  (committed; analog of .conductor/settings.toml)
[archive]
after_days = 14
on_pr_merge = true
remove_worktree = true
retention_days = 30
```

---

## 8. Cleanup of recordings

### 8.1 Recordings

Recordings are keyed by `RecordingMeta.sessionId` (`src/lib/session-recorder.ts`). Add:

```typescript
// src/lib/session-recorder.ts
export function listRecordingsForSession(sessionId: string): RecordingMeta[] {
  return listRecordings().filter((r) => r.sessionId === sessionId);
}

export function deleteRecording(id: string): boolean {
  const file = getRecordingPath(id); // already path-safe (sanitize check)
  if (!file) return false;
  try {
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}
```

Cleanup (§5.4) calls `listRecordingsForSession(name)` then `deleteRecording(r.id)` per match. This composes with the existing age-based `sweepExpiredRecordings()` — they are independent: recordings can be reaped by age regardless of archive state, and archive cleanup reaps a specific session's recordings immediately/after grace.

### 8.2 Logs — out of scope (no session-scoped logs exist)

Per-session log cleanup is **not implemented** by this spec because the relationship it would require does not exist in the codebase:

- `listLogFiles()` (`src/lib/log-streamer.ts`) scans `TERMINUS_LOG_PATHS` (default `/var/log,~/.pm2/logs`) for `.log/.out/.err` files. These are PM2/system log directories.
- There is **no** linkage between those files and a TerminalX session, worktree, or `cwd`: no per-session log file is ever written, and `SessionMeta` records no log path. A session's worktree lives under `.terminalx-worktrees/`, which is not in `TERMINUS_LOG_PATHS`, so a "worktree/cwd path-prefix" match against `listLogFiles()` would never hit.

Accordingly there is no `logsDeleted` accounting, no `logs` request field on the cleanup route (§5.4), and no `logsDeleted` in `ArchiveInfo.cleanup` (§4.1).

**Prerequisite if log cleanup is later wanted:** the system must first emit identifiable per-session log files — e.g. a per-session log path written into `SessionMeta` — because `log-streamer.ts` provides no session→log mapping. Only after that data model change can cleanup reliably match and delete a session's logs.

### 8.3 Retention grace

`purgeAfter = archivedAt + TERMINALX_ARCHIVE_RETENTION_DAYS`. `sweepArchivedArtifacts()` (run at startup + interval) cleans + optionally purges meta once `purgeAfter` passes. `0` = keep archived records/artifacts indefinitely (only manual cleanup removes them).

---

## 9. UI

### 9.1 Component tree

```
DashboardView                                   (src/components/dashboard/DashboardView.tsx)
├── WorkspaceSidebar
│   ├── ProjectRow (name + active-session count badge, gear, +)
│   │   └── SessionRow  ── overflow ⋯ menu ──▶ "Archive"   (active sessions only)
│   └── ArchivedSessionsButton  ──▶ opens ArchiveBrowser
├── ReviewPanel  (right panel — the single review surface)
│   ├── ReviewStatusBar
│   │   ├── PrLink (#N ↗)
│   │   ├── StatusPill ("Merged" | "Open" | "Draft")
│   │   ├── ContinueButton
│   │   └── ArchiveButton            ← THIS FEATURE (emphasized when Merged)
│   └── ReviewTabs (All files | Changes •N | Checks | Review)
└── ArchiveBrowser (Dialog/Sheet)
    ├── ArchivedSessionRow
    │   ├── name + kind badge + reason pill (PR merged / Age / Manual)
    │   ├── PrLink (if pr)
    │   ├── artifacts ("3 recordings")
    │   ├── RestoreButton  (disabled when branchExists === false)
    │   └── CleanupButton  (with confirm)
    └── EmptyState ("No archived sessions")
```

### 9.2 Archive button (status bar)

- Located in `ReviewStatusBar`, mirroring Conductor's status bar (`#N ↗`, status pill, **Continue**, **Archive**).
- **State:** emphasized (primary/destructive-leaning style) when `pr.state === "merged"`; otherwise a quieter secondary style with a confirm dialog warning "branch not yet merged."
- **Click flow:** open a confirm dialog → checkbox **Remove worktree** (default checked) → `POST /api/sessions/[name]/archive`. On success, the session leaves the live sidebar, its tab closes, and a toast offers **Undo → Restore**.

### 9.3 Archive browser

- Opened from a sidebar **Archived (N)** entry (N from `GET /api/sessions/archived`).
- Each row shows name, kind badge, reason pill, PR link, archived time (relative), artifact counts.
- **Restore** → confirm → `POST /api/sessions/[name]/restore` `{ relaunch: true }`. On success: row removed, session reappears in the live sidebar, optionally focuses the new tab.
- **Restore disabled** (with tooltip "Branch deleted upstream") when `branchExists === false`.
- **Cleanup** → confirm dialog summarizing what will be deleted (`artifacts` counts) → `POST /api/sessions/[name]/cleanup`.

### 9.4 Settings — Archive policy section

Add to `SettingsView.tsx` under the **User** scope an **Archive** section (and surface Repo overrides written to `.terminalx/settings.toml`):

- Toggle **Auto-archive on PR merge** (`TERMINALX_ARCHIVE_ON_PR_MERGE`).
- Number **Auto-archive inactive after (days)** (`TERMINALX_ARCHIVE_AFTER_DAYS`, `0` = off).
- Toggle **Remove worktree on archive** (`TERMINALX_ARCHIVE_REMOVE_WORKTREE`).
- Number **Purge archived artifacts after (days)** (`TERMINALX_ARCHIVE_RETENTION_DAYS`, `0` = keep).

---

## 10. Acceptance criteria

- [ ] `SessionMeta.archived?: ArchiveInfo` added; old records (no field) read as active; `data/ai-sessions.json` writes remain atomic + lock-guarded.
- [ ] `listActiveMetadata`, `listArchivedMetadata`, `isArchived`, `archiveMeta`, `unarchiveMeta` added and unit-tested.
- [ ] `AuditEvent` union extended with `session_archived`, `session_restored`, `session_cleanup`; all three fire on success.
- [ ] `POST /api/sessions/[name]/archive` marks archived, kills tmux, and (when `removeWorktree`) calls `removeGitWorktree`; the branch is **never** deleted; honors `TERMINUS_READ_ONLY` and `canAccessSession`.
- [ ] `attachGitWorktreeForBranch` recreates a worktree from an **existing** branch (no `-b`); `POST /api/sessions/[name]/restore` succeeds against an already-merged branch and 400s when the branch is gone.
- [ ] `GET /api/sessions/archived` returns scoped archived sessions with `branchExists` and artifact counts.
- [ ] `POST /api/sessions/[name]/cleanup` deletes only that session's recordings (matched by `sessionId`); optional `purgeMeta` calls `deleteMeta`. (No log deletion — TerminalX has no session-scoped logs; see §8.2.)
- [ ] `GET /api/sessions` annotates from `listActiveMetadata()`; archived names do not appear as live sessions.
- [ ] Auto-archive: on-PR-merge path archives with `reason:"pr-merged"`; `sweepStaleSessions()` archives by `TERMINALX_ARCHIVE_AFTER_DAYS`; `sweepArchivedArtifacts()` purges after `purgeAfter`; both wired into `server/index.ts` alongside `sweepExpiredRecordings()`.
- [ ] Review status-bar **Archive** button is emphasized when PR is `Merged`; archive removes the session from the live sidebar and offers **Undo → Restore**.
- [ ] Archive browser lists archived sessions, disables **Restore** when the branch is gone, and gates **Cleanup** behind a confirm.
- [ ] Settings **Archive** section exposes all four policy toggles; Repo overrides round-trip through `.terminalx/settings.toml`.

---

## 11. Edge cases & failure modes

| Case                                                      | Handling                                                                                                          |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Archive a session with no worktree (plain `bash` session) | `removeWorktree` is a no-op; `restore` snapshot omits worktree; restore relaunches without a worktree.            |
| Branch already merged (the common case)                   | Restore uses `attachGitWorktreeForBranch` (no `-b`), succeeds.                                                    |
| Branch deleted upstream                                   | Restore 400s; browser disables **Restore** (`branchExists === false`).                                            |
| Worktree dir locked / removal fails                       | `removeGitWorktree` swallows error; `worktreeRemoved:false`; archive still succeeds; warn in UI.                  |
| Already archived                                          | Archive route 409; archive button hidden for archived rows.                                                       |
| Restore when worktree path already exists                 | `attachGitWorktreeForBranch` treats existing path as success (idempotent).                                        |
| Non-admin acting on another user's session                | `canAccessSession` → 403 (matches `DELETE /api/sessions`).                                                        |
| `TERMINUS_READ_ONLY=true`                                 | Archive/restore/cleanup mutating routes 403; browser still readable.                                              |
| Stray tmux session for an archived name                   | `GET /api/sessions` flags `archived`; not counted as live.                                                        |
| Cleanup races with an open replay                         | Recording deletion is best-effort `unlink`; replay returns 404 on next read. (No log deletion occurs — see §8.2.) |
| Concurrent archive of the same session                    | `saveMeta`'s `withLock` serializes writes; second writer observes `archived` and the route returns 409.           |

---

## 12. Out of scope

- Branch deletion on archive (we deliberately preserve branches for restore).
- GitHub-side PR/branch mutation — this spec consumes PR state from the review/PR layer (`github-integration.spec.md`, `pr-review/`) but does not call GitHub APIs itself.
- Migrating legacy `TERMINUS_*` env names to `TERMINALX_*` (new archive vars use `TERMINALX_*`; existing recording/read-only vars keep their current names).

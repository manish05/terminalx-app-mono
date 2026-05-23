import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import { assertNotSensitivePath, getTerminusRoot, resolveSafePath } from "./file-service";

const GIT_TIMEOUT_MS = 5000;
const GIT_WORKTREE_TIMEOUT_MS = 20000;

export interface GitDirectoryInfo {
  isRepo: boolean;
  root?: string;
  branch?: string;
  repoName?: string;
}

export interface CreatedGitWorktree {
  repoRoot: string;
  worktreePath: string;
  startDir: string;
  branch: string;
}

function git(args: string[], timeout = GIT_TIMEOUT_MS): string {
  return execFileSync("git", args, {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout,
    maxBuffer: 4 * 1024 * 1024,
  }).trim();
}

function gitErrorMessage(err: unknown): string {
  const e = err as { stderr?: Buffer | string; stdout?: Buffer | string; message?: string };
  const stderr = Buffer.isBuffer(e.stderr) ? e.stderr.toString("utf-8") : e.stderr;
  const stdout = Buffer.isBuffer(e.stdout) ? e.stdout.toString("utf-8") : e.stdout;
  return (stderr || stdout || e.message || String(err)).trim();
}

function branchPathSlug(branch: string): string {
  const slug = branch
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 80);
  return slug || "worktree";
}

function repoHash(repoRoot: string): string {
  return crypto.createHash("sha1").update(repoRoot).digest("hex").slice(0, 8);
}

function worktreesBaseDir(): string {
  const configured = process.env.TERMINALX_WORKTREES_ROOT?.trim();
  const base = configured || path.join(getTerminusRoot(), ".terminalx-worktrees");
  const safeBase = resolveSafePath(base);
  assertNotSensitivePath(safeBase);
  fs.mkdirSync(safeBase, { recursive: true, mode: 0o700 });
  return safeBase;
}

function branchExists(repoRoot: string, branch: string): boolean {
  try {
    git(["-C", repoRoot, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

export function getGitDirectoryInfo(directory: string): GitDirectoryInfo {
  try {
    const safeDir = resolveSafePath(directory);
    assertNotSensitivePath(safeDir);
    if (!fs.existsSync(safeDir) || !fs.statSync(safeDir).isDirectory()) {
      return { isRepo: false };
    }

    const inside = git(["-C", safeDir, "rev-parse", "--is-inside-work-tree"]);
    if (inside !== "true") return { isRepo: false };

    const root = resolveSafePath(git(["-C", safeDir, "rev-parse", "--show-toplevel"]));
    assertNotSensitivePath(root);
    const branch = git(["-C", safeDir, "branch", "--show-current"]);
    return {
      isRepo: true,
      root,
      branch: branch || undefined,
      repoName: path.basename(root),
    };
  } catch {
    return { isRepo: false };
  }
}

export function validateGitBranchName(rawBranch: unknown): string {
  const branch = typeof rawBranch === "string" ? rawBranch.trim() : "";
  if (!branch) {
    throw new Error("Branch name is required");
  }
  if (branch.length > 200) {
    throw new Error("Branch name is too long");
  }
  if (branch.startsWith("-") || !/^[A-Za-z0-9._/-]+$/.test(branch)) {
    throw new Error("Branch name can only use letters, numbers, slash, dot, underscore, or hyphen");
  }
  try {
    git(["check-ref-format", "--branch", branch]);
  } catch {
    throw new Error("Invalid Git branch name");
  }
  return branch;
}

export function createGitWorktreeForSession(
  selectedDirectory: string,
  rawBranch: unknown
): CreatedGitWorktree {
  const selectedSafe = resolveSafePath(selectedDirectory);
  assertNotSensitivePath(selectedSafe);
  if (!fs.existsSync(selectedSafe) || !fs.statSync(selectedSafe).isDirectory()) {
    throw new Error("Path is not a directory");
  }

  const info = getGitDirectoryInfo(selectedSafe);
  if (!info.isRepo || !info.root) {
    throw new Error("Selected directory is not inside a Git repository");
  }

  const branch = validateGitBranchName(rawBranch);
  if (branchExists(info.root, branch)) {
    throw new Error("Branch already exists");
  }

  const relativeStart = path.relative(info.root, selectedSafe);
  if (relativeStart.startsWith("..") || path.isAbsolute(relativeStart)) {
    throw new Error("Selected directory is outside the Git repository");
  }

  const baseDir = worktreesBaseDir();
  const repoName = info.repoName || path.basename(info.root);
  const worktreeName = `${repoName}-${repoHash(info.root)}-${branchPathSlug(branch)}`;
  const worktreePath = resolveSafePath(path.join(baseDir, worktreeName));
  assertNotSensitivePath(worktreePath);
  if (fs.existsSync(worktreePath)) {
    throw new Error("Worktree path already exists");
  }

  try {
    git(["-C", info.root, "worktree", "add", "-b", branch, worktreePath], GIT_WORKTREE_TIMEOUT_MS);
  } catch (err) {
    throw new Error(`Failed to create Git worktree: ${gitErrorMessage(err)}`);
  }

  const requestedStartDir =
    relativeStart && relativeStart !== "." ? path.join(worktreePath, relativeStart) : worktreePath;
  const startDir =
    fs.existsSync(requestedStartDir) && fs.statSync(requestedStartDir).isDirectory()
      ? requestedStartDir
      : worktreePath;

  return {
    repoRoot: info.root,
    worktreePath,
    startDir,
    branch,
  };
}

export function removeGitWorktree(worktreePath: string, repoRoot: string): void {
  try {
    git(["-C", repoRoot, "worktree", "remove", "--force", worktreePath], GIT_WORKTREE_TIMEOUT_MS);
  } catch {
    // Best effort cleanup for a worktree created during a failed session create.
  }
}

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import {
  createGitWorktreeForSession,
  getGitDirectoryInfo,
  validateGitBranchName,
} from "@/lib/git-worktree";

function hasGit(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function git(repo: string, args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

const describeGit = hasGit() ? describe : describe.skip;

describeGit("git worktree helpers", () => {
  let tmpDir: string;
  let repoDir: string;

  beforeEach(() => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tx-git-worktree-")));
    repoDir = path.join(tmpDir, "repo");
    process.env.TERMINUS_ROOT = tmpDir;
    fs.mkdirSync(path.join(repoDir, "src"), { recursive: true });
    git(tmpDir, ["init", repoDir]);
    git(repoDir, ["config", "user.email", "terminalx@example.test"]);
    git(repoDir, ["config", "user.name", "TerminalX Test"]);
    fs.writeFileSync(path.join(repoDir, "README.md"), "hello\n");
    fs.writeFileSync(path.join(repoDir, "src", "index.ts"), "export const value = 1;\n");
    git(repoDir, ["add", "."]);
    git(repoDir, ["commit", "-m", "initial"]);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.TERMINUS_ROOT;
    delete process.env.TERMINALX_WORKTREES_ROOT;
  });

  it("detects a selected directory inside a Git repository", () => {
    const info = getGitDirectoryInfo(path.join(repoDir, "src"));

    expect(info.isRepo).toBe(true);
    expect(info.root).toBe(repoDir);
    expect(info.repoName).toBe("repo");
  });

  it("creates a branch worktree under TERMINUS_ROOT and preserves selected subdirectory", () => {
    const result = createGitWorktreeForSession(path.join(repoDir, "src"), "feature/test-one");

    expect(result.repoRoot).toBe(repoDir);
    expect(result.branch).toBe("feature/test-one");
    expect(result.worktreePath).toContain(path.join(tmpDir, ".terminalx-worktrees"));
    expect(result.startDir).toBe(path.join(result.worktreePath, "src"));
    expect(fs.existsSync(path.join(result.worktreePath, "README.md"))).toBe(true);
    expect(git(result.worktreePath, ["branch", "--show-current"])).toBe("feature/test-one");
  });

  it("rejects invalid branch names before running worktree add", () => {
    expect(() => validateGitBranchName("../escape")).toThrow();
    expect(() => createGitWorktreeForSession(repoDir, "../escape")).toThrow();
  });
});

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SESSION_CREATED_MS = Date.parse("2026-05-06T08:20:25.000Z");

let tmpDir = "";
let getSessionCreatedMs = vi.fn<() => number | null>();
let isTerminalXMarkedSession = vi.fn<() => boolean>();
let markTerminalXSession = vi.fn<() => void>();

async function loadAiSessions() {
  vi.resetModules();
  vi.doMock("../../src/lib/tmux", () => ({
    getSessionCreatedMs,
    isTerminalXMarkedSession,
    markTerminalXSession,
  }));
  return import("../../src/lib/ai-sessions");
}

function writeMeta(createdAt: string) {
  const dataDir = path.join(tmpDir, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, "ai-sessions.json"),
    JSON.stringify([{ name: "condor", kind: "codex", createdAt }]),
    "utf-8"
  );
}

describe("managed session adoption", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "terminalx-ai-sessions-"));
    vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
    getSessionCreatedMs = vi.fn(() => SESSION_CREATED_MS);
    isTerminalXMarkedSession = vi.fn(() => false);
    markTerminalXSession = vi.fn(() => {
      isTerminalXMarkedSession.mockReturnValue(true);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock("../../src/lib/tmux");
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("adopts a legacy TerminalX session when metadata matches the tmux creation time", async () => {
    writeMeta("2026-05-06T08:20:25.331Z");
    const { canAdoptManagedSession, ensureManagedSession } = await loadAiSessions();

    expect(canAdoptManagedSession("condor")).toBe(true);
    expect(ensureManagedSession("condor")).toBe(true);
    expect(markTerminalXSession).toHaveBeenCalledWith("condor");
  });

  it("does not adopt stale metadata for a reused tmux session name", async () => {
    writeMeta("2026-05-06T08:30:26.000Z");
    const { canAdoptManagedSession, ensureManagedSession } = await loadAiSessions();

    expect(canAdoptManagedSession("condor")).toBe(false);
    expect(ensureManagedSession("condor")).toBe(false);
    expect(markTerminalXSession).not.toHaveBeenCalled();
  });
});

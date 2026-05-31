import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// IMPORTANT: claude-transcript.ts transitively imports state.ts, whose DATA_DIR
// is captured at module-evaluation time. We must point it at a throwaway dir
// BEFORE the dynamic import below, or the test would write to the real
// data/telegram-state.json.
const stateTmp = fs.mkdtempSync(path.join(os.tmpdir(), "tgstate-jsonl-"));
process.env.TERMINALX_DATA_DIR = stateTmp;

const { findLiveReplacementJsonl } = await import("@/lib/telegram/claude-transcript");
const state = await import("@/lib/telegram/state");

let tmp: string;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "claude-jsonl-"));
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(stateTmp, { recursive: true, force: true });
});

function newCase(): {
  mk: (name: string, mtimeSec: number) => string;
  dir: string;
} {
  const dir = fs.mkdtempSync(path.join(tmp, "case-"));
  return {
    dir,
    mk: (name, mtimeSec) => {
      const p = path.join(dir, name);
      fs.writeFileSync(p, "");
      fs.utimesSync(p, mtimeSec, mtimeSec);
      return p;
    },
  };
}

describe("findLiveReplacementJsonl", () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const TOPIC = 9999; // not registered with any watcher → claimedJsonls is empty

  it("returns the freshest sibling when the bound JSONL is stale and a live one exists", () => {
    const { mk } = newCase();
    const bound = mk("stale.jsonl", nowSec - 86400);
    const live = mk("live.jsonl", nowSec - 10);
    expect(findLiveReplacementJsonl(TOPIC, bound)).toBe(live);
  });

  it("picks the freshest among multiple recent unclaimed siblings", () => {
    const { mk } = newCase();
    const bound = mk("stale.jsonl", nowSec - 86400);
    mk("older.jsonl", nowSec - 240); // 4 min ago, still inside the 5-min window
    const live = mk("newest.jsonl", nowSec - 5);
    expect(findLiveReplacementJsonl(TOPIC, bound)).toBe(live);
  });

  it("does not rotate when the bound JSONL is still being written to", () => {
    const { mk } = newCase();
    const bound = mk("live.jsonl", nowSec - 10);
    mk("older-sibling.jsonl", nowSec - 1000);
    expect(findLiveReplacementJsonl(TOPIC, bound)).toBeNull();
  });

  it("does not rotate when the sibling is only marginally newer (gap < 60 s)", () => {
    const { mk } = newCase();
    const bound = mk("current.jsonl", nowSec - 100);
    mk("barely-newer.jsonl", nowSec - 70);
    expect(findLiveReplacementJsonl(TOPIC, bound)).toBeNull();
  });

  it("does not rotate to a sibling that itself looks dormant (no activity in 5 min)", () => {
    const { mk } = newCase();
    const bound = mk("very-stale.jsonl", nowSec - 86400 * 3);
    mk("also-dormant.jsonl", nowSec - 86400);
    expect(findLiveReplacementJsonl(TOPIC, bound)).toBeNull();
  });

  it("returns null when the bound JSONL does not exist", () => {
    const { dir } = newCase();
    expect(findLiveReplacementJsonl(TOPIC, path.join(dir, "missing.jsonl"))).toBeNull();
  });

  it("never rotates into a JSONL that another topic has bound on disk", async () => {
    const { mk } = newCase();
    const bound = mk("self-stale.jsonl", nowSec - 86400);
    // A freshly-written sibling that LOOKS like the live one by mtime — but
    // it is persisted as another topic's binding, so we must not steal it.
    const otherTopicJsonl = mk("other-topic.jsonl", nowSec - 5);
    await state.setTopic({
      topicId: 4242,
      sessionName: "sibling-session",
      kind: "claude",
      cwd: "/x",
      jsonlPath: otherTopicJsonl,
    });
    expect(findLiveReplacementJsonl(TOPIC, bound)).toBeNull();
    // Now drop a different live sibling — that one IS fair game.
    const trulyFree = mk("free-live.jsonl", nowSec - 4);
    expect(findLiveReplacementJsonl(TOPIC, bound)).toBe(trulyFree);
  });

  it("ignores non-JSONL files in the project dir", () => {
    const { mk, dir } = newCase();
    const bound = mk("bound.jsonl", nowSec - 86400);
    const distractor = path.join(dir, "scratch.txt");
    fs.writeFileSync(distractor, "");
    fs.utimesSync(distractor, nowSec - 10, nowSec - 10);
    expect(findLiveReplacementJsonl(TOPIC, bound)).toBeNull();
  });
});

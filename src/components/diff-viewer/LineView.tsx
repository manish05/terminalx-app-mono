"use client";

import type { DiffLine } from "@/types/diff";

const TYPE_CLASSES: Record<DiffLine["type"], { row: string; txt: string; marker: string }> = {
  addition: {
    row: "bg-[rgba(0,255,136,0.08)]",
    txt: "text-[#00ff88]",
    marker: "+",
  },
  deletion: {
    row: "bg-[rgba(255,80,80,0.08)]",
    txt: "text-[#ff5050]",
    marker: "-",
  },
  context: {
    row: "",
    txt: "text-[#e6f0e4]",
    marker: " ",
  },
};

function gutterNum(n: number | null): string {
  return n === null ? "" : String(n);
}

/**
 * A single unified diff line: old gutter, new gutter, marker, content.
 * Mono, dark theme (spec §8). data-testid="diff-line" on every rendered line.
 */
export function LineView({ line, wordWrap }: { line: DiffLine; wordWrap?: boolean }) {
  const cls = TYPE_CLASSES[line.type];
  return (
    <div
      data-testid="diff-line"
      data-line-type={line.type}
      className={`flex font-mono text-[12px] leading-5 ${cls.row}`}
    >
      <span className="w-10 shrink-0 select-none px-1 text-right text-[#6b7569]" aria-hidden>
        {gutterNum(line.oldLineNum)}
      </span>
      <span className="w-10 shrink-0 select-none px-1 text-right text-[#6b7569]" aria-hidden>
        {gutterNum(line.newLineNum)}
      </span>
      <span className={`w-4 shrink-0 select-none text-center ${cls.txt}`} aria-hidden>
        {cls.marker}
      </span>
      <span
        className={`flex-1 ${cls.txt} ${wordWrap ? "whitespace-pre-wrap break-all" : "whitespace-pre overflow-x-auto"}`}
      >
        {line.content || " "}
      </span>
    </div>
  );
}

/** One side of a split (side-by-side) line cell; null renders an empty filler. */
export function SplitCell({
  line,
  side,
  wordWrap,
}: {
  line: DiffLine | null;
  side: "old" | "new";
  wordWrap?: boolean;
}) {
  if (!line) {
    return <div data-testid="diff-split-cell" className="flex-1 bg-[#0d0e13]" aria-hidden />;
  }
  const cls = TYPE_CLASSES[line.type];
  const num = side === "old" ? line.oldLineNum : line.newLineNum;
  return (
    <div
      data-testid="diff-split-cell"
      data-line-type={line.type}
      className={`flex min-w-0 flex-1 font-mono text-[12px] leading-5 ${cls.row}`}
    >
      <span className="w-10 shrink-0 select-none px-1 text-right text-[#6b7569]" aria-hidden>
        {gutterNum(num)}
      </span>
      <span
        className={`flex-1 px-1 ${cls.txt} ${wordWrap ? "whitespace-pre-wrap break-all" : "whitespace-pre overflow-x-auto"}`}
      >
        {line.content || " "}
      </span>
    </div>
  );
}

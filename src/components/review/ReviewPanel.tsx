"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { CircleCheck, Eye, Files, GitCompare } from "lucide-react";
import { FileBrowser } from "@/components/files/FileBrowser";
import { useSessionDiff } from "@/hooks/useSessionDiff";
import { DiffViewer } from "@/components/diff-viewer/DiffViewer";
import { ReviewStatusBar, type ReviewStatusBarPr } from "./ReviewStatusBar";

type ReviewTab = "files" | "changes" | "checks" | "review";

interface ReviewPanelProps {
  session: string | null;
  /** PR metadata from the GitHub integration layer; absent until a PR exists. */
  pr?: ReviewStatusBarPr;
  defaultTab?: ReviewTab;
}

/**
 * The Review panel — supersedes RightPanel.tsx (spec §9.1). A single tabbed
 * surface (All files / Changes(n) / Checks / Review) with the shared status bar
 * on top. The diff viewer owns the Changes tab (this spec). Checks and Review
 * are placeholders owned by sibling specs.
 */
export function ReviewPanel({ session, pr, defaultTab = "changes" }: ReviewPanelProps) {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<ReviewTab>(defaultTab);
  // Lightweight fetch shared with the Changes tab purely to source the count
  // badge; DiffViewer fetches its own data and caches at the browser level.
  const { data } = useSessionDiff(session);
  const changeCount = data?.summary.filesChanged;

  const tabs = [
    { id: "files" as const, label: "All files", icon: Files, badge: undefined },
    { id: "changes" as const, label: "Changes", icon: GitCompare, badge: changeCount },
    { id: "checks" as const, label: "Checks", icon: CircleCheck, badge: undefined },
    { id: "review" as const, label: "Review", icon: Eye, badge: undefined },
  ];

  const onContinue = () => {
    if (session) router.push(`/workspace/${encodeURIComponent(session)}`);
  };
  const onArchive = () => {
    // Archive flow lives in issue #9; emit the event the archive track listens for.
    if (typeof window !== "undefined" && session) {
      window.dispatchEvent(
        new CustomEvent("terminalx:archive-request", { detail: { sessionId: session } })
      );
    }
  };

  return (
    <div className="flex h-full flex-col bg-[#0a0b10]" data-testid="review-panel">
      <ReviewStatusBar pr={pr} onContinue={onContinue} onArchive={onArchive} />

      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-[#1a1d24] bg-[#0f1117] px-3">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            data-testid={`review-tab-${tab.id}`}
            onClick={() => setActiveTab(tab.id)}
            className={`relative flex h-8 items-center gap-1.5 rounded px-2 text-[12px] transition-colors ${
              activeTab === tab.id
                ? "bg-[#14161e] text-[#e6f0e4]"
                : "text-[#6b7569] hover:bg-[#14161e] hover:text-[#e6f0e4]"
            }`}
          >
            <tab.icon size={13} />
            <span>{tab.label}</span>
            {tab.badge !== undefined && tab.badge > 0 && (
              <span
                data-testid="review-changes-badge"
                className="ml-0.5 rounded-full bg-[#1a1d24] px-1.5 text-[10px] text-[#a8b3a6]"
              >
                {tab.badge}
              </span>
            )}
          </button>
        ))}
        <span className="flex-1" />
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        {activeTab === "files" ? (
          <FileBrowser />
        ) : activeTab === "changes" ? (
          <DiffViewer session={session} />
        ) : activeTab === "checks" ? (
          <div
            data-testid="review-checks-placeholder"
            className="px-4 py-6 text-[12px] text-[#6b7569]"
          >
            Checks dashboard — coming soon.
          </div>
        ) : (
          <div
            data-testid="review-review-placeholder"
            className="px-4 py-6 text-[12px] text-[#6b7569]"
          >
            PR review — coming soon.
          </div>
        )}
      </div>
    </div>
  );
}

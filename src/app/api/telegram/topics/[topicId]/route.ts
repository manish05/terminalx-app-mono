import { NextRequest, NextResponse } from "next/server";
import { canAccessSession } from "@/lib/session-scope";
import { getTopic, patchTopic, type ViewMode } from "@/lib/telegram/state";
import { resetChatBaseline } from "@/lib/telegram/streamer";
import { audit } from "@/lib/audit-log";

interface Ctx {
  params: Promise<{ topicId: string }>;
}

function isViewMode(value: unknown): value is ViewMode {
  return value === "chat" || value === "screen" || value === "off";
}

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const { topicId: rawTopicId } = await ctx.params;
  const topicId = Number(rawTopicId);
  if (!Number.isFinite(topicId)) {
    return NextResponse.json({ error: "invalid topic id" }, { status: 400 });
  }

  const binding = getTopic(topicId);
  if (!binding) {
    return NextResponse.json({ error: "topic not found" }, { status: 404 });
  }

  const username = req.headers.get("x-username");
  const role = req.headers.get("x-user-role");
  if (!canAccessSession(username, role, binding.sessionName)) {
    return NextResponse.json({ error: "access denied" }, { status: 403 });
  }

  let body: { viewMode?: unknown };
  try {
    body = (await req.json()) as { viewMode?: unknown };
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  if (!isViewMode(body.viewMode)) {
    return NextResponse.json({ error: "viewMode must be chat, screen, or off" }, { status: 400 });
  }

  await patchTopic(topicId, { viewMode: body.viewMode });
  resetChatBaseline(topicId);
  audit("telegram_topic_view_updated", {
    username: username ?? undefined,
    detail: `${binding.sessionName}:${body.viewMode}`,
  });
  return NextResponse.json({
    topic: {
      topicId,
      sessionName: binding.sessionName,
      viewMode: body.viewMode,
    },
  });
}

import { NextRequest, NextResponse } from "next/server";
import {
  sanitizeTelegramConfig,
  updateTelegramConfig,
  type TelegramConfig,
} from "@/lib/telegram/config";
import { listTopics } from "@/lib/telegram/state";
import { audit } from "@/lib/audit-log";

function isAdmin(req: NextRequest): boolean {
  return req.headers.get("x-user-role") === "admin";
}

function parseBody(body: Record<string, unknown>): TelegramConfig {
  const patch: TelegramConfig = {};
  if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
  if (typeof body.botToken === "string" && body.botToken.trim()) {
    patch.botToken = body.botToken.trim();
  }
  if (typeof body.webhookUrl === "string") patch.webhookUrl = body.webhookUrl.trim();
  if (typeof body.webhookSecret === "string" && body.webhookSecret.trim()) {
    patch.webhookSecret = body.webhookSecret.trim();
  }
  if (typeof body.allowedUsers === "string") patch.allowedUsers = body.allowedUsers.trim();
  if (typeof body.forumChatId === "number") patch.forumChatId = body.forumChatId;
  if (typeof body.forumChatId === "string" && body.forumChatId.trim()) {
    const parsed = Number(body.forumChatId);
    if (Number.isFinite(parsed)) patch.forumChatId = parsed;
  }
  if (typeof body.maxTopics === "number") patch.maxTopics = body.maxTopics;
  if (typeof body.maxTopics === "string" && body.maxTopics.trim()) {
    const parsed = Number(body.maxTopics);
    if (Number.isFinite(parsed)) patch.maxTopics = parsed;
  }
  return patch;
}

export async function GET(req: NextRequest) {
  if (!isAdmin(req)) {
    return NextResponse.json({ error: "admin required" }, { status: 403 });
  }

  return NextResponse.json({
    config: sanitizeTelegramConfig(),
    topics: listTopics().map((topic) => ({
      topicId: topic.topicId,
      sessionName: topic.sessionName,
      kind: topic.kind,
      viewMode: topic.viewMode ?? "chat",
      endedAtMs: topic.endedAtMs,
    })),
  });
}

export async function PATCH(req: NextRequest) {
  if (!isAdmin(req)) {
    return NextResponse.json({ error: "admin required" }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const patch = parseBody(body);
  await updateTelegramConfig(patch);
  audit("telegram_config_updated", {
    username: req.headers.get("x-username") ?? undefined,
    detail: "settings",
  });
  return NextResponse.json({ config: sanitizeTelegramConfig() });
}

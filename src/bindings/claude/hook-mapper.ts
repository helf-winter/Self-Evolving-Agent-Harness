import { HarnessError } from "../../domain/errors.js";

const eventNames = [
  "SessionStart", "UserPromptSubmit", "UserPromptExpansion", "PreToolUse", "PostToolUse",
  "PostToolUseFailure", "Stop", "StopFailure", "SessionEnd",
] as const;

export type ClaudeHookEventName = (typeof eventNames)[number];

export interface ClaudeHookEvent {
  eventName: ClaudeHookEventName;
  sessionId: string;
  cwd: string;
  toolName?: string;
  toolUseId?: string;
  prompt?: string;
  toolInput?: Record<string, unknown>;
  toolResponse?: unknown;
  occurredAt: string;
}

export function mapClaudeHook(raw: unknown): ClaudeHookEvent {
  if (!raw || typeof raw !== "object") throw new HarnessError("invalid_input", "hook input must be an object");
  const value = raw as Record<string, unknown>;
  if (typeof value.hook_event_name !== "string" || !eventNames.includes(value.hook_event_name as ClaudeHookEventName)) {
    throw new HarnessError("invalid_input", "unsupported hook_event_name");
  }
  if (typeof value.session_id !== "string" || typeof value.cwd !== "string") {
    throw new HarnessError("invalid_input", "session_id and cwd are required");
  }
  const event: ClaudeHookEvent = {
    eventName: value.hook_event_name as ClaudeHookEventName,
    sessionId: value.session_id,
    cwd: value.cwd,
    occurredAt: typeof value.timestamp === "string" ? value.timestamp : new Date().toISOString(),
  };
  if (typeof value.tool_name === "string") event.toolName = value.tool_name;
  if (typeof value.tool_use_id === "string") event.toolUseId = value.tool_use_id;
  if (typeof value.prompt === "string") event.prompt = value.prompt;
  if (value.tool_input && typeof value.tool_input === "object") event.toolInput = value.tool_input as Record<string, unknown>;
  if ("tool_response" in value) event.toolResponse = value.tool_response;
  return event;
}

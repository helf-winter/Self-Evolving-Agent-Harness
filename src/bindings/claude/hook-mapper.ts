import { HarnessError } from "../../domain/errors.js";
import type { EffortLevel, PermissionMode, RuntimeEventContext } from "../../domain/execution-context.js";

const eventNames = [
  "SessionStart", "UserPromptSubmit", "UserPromptExpansion", "PreToolUse", "PostToolUse",
  "PostToolUseFailure", "PostModelSwitch", "Stop", "StopFailure", "SessionEnd",
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
  runtimeContext: RuntimeEventContext;
}

const permissionModes = new Set(["default", "plan", "acceptEdits", "auto", "dontAsk", "bypassPermissions"]);
const effortLevels = new Set(["low", "medium", "high", "xhigh", "max"]);

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
    runtimeContext: {},
  };
  if (typeof value.prompt_id === "string") event.runtimeContext.promptId = value.prompt_id;
  if (typeof value.permission_mode === "string" && permissionModes.has(value.permission_mode)) {
    event.runtimeContext.permissionMode = value.permission_mode as PermissionMode;
  }
  if (value.effort && typeof value.effort === "object") {
    const level = (value.effort as Record<string, unknown>).level;
    if (typeof level === "string" && effortLevels.has(level)) {
      event.runtimeContext.effortLevel = level as EffortLevel;
    }
  }
  if (typeof value.agent_id === "string") event.runtimeContext.agentId = value.agent_id;
  if (typeof value.agent_type === "string") event.runtimeContext.agentType = value.agent_type;
  if (event.eventName === "SessionStart") {
    if (typeof value.model === "string") event.runtimeContext.modelId = value.model;
    if (typeof value.source === "string") event.runtimeContext.launchMethod = value.source;
  }
  if (event.eventName === "PostModelSwitch") {
    if (typeof value.to_model === "string") event.runtimeContext.modelId = value.to_model;
    if (typeof value.from_model === "string") event.runtimeContext.previousModelId = value.from_model;
    if (typeof value.source === "string") event.runtimeContext.modelSwitchSource = value.source;
  }
  if (typeof value.tool_name === "string") event.toolName = value.tool_name;
  if (typeof value.tool_use_id === "string") event.toolUseId = value.tool_use_id;
  if (typeof value.prompt === "string") event.prompt = value.prompt;
  if (value.tool_input && typeof value.tool_input === "object") event.toolInput = value.tool_input as Record<string, unknown>;
  if ("tool_response" in value) event.toolResponse = value.tool_response;
  return event;
}

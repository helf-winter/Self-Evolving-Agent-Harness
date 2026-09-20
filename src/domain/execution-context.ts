export type PermissionMode = "default" | "plan" | "acceptEdits" | "auto" | "dontAsk" | "bypassPermissions";
export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

export interface RuntimeEventContext {
  promptId?: string;
  permissionMode?: PermissionMode;
  effortLevel?: EffortLevel;
  agentId?: string;
  agentType?: string;
  modelId?: string;
  previousModelId?: string;
  launchMethod?: string;
  modelSwitchSource?: string;
}

export interface ExecutionContext {
  runId: string;
  agentType: string;
  runtimeBindingId: "claude-code-plugin";
  modelInfo: { id: string } | null;
  cwd: string;
  launchMethod: string | null;
  environment: {
    platform: NodeJS.Platform;
    architecture: string;
    nodeVersion: string;
    promptId?: string;
    permissionMode?: PermissionMode;
    effortLevel?: EffortLevel;
    agentId?: string;
    previousModelId?: string;
    modelSwitchSource?: string;
  };
}

export function buildExecutionContext(input: {
  runId: string;
  cwd: string;
  current: RuntimeEventContext;
  previous?: Partial<ExecutionContext>;
}): ExecutionContext {
  const environment: ExecutionContext["environment"] = {
    platform: process.platform,
    architecture: process.arch,
    nodeVersion: process.version,
  };
  if (input.current.promptId !== undefined) environment.promptId = input.current.promptId;
  if (input.current.permissionMode !== undefined) environment.permissionMode = input.current.permissionMode;
  if (input.current.effortLevel !== undefined) environment.effortLevel = input.current.effortLevel;
  if (input.current.agentId !== undefined) environment.agentId = input.current.agentId;
  if (input.current.previousModelId !== undefined) environment.previousModelId = input.current.previousModelId;
  if (input.current.modelSwitchSource !== undefined) environment.modelSwitchSource = input.current.modelSwitchSource;
  const modelId = input.current.modelId ?? input.previous?.modelInfo?.id;
  return {
    runId: input.runId,
    agentType: input.current.agentType ?? "claude-code",
    runtimeBindingId: "claude-code-plugin",
    modelInfo: modelId ? { id: modelId } : null,
    cwd: input.cwd,
    launchMethod: input.current.launchMethod ?? input.previous?.launchMethod ?? null,
    environment,
  };
}

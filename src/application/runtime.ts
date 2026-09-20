import path from "node:path";
import { RuntimeDatabase } from "../storage/database.js";
import { HookIngestionService } from "./hook-ingestion-service.js";
import { EvaluationService } from "./evaluation-service.js";
import { NodeExecutionService } from "./node-execution-service.js";
import { PlanDriftService } from "./plan-drift-service.js";
import { ProjectIdentityService, resolveDataHome } from "./project-identity-service.js";
import { RuntimeQueryService } from "./runtime-query-service.js";
import { RuntimeActionService } from "./runtime-action-service.js";
import { TaskTreeService } from "./task-tree-service.js";
import { WorkflowService } from "./workflow-service.js";

export function openRuntime(environment: NodeJS.ProcessEnv = process.env) {
  const database = new RuntimeDatabase(path.join(resolveDataHome(environment), "runtime.db"));
  const projects = new ProjectIdentityService(database);
  const drifts = new PlanDriftService(database);
  return {
    database,
    projects,
    taskTrees: new TaskTreeService(database),
    workflows: new WorkflowService(database),
    executions: new NodeExecutionService(database),
    evaluations: new EvaluationService(database),
    drifts,
    actions: new RuntimeActionService(database, drifts),
    queries: new RuntimeQueryService(database),
    hooks: new HookIngestionService(database, projects, drifts),
    close: () => database.close(),
  };
}

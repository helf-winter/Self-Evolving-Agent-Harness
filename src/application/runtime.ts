import path from "node:path";
import { RuntimeDatabase } from "../storage/database.js";
import { HookIngestionService } from "./hook-ingestion-service.js";
import { EvaluationService } from "./evaluation-service.js";
import { NodeExecutionService } from "./node-execution-service.js";
import { ProjectIdentityService, resolveDataHome } from "./project-identity-service.js";
import { RuntimeQueryService } from "./runtime-query-service.js";
import { TaskTreeService } from "./task-tree-service.js";
import { WorkflowService } from "./workflow-service.js";

export function openRuntime(environment: NodeJS.ProcessEnv = process.env) {
  const database = new RuntimeDatabase(path.join(resolveDataHome(environment), "runtime.db"));
  const projects = new ProjectIdentityService(database);
  return {
    database,
    projects,
    taskTrees: new TaskTreeService(database),
    workflows: new WorkflowService(database),
    executions: new NodeExecutionService(database),
    evaluations: new EvaluationService(database),
    queries: new RuntimeQueryService(database),
    hooks: new HookIngestionService(database, projects),
    close: () => database.close(),
  };
}

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ReplacementService } from "../../src/application/replacement-service.js";
import { RuntimeDatabase } from "../../src/storage/database.js";

const dirs: string[] = [];

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "harness-replacement-"));
  dirs.push(directory);
  const database = new RuntimeDatabase(path.join(directory, "runtime.db"));
  database.run("INSERT INTO projects (id, canonical_path, created_at, updated_at) VALUES ('p1', '/p1', '2000', '2000')");
  database.run("INSERT INTO projects (id, canonical_path, created_at, updated_at) VALUES ('p2', '/p2', '2000', '2000')");
  const provider = { id: "n1", parentId: null, title: "Provider", children: ["n2"] };
  const consumer = {
    id: "n2", parentId: "n1", title: "Consumer", children: [], objectives: ["Consume API"],
    expectedOutputs: ["src/consumer.ts"], acceptanceCriteria: ["consumer passes"], unresolvedQuestions: [],
    unresolvedDecisions: [], dependencies: ["n1"], requiredEvidence: [{ key: "test", description: "consumer test" }],
    executionPhase: "implementation", stopDecompositionReason: "one consumer",
  };
  const document = {
    nodes: [provider, consumer], relations: [{ fromNodeId: "n2", toNodeId: "n1", kind: "depends_on" }],
    artifacts: [{ id: "contract-artifact", kind: "contract", locator: "api.contract", status: "planned", metadata: {}, granularity: "contract", artifactType: "interface", pathOrName: "api.contract", identityStrategy: "logical_contract_id", confidence: "planned" }],
    artifactContracts: [{ id: "api-contract", artifactId: "contract-artifact", name: "API", version: "1", compatibilityPolicy: "exact", schemaOrSignature: "GET /api", providerNodeIds: ["n1"], consumerNodeIds: ["n2"], validationRefs: ["npm test"] }],
  };
  database.run("INSERT INTO task_trees (id, project_id, title, status, current_revision_id, created_at, updated_at) VALUES ('t1', 'p1', 'Tree', 'confirmed', 'tr1', '2000', '2000')");
  database.run("INSERT INTO task_tree_revisions (id, tree_id, revision, document_json, created_at) VALUES ('tr1', 't1', 1, ?, '2000')", JSON.stringify(document));
  database.run("INSERT INTO task_nodes (id, tree_id, parent_id, title, status) VALUES ('n1', 't1', NULL, 'Provider', 'succeeded')");
  database.run("INSERT INTO task_nodes (id, tree_id, parent_id, title, status) VALUES ('n2', 't1', 'n1', 'Consumer', 'succeeded')");
  database.run("INSERT INTO task_node_revisions (id, node_id, tree_revision_id, body_json, created_at) VALUES ('nr1', 'n1', 'tr1', ?, '2000')", JSON.stringify(provider));
  database.run("INSERT INTO task_node_revisions (id, node_id, tree_revision_id, body_json, created_at) VALUES ('nr2', 'n2', 'tr1', ?, '2000')", JSON.stringify(consumer));
  database.run("INSERT INTO artifacts (id, project_id, tree_id, kind, locator, status, metadata_json, created_at, updated_at, current_hash_or_version) VALUES ('file1', 'p1', 't1', 'file', 'src/api.ts', 'modified', '{}', '2000', '2000', 'hash:current')");
  database.run("INSERT INTO artifacts (id, project_id, tree_id, kind, locator, status, metadata_json, created_at, updated_at, granularity, artifact_type, identity_strategy, confidence) VALUES ('contract-artifact', 'p1', 't1', 'contract', 'api.contract', 'planned', '{}', '2000', '2000', 'contract', 'interface', 'logical_contract_id', 'planned')");
  database.run("INSERT INTO artifact_contracts (id, contract_id, project_id, tree_id, tree_revision_id, artifact_id, contract_name, contract_version, compatibility_policy, schema_or_signature, provider_revision_ids_json, consumer_revision_ids_json, validation_refs_json, created_at) VALUES ('contract-row', 'api-contract', 'p1', 't1', 'tr1', 'contract-artifact', 'API', '1', 'exact', 'GET /api', '[\"nr1\"]', '[\"nr2\"]', '[\"npm test\"]', '2000')");
  database.run("INSERT INTO task_relation_edges (id, tree_revision_id, from_node_id, to_node_id, kind, artifact_id) VALUES ('relation1', 'tr1', 'n2', 'n1', 'depends_on', NULL)");
  database.run("INSERT INTO trace_events (id, project_id, tree_id, node_id, session_id, event_name, payload_json, occurred_at, idempotency_key) VALUES ('trace-n1', 'p1', 't1', 'n1', 's', 'PostToolUse', '{}', '2030', 'trace-n1')");
  database.run("INSERT INTO trace_events (id, project_id, tree_id, node_id, session_id, event_name, payload_json, occurred_at, idempotency_key) VALUES ('trace-n2', 'p1', 't1', 'n2', 's', 'PostToolUse', '{}', '2030', 'trace-n2')");
  database.run("INSERT INTO trace_events (id, project_id, tree_id, node_id, session_id, event_name, payload_json, occurred_at, idempotency_key) VALUES ('foreign', 'p2', NULL, NULL, 's', 'PostToolUse', '{}', '2030', 'foreign')");
  database.run("INSERT INTO trace_events (id, project_id, tree_id, node_id, session_id, event_name, payload_json, occurred_at, idempotency_key) VALUES ('request', 'p1', 't1', 'n1', 's', 'UserPromptSubmit', '{}', '2031', 'request')");
  database.run("INSERT INTO trace_events (id, project_id, tree_id, node_id, session_id, event_name, payload_json, occurred_at, idempotency_key) VALUES ('answer', 'p1', 't1', 'n1', 's', 'UserPromptSubmit', '{}', '2032', 'answer')");
  database.run("INSERT INTO trace_events (id, project_id, tree_id, node_id, session_id, event_name, payload_json, occurred_at, idempotency_key) VALUES ('dispose', 'p1', 't1', 'n1', 's', 'PostToolUse', '{}', '2033', 'dispose')");
  database.run("INSERT INTO trace_events (id, project_id, tree_id, node_id, session_id, event_name, payload_json, occurred_at, idempotency_key) VALUES ('activate', 'p1', 't1', 'n1', 's', 'PostToolUse', '{}', '2034', 'activate')");
  database.run("INSERT INTO trace_events (id, project_id, tree_id, node_id, session_id, event_name, payload_json, occurred_at, idempotency_key) VALUES ('recover', 'p1', 't1', 'n1', 's', 'PostToolUse', '{}', '2035', 'recover')");
  return { database, service: new ReplacementService(database) };
}

afterEach(async () => Promise.all(dirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe("ReplacementService Effect Registry", () => {
  it("registers immutable type-specific revision-owned Effects idempotently", async () => {
    const { database, service } = await fixture();
    const first = service.registerTaskNodeEffect({
      projectId: "p1", ownerRevisionId: "nr1", effectType: "version_reversible",
      targetRef: "artifact:file1", operation: "modify src/api.ts", baselineRef: "hash:current",
      inverseOperation: "restore captured patch", compensationOperation: null, evidenceRefs: ["trace-n1"],
    });
    expect(first).toMatchObject({ created: true, ownerRevisionId: "nr1", disposalStatus: "active", capability: "requires_baseline_check" });
    expect(service.registerTaskNodeEffect({
      projectId: "p1", ownerRevisionId: "nr1", effectType: "version_reversible",
      targetRef: "artifact:file1", operation: "modify src/api.ts", baselineRef: "hash:current",
      inverseOperation: "restore captured patch", compensationOperation: null, evidenceRefs: ["trace-n1"],
    })).toMatchObject({ effectId: first.effectId, created: false });
    expect(() => service.registerTaskNodeEffect({
      projectId: "p1", ownerRevisionId: "nr1", effectType: "reversible",
      targetRef: "runtime:route", operation: "register route", baselineRef: null,
      inverseOperation: null, compensationOperation: null, evidenceRefs: ["trace-n1"],
    })).toThrow(expect.objectContaining({ code: "effect_invalid" }));
    expect(() => service.registerTaskNodeEffect({
      projectId: "p1", ownerRevisionId: "nr1", effectType: "reversible",
      targetRef: "runtime:route", operation: "register route", baselineRef: null,
      inverseOperation: "unregister route", compensationOperation: null, evidenceRefs: ["foreign"],
    })).toThrow(expect.objectContaining({ code: "evidence_scope_mismatch" }));
    database.close();
  });

  it("reports version conflicts for changed baselines or shared active owners", async () => {
    const { database, service } = await fixture();
    const first = service.registerTaskNodeEffect({
      projectId: "p1", ownerRevisionId: "nr1", effectType: "version_reversible",
      targetRef: "artifact:file1", operation: "modify provider", baselineRef: "hash:current",
      inverseOperation: "restore provider", compensationOperation: null, evidenceRefs: ["trace-n1"],
    });
    expect(service.getEffectDisposalCapability({ projectId: "p1", effectId: first.effectId }))
      .toMatchObject({ capability: "requires_baseline_check", baselineMatches: true, hasSharedActiveOwner: false });
    const second = service.registerTaskNodeEffect({
      projectId: "p1", ownerRevisionId: "nr2", effectType: "version_reversible",
      targetRef: "artifact:file1", operation: "modify consumer", baselineRef: "hash:current",
      inverseOperation: "restore consumer", compensationOperation: null, evidenceRefs: ["trace-n2"],
    });
    expect(service.getEffectDisposalCapability({ projectId: "p1", effectId: first.effectId }).hasSharedActiveOwner).toBe(true);
    database.run("UPDATE artifacts SET current_hash_or_version = 'hash:later' WHERE id = 'file1'");
    expect(service.getEffectDisposalCapability({ projectId: "p1", effectId: second.effectId }).baselineMatches).toBe(false);
    expect(() => service.getEffectDisposalCapability({ projectId: "p2", effectId: first.effectId }))
      .toThrow(expect.objectContaining({ code: "not_found" }));
    database.close();
  });

  it("previews an immutable candidate and suspends the reverse dependency closure only after confirmation", async () => {
    const { database, service } = await fixture();
    database.run("INSERT INTO execution_attempts (id, project_id, tree_id, task_node_id, task_node_revision_id, attempt_number, status, started_at) VALUES ('consumer-run', 'p1', 't1', 'n2', 'nr2', 1, 'running', '2030')");
    const preview = service.previewTaskNodeReplacement({
      projectId: "p1", treeId: "t1", nodeId: "n1", expectedTreeRevisionId: "tr1",
      candidateBody: { id: "n1", parentId: null, title: "Provider v2", children: ["n2"] },
      providesContractIds: ["api-contract"], requiresContractIds: [],
      reason: "Replace provider implementation", sourceMessageTraceEventId: "request",
    });
    expect(preview).toMatchObject({
      status: "pending_confirmation", affectedTaskNodeIds: ["n1", "n2"],
      suspensionOrder: ["n2", "n1"], contractDiff: { compatibility: "compatible" },
    });
    expect(database.get<{ current_revision_id: string }>("SELECT current_revision_id FROM task_trees WHERE id = 't1'"))
      .toEqual({ current_revision_id: "tr1" });
    expect(database.all("SELECT id FROM task_node_candidate_revisions")).toHaveLength(1);
    expect(database.all("SELECT id FROM task_node_composition_transitions")).toHaveLength(0);

    const confirmed = service.confirmTaskNodeReplacement({
      projectId: "p1", replacementId: preview.replacementId, answer: "yes", answerTraceEventId: "answer",
    });
    expect(confirmed).toMatchObject({ status: "suspending", suspendedNodeIds: ["n2", "n1"] });
    expect(database.get<{ status: string }>("SELECT status FROM execution_attempts WHERE id = 'consumer-run'"))
      .toEqual({ status: "blocked" });
    expect(database.all<{ composition_state: string }>("SELECT composition_state FROM task_node_composition_states ORDER BY task_node_id"))
      .toEqual([{ composition_state: "suspending" }, { composition_state: "suspending" }]);
    expect(database.all("SELECT id FROM task_node_composition_transitions WHERE replacement_id = ?", preview.replacementId)).toHaveLength(2);
    database.close();
  });

  it("rejects stale previews and leaves state untouched when replacement is declined", async () => {
    const { database, service } = await fixture();
    expect(() => service.previewTaskNodeReplacement({
      projectId: "p1", treeId: "t1", nodeId: "n1", expectedTreeRevisionId: "stale",
      candidateBody: { id: "n1", parentId: null, title: "Provider v2", children: ["n2"] },
      providesContractIds: ["api-contract"], requiresContractIds: [],
      reason: "Replace provider", sourceMessageTraceEventId: "request",
    })).toThrow(expect.objectContaining({ code: "revision_conflict" }));
    const preview = service.previewTaskNodeReplacement({
      projectId: "p1", treeId: "t1", nodeId: "n1", expectedTreeRevisionId: "tr1",
      candidateBody: { id: "n1", parentId: null, title: "Provider v2", children: ["n2"] },
      providesContractIds: ["api-contract"], requiresContractIds: [],
      reason: "Replace provider", sourceMessageTraceEventId: "request",
    });
    expect(service.confirmTaskNodeReplacement({
      projectId: "p1", replacementId: preview.replacementId, answer: "no", answerTraceEventId: "answer",
    })).toMatchObject({ status: "rolled_back", suspendedNodeIds: [] });
    expect(database.all("SELECT id FROM task_node_composition_transitions")).toHaveLength(0);
    database.close();
  });

  it("disposes safe Effects, activates a new immutable Tree revision, and revalidates dependents", async () => {
    const { database, service } = await fixture();
    const effect = service.registerTaskNodeEffect({
      projectId: "p1", ownerRevisionId: "nr1", effectType: "version_reversible",
      targetRef: "artifact:file1", operation: "modify provider", baselineRef: "hash:current",
      inverseOperation: "restore provider", compensationOperation: null, evidenceRefs: ["trace-n1"],
    });
    const preview = service.previewTaskNodeReplacement({
      projectId: "p1", treeId: "t1", nodeId: "n1", expectedTreeRevisionId: "tr1",
      candidateBody: { id: "n1", parentId: null, title: "Provider v2", children: ["n2"] },
      providesContractIds: ["api-contract"], requiresContractIds: [],
      reason: "Replace provider", sourceMessageTraceEventId: "request",
    });
    service.confirmTaskNodeReplacement({ projectId: "p1", replacementId: preview.replacementId, answer: "yes", answerTraceEventId: "answer" });
    const executed = service.executeTaskNodeReplacement({
      projectId: "p1", replacementId: preview.replacementId,
      dispositions: [{
        effectId: effect.effectId, action: "inverse_applied", observedBaselineRef: "hash:current",
        evidenceRefs: ["dispose"], residualImpact: "",
      }],
      activationVerdict: "succeeded", activationEvidenceRefs: ["activate"],
    });
    expect(executed).toMatchObject({ status: "completed", activationVerdict: "succeeded" });
    expect(executed.activatedTreeRevisionId).not.toBe("tr1");
    expect(database.get<{ title: string }>("SELECT title FROM task_nodes WHERE id = 'n1'")).toEqual({ title: "Provider v2" });
    expect(database.get<{ disposal_status: string }>("SELECT disposal_status FROM task_node_effects WHERE id = ?", effect.effectId))
      .toEqual({ disposal_status: "disposed" });
    expect(database.get<{ status: string }>("SELECT status FROM task_nodes WHERE id = 'n2'")).toEqual({ status: "needs_revalidation" });
    expect(database.get<{ composition_state: string }>("SELECT composition_state FROM task_node_composition_states WHERE task_node_id = 'n2'"))
      .toEqual({ composition_state: "active" });
    const activeRevision = database.get<{ id: string }>("SELECT nr.id FROM task_node_revisions nr JOIN task_trees t ON t.current_revision_id = nr.tree_revision_id WHERE nr.node_id = 'n1' AND t.id = 't1'")!;
    expect(database.get<{ provides_contract_ids_json: string }>("SELECT provides_contract_ids_json FROM task_node_revision_contract_bindings WHERE task_node_revision_id = ?", activeRevision.id))
      .toEqual({ provides_contract_ids_json: '["api-contract"]' });
    expect(database.get("SELECT id FROM task_node_revisions WHERE id = 'nr1'")).toBeTruthy();
    database.close();
  });

  it("persists shared-target conflicts without partially activating the candidate", async () => {
    const { database, service } = await fixture();
    const effect = service.registerTaskNodeEffect({
      projectId: "p1", ownerRevisionId: "nr1", effectType: "version_reversible",
      targetRef: "artifact:file1", operation: "modify provider", baselineRef: "hash:current",
      inverseOperation: "restore provider", compensationOperation: null, evidenceRefs: ["trace-n1"],
    });
    service.registerTaskNodeEffect({
      projectId: "p1", ownerRevisionId: "nr2", effectType: "version_reversible",
      targetRef: "artifact:file1", operation: "modify consumer", baselineRef: "hash:current",
      inverseOperation: "restore consumer", compensationOperation: null, evidenceRefs: ["trace-n2"],
    });
    const preview = service.previewTaskNodeReplacement({
      projectId: "p1", treeId: "t1", nodeId: "n1", expectedTreeRevisionId: "tr1",
      candidateBody: { id: "n1", parentId: null, title: "Provider v2", children: ["n2"] },
      providesContractIds: ["api-contract"], requiresContractIds: [], reason: "Replace", sourceMessageTraceEventId: "request",
    });
    service.confirmTaskNodeReplacement({ projectId: "p1", replacementId: preview.replacementId, answer: "yes", answerTraceEventId: "answer" });
    expect(service.executeTaskNodeReplacement({
      projectId: "p1", replacementId: preview.replacementId,
      dispositions: [{ effectId: effect.effectId, action: "inverse_applied", observedBaselineRef: "hash:current", evidenceRefs: ["dispose"], residualImpact: "shared file" }],
      activationVerdict: "succeeded", activationEvidenceRefs: ["activate"],
    })).toMatchObject({ status: "disposing", blockedEffectIds: [effect.effectId] });
    expect(database.get<{ current_revision_id: string }>("SELECT current_revision_id FROM task_trees WHERE id = 't1'"))
      .toEqual({ current_revision_id: "tr1" });
    expect(database.get<{ disposal_status: string }>("SELECT disposal_status FROM effect_disposal_results WHERE replacement_id = ?", preview.replacementId))
      .toEqual({ disposal_status: "conflict" });
    database.close();
  });

  it("keeps the old revision on activation failure and recovers suspended state with new evidence", async () => {
    const { database, service } = await fixture();
    const preview = service.previewTaskNodeReplacement({
      projectId: "p1", treeId: "t1", nodeId: "n1", expectedTreeRevisionId: "tr1",
      candidateBody: { id: "n1", parentId: null, title: "Broken candidate", children: ["n2"] },
      providesContractIds: ["api-contract"], requiresContractIds: [], reason: "Try candidate", sourceMessageTraceEventId: "request",
    });
    service.confirmTaskNodeReplacement({ projectId: "p1", replacementId: preview.replacementId, answer: "yes", answerTraceEventId: "answer" });
    expect(service.executeTaskNodeReplacement({
      projectId: "p1", replacementId: preview.replacementId, dispositions: [],
      activationVerdict: "failed", activationEvidenceRefs: ["activate"],
    })).toMatchObject({ status: "replacement_failed", activatedTreeRevisionId: null });
    expect(database.get<{ current_revision_id: string }>("SELECT current_revision_id FROM task_trees WHERE id = 't1'"))
      .toEqual({ current_revision_id: "tr1" });
    expect(service.recoverTaskNodeReplacement({
      projectId: "p1", replacementId: preview.replacementId, recoveryVerdict: "restored", evidenceRefs: ["recover"],
    })).toMatchObject({ status: "rolled_back", restored: true });
    expect(database.get<{ status: string }>("SELECT status FROM task_nodes WHERE id = 'n1'")).toEqual({ status: "succeeded" });
    expect(database.all<{ composition_state: string }>("SELECT composition_state FROM task_node_composition_states ORDER BY task_node_id"))
      .toEqual([{ composition_state: "active" }, { composition_state: "active" }]);
    database.close();
  });
});

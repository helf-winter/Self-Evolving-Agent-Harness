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
  database.run("INSERT INTO task_trees (id, project_id, title, status, current_revision_id, created_at, updated_at) VALUES ('t1', 'p1', 'Tree', 'confirmed', 'tr1', '2000', '2000')");
  database.run("INSERT INTO task_tree_revisions (id, tree_id, revision, document_json, created_at) VALUES ('tr1', 't1', 1, '{}', '2000')");
  database.run("INSERT INTO task_nodes (id, tree_id, parent_id, title, status) VALUES ('n1', 't1', NULL, 'Provider', 'succeeded')");
  database.run("INSERT INTO task_nodes (id, tree_id, parent_id, title, status) VALUES ('n2', 't1', 'n1', 'Consumer', 'succeeded')");
  database.run("INSERT INTO task_node_revisions (id, node_id, tree_revision_id, body_json, created_at) VALUES ('nr1', 'n1', 'tr1', '{}', '2000')");
  database.run("INSERT INTO task_node_revisions (id, node_id, tree_revision_id, body_json, created_at) VALUES ('nr2', 'n2', 'tr1', '{}', '2000')");
  database.run("INSERT INTO artifacts (id, project_id, tree_id, kind, locator, status, metadata_json, created_at, updated_at, current_hash_or_version) VALUES ('file1', 'p1', 't1', 'file', 'src/api.ts', 'modified', '{}', '2000', '2000', 'hash:current')");
  database.run("INSERT INTO trace_events (id, project_id, tree_id, node_id, session_id, event_name, payload_json, occurred_at, idempotency_key) VALUES ('trace-n1', 'p1', 't1', 'n1', 's', 'PostToolUse', '{}', '2030', 'trace-n1')");
  database.run("INSERT INTO trace_events (id, project_id, tree_id, node_id, session_id, event_name, payload_json, occurred_at, idempotency_key) VALUES ('trace-n2', 'p1', 't1', 'n2', 's', 'PostToolUse', '{}', '2030', 'trace-n2')");
  database.run("INSERT INTO trace_events (id, project_id, tree_id, node_id, session_id, event_name, payload_json, occurred_at, idempotency_key) VALUES ('foreign', 'p2', NULL, NULL, 's', 'PostToolUse', '{}', '2030', 'foreign')");
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
});

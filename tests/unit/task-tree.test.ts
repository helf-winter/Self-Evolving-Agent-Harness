import { describe, expect, it } from "vitest";
import { normalizeTaskTreeDocument, validateTaskTree } from "../../src/domain/task-tree.js";

const leaf = {
  id: "leaf",
  parentId: "root",
  title: "Implement storage",
  objectives: ["Persist one project"],
  expectedOutputs: ["runtime.db"],
  acceptanceCriteria: ["record survives reopen"],
  unresolvedQuestions: [],
  unresolvedDecisions: [],
  dependencies: [],
  requiredEvidence: [{ key: "integration-test", description: "Integration test passes" }],
  executionPhase: "implementation" as const,
  stopDecompositionReason: "One independently verifiable change",
  children: [],
};

describe("Task Tree validation", () => {
  it("accepts one valid root and a complete leaf contract", () => {
    const result = validateTaskTree({
      nodes: [{ id: "root", parentId: null, title: "Runtime", children: ["leaf"] }, leaf],
      relations: [],
      artifacts: [],
    });
    expect(result).toEqual({ ok: true, errors: [] });
  });

  it("rejects cycles and incomplete leaf contracts", () => {
    const result = validateTaskTree({
      nodes: [
        { id: "root", parentId: "leaf", title: "Runtime", children: ["leaf"] },
        { ...leaf, children: ["root"], stopDecompositionReason: "" },
      ],
      relations: [],
      artifacts: [],
    });
    expect(result.ok).toBe(false);
    expect(result.errors.map((error) => error.code)).toContain("invalid_tree_structure");
  });

  it("requires call and data relations to reference an Artifact contract", () => {
    const result = validateTaskTree({
      nodes: [{ id: "root", parentId: null, title: "Runtime", children: ["leaf"] }, leaf],
      relations: [{ fromNodeId: "root", toNodeId: "leaf", kind: "data_exchange" }],
      artifacts: [],
    });
    expect(result).toEqual({
      ok: false,
      errors: [{ code: "relation_artifact_required", path: "relations[0].artifactId" }],
    });
  });

  it("enforces the canonical relation-to-Artifact matrix", () => {
    const base = {
      nodes: [{ id: "root", parentId: null, title: "Runtime", children: ["leaf"] }, leaf],
      artifacts: [],
    };
    for (const kind of ["calls", "exchanges_data_with", "shares_artifact_with"] as const) {
      expect(validateTaskTree({ ...base, relations: [{ fromNodeId: "root", toNodeId: "leaf", kind }] }).errors)
        .toContainEqual({ code: "relation_artifact_required", path: "relations[0].artifactId" });
    }
    expect(validateTaskTree({
      ...base,
      relations: [{ fromNodeId: "root", toNodeId: "leaf", kind: "depends_on", dependencyKind: "execution_order" }],
    }).ok).toBe(true);
    expect(validateTaskTree({
      ...base,
      relations: [{ fromNodeId: "root", toNodeId: "leaf", kind: "depends_on", dependencyKind: "contract_ready" }],
    }).errors).toContainEqual({ code: "relation_artifact_required", path: "relations[0].artifactId" });
    expect(validateTaskTree({
      ...base,
      relations: [{ fromNodeId: "root", toNodeId: "leaf", kind: "coordinates_with", coordinationKind: "schedule_only" }],
    }).ok).toBe(true);
    expect(validateTaskTree({
      ...base,
      relations: [{ fromNodeId: "root", toNodeId: "leaf", kind: "coordinates_with", coordinationKind: "integration_check" }],
    }).errors).toContainEqual({ code: "relation_artifact_required", path: "relations[0].artifactId" });
  });

  it("requires both sides of a shared Artifact relation to reference the same Artifact", () => {
    const result = validateTaskTree({
      nodes: [{ id: "root", parentId: null, title: "Runtime", children: ["leaf"] }, leaf],
      relations: [{ fromNodeId: "root", toNodeId: "leaf", kind: "shares_artifact_with", artifactId: "shared" }],
      artifacts: [{ id: "shared", kind: "contract", locator: "shared-api" }],
      artifactLinks: [{ taskNodeId: "root", artifactId: "shared", relationType: "plans" }],
    });
    expect(result.errors).toContainEqual({ code: "relation_artifact_required", path: "relations[0].artifactId" });
  });

  it("normalizes historical relation aliases for newly persisted revisions", () => {
    const normalized = normalizeTaskTreeDocument({
      nodes: [{ id: "root", parentId: null, title: "Runtime", children: ["leaf"] }, leaf],
      relations: [
        { fromNodeId: "root", toNodeId: "leaf", kind: "data_exchange", artifactId: "shared" },
        { fromNodeId: "leaf", toNodeId: "root", kind: "shares_contract", artifactId: "shared" },
      ],
      artifacts: [{ id: "shared", kind: "contract", locator: "shared-api" }],
    });
    expect(normalized.relations.map((relation) => relation.kind)).toEqual(["exchanges_data_with", "shares_artifact_with"]);
  });

  it("rejects duplicate required evidence keys", () => {
    const result = validateTaskTree({
      nodes: [
        { id: "root", parentId: null, title: "Runtime", children: ["leaf"] },
        {
          ...leaf,
          requiredEvidence: [
            { key: "integration-test", description: "Integration test passes" },
            { key: "integration-test", description: "Build also passes" },
          ],
        },
      ],
      relations: [],
      artifacts: [],
    });
    expect(result).toEqual({
      ok: false,
      errors: [{ code: "leaf_contract_invalid", path: "nodes.leaf" }],
    });
  });
});

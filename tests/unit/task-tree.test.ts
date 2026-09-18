import { describe, expect, it } from "vitest";
import { validateTaskTree } from "../../src/domain/task-tree.js";

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

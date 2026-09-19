import { describe, expect, it } from "vitest";
import { normalizeArtifactInput } from "../../src/domain/artifact-graph.js";
import { validateTaskTree, type TaskTreeDocument } from "../../src/domain/task-tree.js";

const leaf = {
  id: "leaf", parentId: null, title: "Implement API", children: [], objectives: ["Implement API"],
  expectedOutputs: ["src/api.ts"], acceptanceCriteria: ["API passes"], unresolvedQuestions: [], unresolvedDecisions: [],
  dependencies: [], requiredEvidence: [{ key: "test", description: "tests" }], executionPhase: "implementation" as const,
  stopDecompositionReason: "one verifiable API",
};

function document(overrides: Partial<TaskTreeDocument> = {}): TaskTreeDocument {
  return { nodes: [leaf], relations: [], artifacts: [], ...overrides };
}

describe("Artifact Graph planning contracts", () => {
  it("derives stable structural defaults without inventing symbol detail", () => {
    expect(normalizeArtifactInput({ id: "file", kind: "file", locator: "src/api.ts" })).toEqual({
      id: "file", kind: "file", locator: "src/api.ts", status: "draft", granularity: "structural",
      artifactType: "file", pathOrName: "src/api.ts", parentArtifactId: null, identityStrategy: "path",
      confidence: "planned", metadata: {},
    });
  });

  it("rejects Task/Artifact links and Artifact relations with missing references", () => {
    const result = validateTaskTree(document({
      artifactLinks: [{ taskNodeId: "missing", artifactId: "missing", relationType: "plans" }],
      artifactRelations: [{ fromArtifactId: "missing-a", toArtifactId: "missing-b", kind: "calls" }],
    }));
    expect(result.errors).toEqual(expect.arrayContaining([
      { code: "artifact_reference_invalid", path: "artifactLinks[0]" },
      { code: "artifact_reference_invalid", path: "artifactRelations[0]" },
    ]));
  });

  it("requires a contract carrier plus valid provider and consumer nodes", () => {
    const result = validateTaskTree(document({
      artifacts: [{ id: "file", kind: "file", locator: "src/api.ts" }],
      artifactContracts: [{
        id: "api-contract", artifactId: "file", name: "Login API", version: "1", compatibilityPolicy: "exact",
        schemaOrSignature: "POST /login", providerNodeIds: ["leaf"], consumerNodeIds: ["missing"], validationRefs: ["test"],
      }],
    }));
    expect(result.errors).toContainEqual({ code: "artifact_contract_invalid", path: "artifactContracts[0]" });
  });

  it("accepts a contract Artifact shared by valid provider and consumer nodes", () => {
    const consumer = { ...leaf, id: "consumer", parentId: "root", dependencies: ["provider"] };
    const provider = { ...leaf, id: "provider", parentId: "root" };
    const valid = document({
      nodes: [{ id: "root", parentId: null, title: "Root", children: ["provider", "consumer"] }, provider, consumer],
      artifacts: [{ id: "api", kind: "contract", locator: "contract:login-api" }],
      artifactLinks: [
        { taskNodeId: "provider", artifactId: "api", relationType: "implements" },
        { taskNodeId: "consumer", artifactId: "api", relationType: "consumes" },
      ],
      artifactContracts: [{
        id: "api-contract", artifactId: "api", name: "Login API", version: "1", compatibilityPolicy: "backward_compatible",
        schemaOrSignature: "POST /login", providerNodeIds: ["provider"], consumerNodeIds: ["consumer"], validationRefs: ["contract-test"],
      }],
    });
    expect(validateTaskTree(valid)).toEqual({ ok: true, errors: [] });
  });
});

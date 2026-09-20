import { describe, expect, it } from "vitest";
import {
  classifyProjectLocation,
  mapClonedTaskNodeStatus,
  parseProjectIdentityMarker,
  rebaseCloneLocator,
  rewriteTaskTreeDocumentForClone,
  serializeProjectIdentityMarker,
} from "../../src/domain/project-clone.js";

describe("Project Clone domain policy", () => {
  it("parses token-backed markers and accepts legacy markers only as upgrade candidates", () => {
    expect(parseProjectIdentityMarker({
      schema_version: 1, project_id: "project-1", identity_token: "secret-token",
    })).toEqual({ schemaVersion: 1, projectId: "project-1", identityToken: "secret-token", legacy: false });
    expect(parseProjectIdentityMarker({ version: 1, projectId: "legacy-project" })).toEqual({
      schemaVersion: 1, projectId: "legacy-project", identityToken: null, legacy: true,
    });
    expect(parseProjectIdentityMarker({ schema_version: 1, project_id: "project-1" })).toBeNull();
    expect(JSON.parse(serializeProjectIdentityMarker({
      projectId: "project-1", identityToken: "secret-token",
    }))).toEqual({ schema_version: 1, project_id: "project-1", identity_token: "secret-token" });
  });

  it("classifies a changed path conservatively from source availability", () => {
    expect(classifyProjectLocation({ samePath: true, sourceAvailability: "exists" })).toBe("same_project");
    expect(classifyProjectLocation({ samePath: false, sourceAvailability: "missing" })).toBe("moved_or_renamed");
    expect(classifyProjectLocation({ samePath: false, sourceAvailability: "exists" })).toBe("copy_detected");
    expect(classifyProjectLocation({ samePath: false, sourceAvailability: "unknown" })).toBe("identity_conflict");
  });

  it("maps cloned execution state without pretending live or unverified work continues", () => {
    expect(mapClonedTaskNodeStatus("draft", false)).toBe("draft");
    expect(mapClonedTaskNodeStatus("ready", false)).toBe("ready");
    expect(mapClonedTaskNodeStatus("running", false)).toBe("paused_after_clone");
    expect(mapClonedTaskNodeStatus("verifying", false)).toBe("needs_revalidation");
    expect(mapClonedTaskNodeStatus("succeeded", false)).toBe("needs_revalidation");
    expect(mapClonedTaskNodeStatus("succeeded", true)).toBe("succeeded");
    expect(mapClonedTaskNodeStatus("failed", false)).toBe("failed");
  });

  it("rebases internal absolute paths and marks external absolute paths", () => {
    expect(rebaseCloneLocator("src/api.ts", "C:/source", "D:/copy")).toEqual({
      locator: "src/api.ts", externalReference: false,
    });
    expect(rebaseCloneLocator("C:/source/src/api.ts", "C:/source", "D:/copy")).toEqual({
      locator: "d:/copy/src/api.ts", externalReference: false,
    });
    expect(rebaseCloneLocator("C:/shared/schema.json", "C:/source", "D:/copy")).toEqual({
      locator: "c:/shared/schema.json", externalReference: true,
    });
  });

  it("rewrites every internal Task Tree and Artifact reference while preserving structure", () => {
    const rewritten = rewriteTaskTreeDocumentForClone({
      document: {
        nodes: [
          { id: "root", parentId: null, title: "Root", children: ["leaf"] },
          {
            id: "leaf", parentId: "root", title: "Leaf", children: [], objectives: ["Implement"],
            expectedOutputs: ["src/api.ts"], acceptanceCriteria: ["passes"], unresolvedQuestions: [],
            unresolvedDecisions: [], dependencies: ["root"], requiredEvidence: [{ key: "test", description: "passes" }],
            executionPhase: "implementation", stopDecompositionReason: "one output",
          },
        ],
        relations: [{ fromNodeId: "leaf", toNodeId: "root", kind: "calls", artifactId: "contract" }],
        artifacts: [
          { id: "file", kind: "file", locator: "C:/source/src/api.ts", status: "modified" },
          { id: "contract", kind: "contract", locator: "api.contract", status: "planned", parentArtifactId: "file" },
        ],
        artifactLinks: [{ taskNodeId: "leaf", artifactId: "file", relationType: "modifies" }],
        artifactRelations: [{ fromArtifactId: "file", toArtifactId: "contract", kind: "uses_schema" }],
        artifactContracts: [{
          id: "api", artifactId: "contract", name: "API", version: "1", compatibilityPolicy: "exact",
          schemaOrSignature: "GET /api", providerNodeIds: ["root"], consumerNodeIds: ["leaf"], validationRefs: ["npm test"],
        }],
      },
      nodeIds: new Map([["root", "root-copy"], ["leaf", "leaf-copy"]]),
      artifactIds: new Map([["file", "file-copy"], ["contract", "contract-copy"]]),
      sourceRoot: "C:/source", targetRoot: "D:/copy",
    });
    expect(rewritten.nodes).toEqual([
      expect.objectContaining({ id: "root-copy", parentId: null, children: ["leaf-copy"] }),
      expect.objectContaining({ id: "leaf-copy", parentId: "root-copy", dependencies: ["root-copy"] }),
    ]);
    expect(rewritten.relations).toEqual([expect.objectContaining({
      fromNodeId: "leaf-copy", toNodeId: "root-copy", artifactId: "contract-copy",
    })]);
    expect(rewritten.artifacts).toEqual([
      expect.objectContaining({ id: "file-copy", locator: "d:/copy/src/api.ts", status: "planned" }),
      expect.objectContaining({ id: "contract-copy", parentArtifactId: "file-copy" }),
    ]);
    expect(rewritten.artifactLinks).toEqual([{ taskNodeId: "leaf-copy", artifactId: "file-copy", relationType: "modifies" }]);
    expect(rewritten.artifactContracts).toEqual([expect.objectContaining({
      artifactId: "contract-copy", providerNodeIds: ["root-copy"], consumerNodeIds: ["leaf-copy"],
    })]);
  });
});

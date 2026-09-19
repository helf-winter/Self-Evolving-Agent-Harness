import { describe, expect, it } from "vitest";
import {
  deriveConfirmationStates,
  resolveConfirmationScope,
} from "../../src/domain/confirmation.js";
import type { TaskTreeDocument } from "../../src/domain/task-tree.js";

const document: TaskTreeDocument = {
  nodes: [
    { id: "root", parentId: null, title: "Root", children: ["branch-a", "branch-b"] },
    { id: "branch-a", parentId: "root", title: "A", children: ["leaf-a"] },
    { id: "leaf-a", parentId: "branch-a", title: "A leaf", children: [] },
    { id: "branch-b", parentId: "root", title: "B", children: ["leaf-b"] },
    { id: "leaf-b", parentId: "branch-b", title: "B leaf", children: [] },
  ],
  relations: [],
  artifacts: [],
};

describe("confirmation scope", () => {
  it("returns every node for a tree scope in document order", () => {
    expect(resolveConfirmationScope(document)).toEqual(["root", "branch-a", "leaf-a", "branch-b", "leaf-b"]);
  });

  it("returns only the selected branch descendant closure", () => {
    expect(resolveConfirmationScope(document, "branch-a")).toEqual(["branch-a", "leaf-a"]);
  });

  it("returns null for an unknown branch root", () => {
    expect(resolveConfirmationScope(document, "missing")).toBeNull();
  });
});

describe("confirmation projection", () => {
  it("marks confirmed nodes, partial ancestors, and unrelated siblings", () => {
    expect(deriveConfirmationStates(document, new Set(["branch-a", "leaf-a"]), new Set())).toEqual({
      root: "partial_confirmed",
      "branch-a": "confirmed",
      "leaf-a": "confirmed",
      "branch-b": "draft",
      "leaf-b": "draft",
    });
  });

  it("uses pending confirmation for changed nodes without hiding confirmed descendants", () => {
    expect(deriveConfirmationStates(document, new Set(["leaf-a"]), new Set(["branch-a", "leaf-b"]))).toEqual({
      root: "partial_confirmed",
      "branch-a": "pending_user_confirmation",
      "leaf-a": "confirmed",
      "branch-b": "draft",
      "leaf-b": "pending_user_confirmation",
    });
  });
});

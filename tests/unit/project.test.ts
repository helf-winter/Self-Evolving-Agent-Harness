import { describe, expect, it } from "vitest";
import { normalizeProjectPath, pathsReferToSameProject } from "../../src/domain/project.js";

describe("project path normalization", () => {
  it("normalizes Windows paths without changing their project boundary", () => {
    expect(normalizeProjectPath("D:\\Code\\Project-A\\")).toBe("d:/Code/Project-A");
  });

  it("recognizes a registered WSL alias but not an unregistered parent", () => {
    expect(pathsReferToSameProject("D:\\Code\\Project-A", "/mnt/d/Code/Project-A")).toBe(true);
    expect(pathsReferToSameProject("D:\\Code\\Project-A", "D:\\Code")).toBe(false);
  });
});

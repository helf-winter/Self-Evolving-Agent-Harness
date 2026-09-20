import { describe, expect, it } from "vitest";
import { restoredTaskTreeStatus } from "../../src/domain/task-collection.js";

describe("Task Tree collection policy", () => {
  it.each([undefined, null, "", "   ", "archived"])(
    "restores an invalid prior status %s conservatively as draft",
    (status) => expect(restoredTaskTreeStatus(status)).toBe("draft"),
  );

  it.each(["draft", "confirmed", "in_progress", "completed", "failed"])(
    "restores the exact valid prior status %s",
    (status) => expect(restoredTaskTreeStatus(status)).toBe(status),
  );
});

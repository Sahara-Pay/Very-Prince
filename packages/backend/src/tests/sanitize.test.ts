import { describe, it, expect } from "vitest";
import { sanitizeText } from "../utils/sanitize.js";

describe("sanitizeText", () => {
  it("strips script tags", () => {
    expect(sanitizeText('<script>alert("xss")</script>Hello')).toBe("Hello");
  });

  it("strips event-handler attributes and tags, keeping text", () => {
    expect(sanitizeText('<img src=x onerror="alert(1)">A org<b>desc</b>')).toBe("A orgdesc");
  });

  it("leaves plain text untouched", () => {
    expect(sanitizeText("A grant fund for open source maintainers.")).toBe(
      "A grant fund for open source maintainers."
    );
  });

  it("trims surrounding whitespace", () => {
    expect(sanitizeText("  padded  ")).toBe("padded");
  });
});

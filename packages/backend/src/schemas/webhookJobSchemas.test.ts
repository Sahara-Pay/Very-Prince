import { describe, expect, it } from "vitest";
import { webhookJobDataSchema } from "./webhookJobSchemas.js";

describe("webhookJobDataSchema", () => {
  it("accepts deeply typed JSON event data", () => {
    expect(webhookJobDataSchema.parse({
      organizationId: "org-1",
      event: "block.finalized",
      data: { ledger: 123, hashes: ["abc"], metadata: { final: true } },
    })).toEqual(expect.objectContaining({ event: "block.finalized" }));
  });

  it.each([
    { organizationId: "", event: "event", data: {} },
    { organizationId: "org-1", event: "", data: {} },
    { organizationId: "org-1", event: "event", data: { invalid: undefined } },
    { organizationId: "org-1", event: "event", data: {}, unexpected: true },
  ])("rejects malformed queue input %#", (input) => {
    expect(webhookJobDataSchema.safeParse(input).success).toBe(false);
  });
});

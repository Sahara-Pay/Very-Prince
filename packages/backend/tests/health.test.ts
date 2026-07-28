import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { healthRoutes } from "../src/routes/health.js";

describe("GET /health", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports that the service is running", async () => {
    const uptime = 123.456;
    vi.spyOn(process, "uptime").mockReturnValue(uptime);

    const app = Fastify({ logger: false });
    await app.register(rateLimit, {
      global: true,
      max: 1,
      timeWindow: "1 minute",
    });
    await app.register(healthRoutes, { prefix: "/health" });

    const response = await app.inject({ method: "GET", url: "/health" });
    const repeatedResponse = await app.inject({
      method: "GET",
      url: "/health",
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(repeatedResponse.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(body).toEqual({
      status: "ok",
      version: "0.1.0",
      timestamp: expect.any(String),
      uptime,
    });
    expect(Number.isNaN(Date.parse(body.timestamp))).toBe(false);

    await app.close();
  });
});

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import path from "path";

describe("Soroban SDK Dependency Audit", () => {
  const cargoTomlPath = path.resolve(__dirname, "../../../contracts/Cargo.toml");

  it("should have updated soroban-sdk version to 21.7.7 in Cargo.toml", () => {
    expect(existsSync(cargoTomlPath)).toBe(true);
    const content = readFileSync(cargoTomlPath, "utf8");
    
    // Validate both dependencies and dev-dependencies have 21.7.7
    const runtimeMatch = content.match(/soroban-sdk\s*=\s*\{\s*version\s*=\s*"([^"]+)"/);
    const devMatch = content.match(/soroban-sdk\s*=\s*\{\s*version\s*=\s*"([^"]+)"\s*,\s*features/);
    
    expect(runtimeMatch).not.toBeNull();
    expect(runtimeMatch![1]).toBe("21.7.7");

    expect(devMatch).not.toBeNull();
    expect(devMatch![1]).toBe("21.7.7");
  });
});

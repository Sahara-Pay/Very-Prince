import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import path from "path";

const SRC_DIR = path.resolve(__dirname, "..");

function findAllTsFiles(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === "dist") continue;
      findAllTsFiles(full, files);
    } else if (entry.endsWith(".ts")) {
      files.push(full);
    }
  }
  return files;
}

const DANGEROUS_PATTERNS = [
  {
    name: "$queryRaw (raw SQL execution)",
    regex: /\$queryRaw(Unsafe)?\s*\(/g,
  },
  {
    name: "$executeRaw (raw SQL execution)",
    regex: /\$executeRaw(Unsafe)?\s*\(/g,
  },
  {
    name: "Template literal in SQL context (tagged template)",
    regex: /\.raw\s*`/g,
  },
  {
    name: "Direct string interpolation in SQL-like strings",
    regex: /(?:SELECT|INSERT|UPDATE|DELETE|FROM|WHERE|JOIN|ORDER BY|GROUP BY)\s+.*\$\{/gi,
  },
];

const tsFiles = findAllTsFiles(SRC_DIR).filter(
  (f) => !f.includes("/migrations/")
);

describe("SQL Injection Audit", () => {
  it("should not contain any raw SQL execution methods in application code", () => {
    const violations: string[] = [];

    for (const file of tsFiles) {
      const content = readFileSync(file, "utf-8");
      const relPath = path.relative(SRC_DIR, file);

      for (const { name, regex } of DANGEROUS_PATTERNS) {
        const matches = content.matchAll(new RegExp(regex.source, regex.flags));
        for (const match of matches) {
          const lineNum = content.substring(0, match.index).split("\n").length;
          violations.push(`${relPath}:${lineNum} — ${name}`);
        }
      }
    }

    expect(
      violations,
      `Found potential SQL injection vectors:\n${violations.join("\n")}`
    ).toHaveLength(0);
  });

  it("should use the shared PrismaClient singleton from services/db", () => {
    const violations: string[] = [];

    for (const file of tsFiles) {
      const relPath = path.relative(SRC_DIR, file);
      const content = readFileSync(file, "utf-8");

      const lines = content.split("\n");
      lines.forEach((line, idx) => {
        if (
          /new\s+PrismaClient\s*\(/.test(line) &&
          !relPath.includes("services/db.ts")
        ) {
          violations.push(`${relPath}:${idx + 1} — creates a separate PrismaClient instance`);
        }
      });
    }

    expect(
      violations,
      `Found duplicate PrismaClient instances (should use shared singleton from services/db):\n${violations.join("\n")}`
    ).toHaveLength(0);
  });

  it("should use Zod validation on all route handler inputs", () => {
    const routeFiles = tsFiles.filter(
      (f) => f.includes("/routes/") || f.includes("/controllers/")
    );

    const missingValidation: string[] = [];

    for (const file of routeFiles) {
      const content = readFileSync(file, "utf-8");
      const relPath = path.relative(SRC_DIR, file);

      const hasQueryAccess = /request\.(query|params|body)/.test(content);
      const hasZodImport = /from\s+["']zod["']/.test(content);
      const hasSchemaValidation = /schema\s*:/.test(content) || /\.parse\(/.test(content);

      if (hasQueryAccess && !hasZodImport && !hasSchemaValidation) {
        missingValidation.push(relPath);
      }
    }

    expect(
      missingValidation,
      `Route files access request inputs without Zod validation:\n${missingValidation.join("\n")}`
    ).toHaveLength(0);
  });
});

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import path from "path";

const SRC_DIR = path.resolve(__dirname, "..");

// The audit test itself contains the raw-SQL pattern strings, so it must not
// scan its own source.
const SELF_RELPATH = "tests/sqlInjectionAudit.test.ts";

/**
 * Modules that intentionally execute raw SQL. The indexer bulk upsert engine
 * is the only one: it uses `Prisma.sql` tagged templates exclusively — every
 * value reaches Postgres as a bound parameter (never interpolated into the
 * statement text) and every identifier is a static constant. Its safety is
 * enforced by dedicated unit tests that assert no row value ever appears in
 * the generated SQL text (see indexerBulkUpsert.test.ts).
 */
const PARAMETERIZED_RAW_SQL_MODULES = new Set([
  "services/indexerBulkUpsert.ts",
]);

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

const tsFiles = findAllTsFiles(SRC_DIR).filter((file) => {
  const relPath = path.relative(SRC_DIR, file).replace(/\\/g, "/");
  return !relPath.includes("/migrations/") && relPath !== SELF_RELPATH;
});

describe("SQL Injection Audit", () => {
  it("should not use unparameterized raw SQL execution methods", () => {
    const violations: string[] = [];

    for (const file of tsFiles) {
      const content = readFileSync(file, "utf-8");
      const relPath = path.relative(SRC_DIR, file).replace(/\\/g, "/");

      // $queryRawUnsafe / $executeRawUnsafe interpolate values directly into
      // the SQL text by definition — never acceptable anywhere.
      for (const match of content.matchAll(/\$queryRawUnsafe\s*\(/g)) {
        const lineNum = content.substring(0, match.index).split("\n").length;
        violations.push(`${relPath}:${lineNum} — $queryRawUnsafe (unparameterized raw SQL)`);
      }
      for (const match of content.matchAll(/\$executeRawUnsafe\s*\(/g)) {
        const lineNum = content.substring(0, match.index).split("\n").length;
        violations.push(`${relPath}:${lineNum} — $executeRawUnsafe (unparameterized raw SQL)`);
      }

      // $queryRaw / $executeRaw are only safe when handed a parameterized
      // Prisma.sql tagged template. Flag any use outside the allow-listed
      // parameterized engine above.
      if (!PARAMETERIZED_RAW_SQL_MODULES.has(relPath)) {
        for (const match of content.matchAll(/\$queryRaw\s*\(/g)) {
          const lineNum = content.substring(0, match.index).split("\n").length;
          violations.push(`${relPath}:${lineNum} — $queryRaw without Prisma.sql parameterization`);
        }
        for (const match of content.matchAll(/\$executeRaw\s*\(/g)) {
          const lineNum = content.substring(0, match.index).split("\n").length;
          violations.push(`${relPath}:${lineNum} — $executeRaw without Prisma.sql parameterization`);
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

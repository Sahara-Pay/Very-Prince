import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "fs";
import path from "path";

describe("Database Schema Indexes", () => {
  const migrationsDir = path.resolve(__dirname, "../../prisma/migrations");

  it("should contain the index on orgId for the Maintainer table in migrations", () => {
    expect(existsSync(migrationsDir)).toBe(true);

    const migrationFolders = readdirSync(migrationsDir);
    let indexFound = false;

    for (const folder of migrationFolders) {
      const sqlPath = path.join(migrationsDir, folder, "migration.sql");
      if (existsSync(sqlPath)) {
        const sqlContent = readFileSync(sqlPath, "utf8");
        // Check for index creation matching PostgreSQL double-quoted identifiers
        if (
          /CREATE\s+INDEX\s+"Maintainer_orgId_idx"\s+ON\s+"Maintainer"\s*\(\s*"orgId"\s*\)/i.test(
            sqlContent
          )
        ) {
          indexFound = true;
          break;
        }
      }
    }

    expect(indexFound).toBe(true);
  });
});

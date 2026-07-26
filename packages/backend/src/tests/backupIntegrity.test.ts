import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync as _readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { gzipSync } from "zlib";

const SCRIPT_PATH = join(__dirname, "..", "..", "..", "..", "scripts", "verify-backup.sh");

function makeValidDump(): string {
  const tables = [
    "Organization",
    "Transaction",
    "PayoutEvent",
    "Maintainer",
    "IndexerState",
    "VerifiedContract",
    "Invoice",
    "WebhookConfig",
    "WebhookDelivery",
    "ApiKey",
    "MaintainerNotification",
  ];

  let sql = "-- PostgreSQL database dump\n";
  sql += "-- very-prince backup\n\n";

  for (const table of tables) {
    sql += `CREATE TABLE IF NOT EXISTS "${table}" (\n`;
    sql += `  id text PRIMARY KEY,\n`;
    sql += `  "createdAt" timestamp(3) NOT NULL DEFAULT now()\n`;
    sql += `);\n\n`;
  }

  sql += 'COPY "Organization" (id, "createdAt") FROM stdin;\n';
  sql += "stellar\t2026-01-01 00:00:00\n";
  sql += "\\.\n\n";

  return sql;
}

function gzipString(content: string): Buffer {
  return gzipSync(Buffer.from(content));
}

function runScript(
  backupPath: string,
  envOverrides: Record<string, string> = {}
): { exitCode: number; stdout: string } {
  try {
    const stdout = execSync(`bash "${SCRIPT_PATH}" "${backupPath}"`, {
      encoding: "utf-8",
      timeout: 15_000,
      env: { ...process.env, ...envOverrides },
    });
    return { exitCode: 0, stdout };
  } catch (err: unknown) {
    const execErr = err as { status: number; stdout: string };
    return { exitCode: execErr.status, stdout: execErr.stdout ?? "" };
  }
}

describe("verify-backup.sh — Post-backup Integrity Verification", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "vp-verify-test-"));
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should pass all checks for a valid backup", () => {
    const sql = makeValidDump();
    const backupPath = join(tmpDir, "valid.sql.gz");
    writeFileSync(backupPath, gzipString(sql));

    const { exitCode, stdout } = runScript(backupPath);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("BACKUP INTEGRITY CHECK PASSED");
    expect(stdout).toContain("Gzip structure is valid");
    expect(stdout).toContain("Table found: Organization");
    expect(stdout).toContain("Table found: Maintainer");
    expect(stdout).toContain("Table found: Invoice");
    expect(stdout).toContain("Found 1 COPY statement");
  });

  it("should fail when backup file does not exist", () => {
    const { exitCode, stdout } = runScript("/tmp/nonexistent_backup_999.sql.gz");

    expect(exitCode).toBe(1);
    expect(stdout).toContain("INTEGRITY CHECK FAILED");
  });

  it("should fail when backup file is empty", () => {
    const backupPath = join(tmpDir, "empty.sql.gz");
    writeFileSync(backupPath, Buffer.alloc(0));

    const { exitCode, stdout } = runScript(backupPath);

    expect(exitCode).toBe(1);
    expect(stdout).toContain("INTEGRITY CHECK FAILED");
    expect(stdout).toContain("empty");
  });

  it("should fail when file is not valid gzip", () => {
    const backupPath = join(tmpDir, "notgzip.sql.gz");
    writeFileSync(backupPath, "this is not gzip content");

    const { exitCode, stdout } = runScript(backupPath);

    expect(exitCode).toBe(1);
    expect(stdout).toContain("INTEGRITY CHECK FAILED");
    expect(stdout).toContain("gzip");
  });

  it("should fail when required tables are missing", () => {
    let sql = "-- PostgreSQL database dump\n";
    sql += 'CREATE TABLE "Organization" (id text PRIMARY KEY);\n';

    const backupPath = join(tmpDir, "missing-tables.sql.gz");
    writeFileSync(backupPath, gzipString(sql));

    const { exitCode, stdout } = runScript(backupPath);

    expect(exitCode).toBe(1);
    expect(stdout).toContain("INTEGRITY CHECK FAILED");
    expect(stdout).toContain("Table NOT found: Maintainer");
    expect(stdout).toContain("Table NOT found: Invoice");
  });

  it("should fail when parentheses are unbalanced", () => {
    let sql = "-- PostgreSQL database dump\n";
    sql += "CREATE TABLE \"Organization\" (id text PRIMARY KEY;\n";
    sql += 'COPY "Organization" FROM stdin;\n';
    sql += "\\.\n";

    const backupPath = join(tmpDir, "unbalanced.sql.gz");
    writeFileSync(backupPath, gzipString(sql));

    const { exitCode, stdout } = runScript(backupPath);

    expect(exitCode).toBe(1);
    expect(stdout).toContain("Parentheses unbalanced");
  });

  it("should detect partition tables when present", () => {
    const sql = makeValidDump() +
      'CREATE TABLE "Transaction_2026_01" (LIKE "Transaction" INCLUDING ALL);\n' +
      'CREATE TABLE "PayoutEvent_2026_01" (LIKE "PayoutEvent" INCLUDING ALL);\n';

    const backupPath = join(tmpDir, "with-partitions.sql.gz");
    writeFileSync(backupPath, gzipString(sql));

    const { exitCode, stdout } = runScript(backupPath);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("partition");
  });

  it("should handle backup with no COPY statements gracefully", () => {
    let sql = "-- PostgreSQL database dump\n";
    const tables = [
      "Organization", "Transaction", "PayoutEvent", "Maintainer",
      "IndexerState", "VerifiedContract", "Invoice", "WebhookConfig",
      "WebhookDelivery", "ApiKey", "MaintainerNotification",
    ];

    for (const table of tables) {
      sql += `CREATE TABLE IF NOT EXISTS "${table}" (id text PRIMARY KEY);\n`;
    }

    const backupPath = join(tmpDir, "empty-db.sql.gz");
    writeFileSync(backupPath, gzipString(sql));

    const { exitCode, stdout } = runScript(backupPath);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("No COPY statements");
  });

  it("should auto-detect latest backup when no argument given", () => {
    const sql = makeValidDump();
    const backupPath = join(tmpDir, "very_prince_backup_2026-07-16_12-00-00.sql.gz");
    writeFileSync(backupPath, gzipString(sql));

    const { exitCode, stdout: _stdout } = runScript(tmpDir + "/../nonexistent");

    expect(exitCode).toBe(1);
  });
});

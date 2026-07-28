#!/bin/bash
# verify-backup.sh — Post-backup database integrity verification for very-prince
# Validates that a PostgreSQL backup file is structurally sound and contains all
# expected schema objects before it is relied upon for disaster recovery.
#
# Usage:
#   ./scripts/verify-backup.sh /path/to/backup.sql.gz
#   ./scripts/verify-backup.sh              # auto-detects latest in /tmp
#
# Exit codes:
#   0 — Backup passed all integrity checks
#   1 — Backup failed one or more integrity checks

set -uo pipefail

# ─── Constants ────────────────────────────────────────────────────────────────

EXPECTED_TABLES=(
  "Organization"
  "Transaction"
  "PayoutEvent"
  "Maintainer"
  "IndexerState"
  "VerifiedContract"
  "Invoice"
  "WebhookConfig"
  "WebhookDelivery"
  "ApiKey"
  "MaintainerNotification"
)

REQUIRED_PATTERNS=(
  "PostgreSQL database dump"
  "CREATE TABLE"
)

FAILURES=0

# ─── Helpers ──────────────────────────────────────────────────────────────────

pass() {
  echo "  ✅ $1"
}

fail() {
  echo "  ❌ $1"
  FAILURES=$((FAILURES + 1))
}

info() {
  echo "ℹ️  $1"
}

count_matches() {
  local pattern="$1"
  local file="$2"
  local count
  count=$(grep -cE "$pattern" "$file" 2>/dev/null || true)
  echo "${count:-0}" | xargs
}

# ─── Resolve backup file ─────────────────────────────────────────────────────

BACKUP_FILE="${1:-}"

if [ -z "$BACKUP_FILE" ]; then
  info "No file argument provided. Searching /tmp for latest very_prince backup..."
  BACKUP_FILE=$(ls -t /tmp/very_prince_backup_*.sql.gz 2>/dev/null | head -n 1)
  if [ -z "$BACKUP_FILE" ]; then
    echo "❌ No backup files found in /tmp matching very_prince_backup_*.sql.gz"
    exit 1
  fi
  info "Found: $BACKUP_FILE"
fi

echo ""
echo "🔍 Verifying backup integrity: $BACKUP_FILE"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ─── 1. File existence & non-empty ────────────────────────────────────────────

echo ""
echo "📋 Check 1: File existence and size"

if [ ! -f "$BACKUP_FILE" ]; then
  fail "File does not exist: $BACKUP_FILE"
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "❌ INTEGRITY CHECK FAILED ($FAILURES issue(s) found)"
  exit 1
fi

FILE_SIZE=$(stat -c%s "$BACKUP_FILE" 2>/dev/null || stat -f%z "$BACKUP_FILE" 2>/dev/null)

if [ "$FILE_SIZE" -eq 0 ]; then
  fail "Backup file is empty (0 bytes)"
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "❌ INTEGRITY CHECK FAILED ($FAILURES issue(s) found)"
  exit 1
fi

pass "File exists — $FILE_SIZE bytes"

# ─── 2. Gzip integrity ───────────────────────────────────────────────────────

echo ""
echo "📋 Check 2: Gzip compression integrity"

if gzip -t "$BACKUP_FILE" 2>/dev/null; then
  pass "Gzip structure is valid"
else
  fail "File is not a valid gzip archive or is corrupted"
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "❌ INTEGRITY CHECK FAILED ($FAILURES issue(s) found)"
  exit 1
fi

# ─── 3. Decompress and validate SQL content ───────────────────────────────────

echo ""
echo "📋 Check 3: SQL dump structure validation"

TMPSQL=$(mktemp /tmp/verify_backup_XXXXXX.sql)
trap 'rm -f "$TMPSQL"' EXIT

gunzip -c "$BACKUP_FILE" > "$TMPSQL"

DECOMPRESSED_SIZE=$(stat -c%s "$TMPSQL" 2>/dev/null || stat -f%z "$TMPSQL" 2>/dev/null)

if [ "$DECOMPRESSED_SIZE" -eq 0 ]; then
  fail "Decompressed SQL dump is empty"
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "❌ INTEGRITY CHECK FAILED ($FAILURES issue(s) found)"
  exit 1
fi

pass "Decompressed successfully — $DECOMPRESSED_SIZE bytes"

# ─── 4. Required PostgreSQL dump markers ──────────────────────────────────────

echo ""
echo "📋 Check 4: PostgreSQL dump markers"

for pattern in "${REQUIRED_PATTERNS[@]}"; do
  if grep -q "$pattern" "$TMPSQL"; then
    pass "Found required pattern: \"$pattern\""
  else
    fail "Missing required pattern: \"$pattern\""
  fi
done

# ─── 5. Table presence verification ───────────────────────────────────────────

echo ""
echo "📋 Check 5: Expected table verification"

TABLES_FOUND=0
TABLES_MISSING=0

for table in "${EXPECTED_TABLES[@]}"; do
  if grep -qiE "CREATE TABLE[[:space:]]+IF NOT EXISTS[[:space:]]+\"${table}\"" "$TMPSQL" || grep -qiE "CREATE TABLE[[:space:]]+\"${table}\"" "$TMPSQL"; then
    pass "Table found: $table"
    TABLES_FOUND=$((TABLES_FOUND + 1))
  else
    fail "Table NOT found: $table"
    TABLES_MISSING=$((TABLES_MISSING + 1))
  fi
done

echo ""
info "Tables found: $TABLES_FOUND / ${#EXPECTED_TABLES[@]}"

# ─── 6. Partition tables check ───────────────────────────────────────────────

echo ""
echo "📋 Check 6: Partition table detection"

PARTITION_COUNT=$(count_matches 'CREATE TABLE[[:space:]]+"(Transaction|PayoutEvent)_[0-9]{4}_[0-9]{2}"' "$TMPSQL")

if [ "$PARTITION_COUNT" -gt 0 ]; then
  pass "Found $PARTITION_COUNT partition table(s)"
else
  echo "  ⚠️  No partition tables detected (may be expected for small databases)"
fi

# ─── 7. COPY statement verification (data presence) ──────────────────────────

echo ""
echo "📋 Check 7: Data presence via COPY statements"

COPY_COUNT=$(count_matches '^COPY ' "$TMPSQL")

if [ "$COPY_COUNT" -gt 0 ]; then
  pass "Found $COPY_COUNT COPY statement(s) — data present"
else
  echo "  ⚠️  No COPY statements found (database may be empty, which could be valid)"
fi

# ─── 8. SQL syntax basic integrity ───────────────────────────────────────────

echo ""
echo "📋 Check 8: SQL syntax sanity checks"

OPEN_PARENS=$(grep -o "(" "$TMPSQL" | wc -l | xargs)
CLOSE_PARENS=$(grep -o ")" "$TMPSQL" | wc -l | xargs)

if [ "$OPEN_PARENS" -eq "$CLOSE_PARENS" ]; then
  pass "Parentheses balanced ($OPEN_PARENS pairs)"
else
  fail "Parentheses unbalanced: $OPEN_PARENS open vs $CLOSE_PARENS close"
fi

NON_SQL=$(count_matches '^[^[:space:]-/\\*]' "$TMPSQL" || true)
if [ "$NON_SQL" -gt 0 ]; then
  echo "  ⚠️  Found $NON_SQL line(s) outside standard SQL structure (may be comments or metadata)"
else
  pass "SQL structure looks clean"
fi

# ─── Summary ──────────────────────────────────────────────────────────────────

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if [ "$FAILURES" -eq 0 ]; then
  echo "🎉 BACKUP INTEGRITY CHECK PASSED — All checks OK"
  exit 0
else
  echo "❌ INTEGRITY CHECK FAILED — $FAILURES issue(s) found"
  exit 1
fi

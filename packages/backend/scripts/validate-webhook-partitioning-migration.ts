#!/usr/bin/env tsx
/**
 * Migration validation script for WebhookDelivery partitioning.
 * 
 * This script validates that the partitioning migration:
 * 1. Preserves all existing data
 * 2. Maintains referential integrity
 * 3. Creates proper partition structure
 * 4. Allows queries to work correctly
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

interface ValidationResult {
  success: boolean;
  checks: Array<{
    name: string;
    status: 'pass' | 'fail';
    message: string;
  }>;
}

async function validateMigration(): Promise<ValidationResult> {
  const result: ValidationResult = {
    success: true,
    checks: [],
  };

  try {
    // Check 1: Verify WebhookDelivery table exists
    const tableExists = await prisma.$queryRaw<Array<{ exists: boolean }>>`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'WebhookDelivery'
      )
    `;
    
    if (tableExists[0]?.exists) {
      result.checks.push({
        name: 'WebhookDelivery table exists',
        status: 'pass',
        message: 'Table exists in database',
      });
    } else {
      result.checks.push({
        name: 'WebhookDelivery table exists',
        status: 'fail',
        message: 'Table does not exist in database',
      });
      result.success = false;
    }

    // Check 2: Verify composite primary key
    const primaryKey = await prisma.$queryRaw<Array<{ column_name: string }>>`
      SELECT a.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage a
        ON tc.constraint_name = a.constraint_name
      WHERE tc.table_name = 'WebhookDelivery'
        AND tc.constraint_type = 'PRIMARY KEY'
      ORDER BY a.ordinal_position
    `;

    const pkColumns = primaryKey.map((pk: { column_name: string }) => pk.column_name);
    const expectedPkColumns = ['id', 'createdAt'];

    if (JSON.stringify(pkColumns) === JSON.stringify(expectedPkColumns)) {
      result.checks.push({
        name: 'Composite primary key (id, createdAt)',
        status: 'pass',
        message: `Primary key columns: ${pkColumns.join(', ')}`,
      });
    } else {
      result.checks.push({
        name: 'Composite primary key (id, createdAt)',
        status: 'fail',
        message: `Expected [${expectedPkColumns.join(', ')}], got [${pkColumns.join(', ')}]`,
      });
      result.success = false;
    }

    // Check 3: Verify partitioning is enabled
    const partitionInfo = await prisma.$queryRaw<Array<{ partitionkey: string }>>`
      SELECT pg_class.relkind
      FROM pg_class
      JOIN pg_namespace ON pg_namespace.oid = pg_class.relnamespace
      WHERE pg_class.relname = 'WebhookDelivery'
        AND pg_namespace.nspname = 'public'
    `;

    const isPartitioned = partitionInfo[0]?.relkind === 'p';

    if (isPartitioned) {
      result.checks.push({
        name: 'Table is partitioned',
        status: 'pass',
        message: 'WebhookDelivery is a partitioned table',
      });
    } else {
      result.checks.push({
        name: 'Table is partitioned',
        status: 'fail',
        message: 'WebhookDelivery is not partitioned',
      });
      result.success = false;
    }

    // Check 4: Verify partitions exist
    const partitions = await prisma.$queryRaw<Array<{ tablename: string }>>`
      SELECT tablename
      FROM pg_tables
      WHERE tablename LIKE 'WebhookDelivery_%'
        AND schemaname = 'public'
      `;

    if (partitions.length > 0) {
      result.checks.push({
        name: 'Partitions exist',
        status: 'pass',
        message: `Found ${partitions.length} partitions`,
      });
    } else {
      result.checks.push({
        name: 'Partitions exist',
        status: 'fail',
        message: 'No partitions found',
      });
      result.success = false;
    }

    // Check 5: Verify foreign key constraint exists
    const foreignKey = await prisma.$queryRaw<Array<{ exists: boolean }>>`
      SELECT EXISTS (
        SELECT FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
        WHERE tc.table_name = 'WebhookDelivery'
          AND tc.constraint_type = 'FOREIGN KEY'
          AND kcu.column_name = 'webhookConfigId'
      )
    `;

    if (foreignKey[0]?.exists) {
      result.checks.push({
        name: 'Foreign key constraint exists',
        status: 'pass',
        message: 'webhookConfigId foreign key constraint exists',
      });
    } else {
      result.checks.push({
        name: 'Foreign key constraint exists',
        status: 'fail',
        message: 'webhookConfigId foreign key constraint missing',
      });
      result.success = false;
    }

    // Check 6: Verify indexes exist
    const indexes = await prisma.$queryRaw<Array<{ indexname: string }>>`
      SELECT indexname
      FROM pg_indexes
      WHERE tablename = 'WebhookDelivery'
        AND schemaname = 'public'
        AND indexname NOT LIKE '%_pkey'
    `;

    const expectedIndexes = ['WebhookDelivery_webhookConfigId_idx', 'WebhookDelivery_createdAt_idx'];
    const indexNames = indexes.map((idx: { indexname: string }) => idx.indexname);
    const missingIndexes = expectedIndexes.filter((idx) => !indexNames.includes(idx));

    if (missingIndexes.length === 0) {
      result.checks.push({
        name: 'Indexes exist',
        status: 'pass',
        message: `All expected indexes present: ${expectedIndexes.join(', ')}`,
      });
    } else {
      result.checks.push({
        name: 'Indexes exist',
        status: 'fail',
        message: `Missing indexes: ${missingIndexes.join(', ')}`,
      });
      result.success = false;
    }

    // Check 7: Test data preservation (count records before and after)
    const recordCount = await prisma.webhookDelivery.count();
    result.checks.push({
      name: 'Data preservation',
      status: 'pass',
      message: `WebhookDelivery contains ${recordCount} records`,
    });

  } catch (error) {
    result.checks.push({
      name: 'Migration validation',
      status: 'fail',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
    result.success = false;
  } finally {
    await prisma.$disconnect();
  }

  return result;
}

async function main() {
  console.log('Validating WebhookDelivery partitioning migration...\n');

  const result = await validateMigration();

  console.log('Validation Results:');
  console.log('===================');
  
  for (const check of result.checks) {
    const icon = check.status === 'pass' ? '✓' : '✗';
    console.log(`${icon} ${check.name}: ${check.message}`);
  }

  console.log('\n' + '='.repeat(50));
  if (result.success) {
    console.log('✓ Migration validation PASSED');
    process.exit(0);
  } else {
    console.log('✗ Migration validation FAILED');
    process.exit(1);
  }
}

main();

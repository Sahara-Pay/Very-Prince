/**
 * @file rate-limiting-example.ts
 * @description Examples demonstrating the token bucket rate limiter behavior.
 * 
 * Run this file to see how different request patterns interact with the rate limiter.
 * 
 * Usage:
 *   npx tsx docs/examples/rate-limiting-example.ts
 */

interface RateLimitResponse {
  statusCode?: number;
  error?: string;
  message?: string;
  retryAfter?: number;
  remainingTokens?: number;
  cost?: number;
  routes?: Array<{ path: string; weight: number }>;
}

const API_BASE = 'http://localhost:3001';

/**
 * Helper to make tRPC requests and show rate limit headers.
 */
async function makeTRPCRequest(
  routePath: string,
  input: any = {},
  label: string = ''
): Promise<void> {
  const url = `${API_BASE}/trpc/${routePath}`;
  const displayLabel = label || routePath;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });

    const rateLimitInfo = {
      limit: response.headers.get('X-RateLimit-Limit'),
      remaining: response.headers.get('X-RateLimit-Remaining'),
      cost: response.headers.get('X-RateLimit-Cost'),
      retryAfter: response.headers.get('Retry-After'),
    };

    if (response.status === 429) {
      const data: RateLimitResponse = await response.json();
      console.log(`❌ [${response.status}] ${displayLabel}`);
      console.log(`   Message: ${data.message}`);
      console.log(`   Remaining: ${data.remainingTokens} tokens`);
      console.log(`   Retry After: ${data.retryAfter}s`);
      console.log(`   Cost: ${data.cost}`);
    } else {
      console.log(`✅ [${response.status}] ${displayLabel}`);
      console.log(`   Remaining: ${rateLimitInfo.remaining} tokens`);
      console.log(`   Cost: ${rateLimitInfo.cost}`);
    }
  } catch (error) {
    console.error(`💥 Error: ${displayLabel}`, error);
  }
}

/**
 * Helper to check rate limit status.
 */
async function checkRateLimitStatus(): Promise<void> {
  try {
    const response = await fetch(`${API_BASE}/api/v1/rate-limit/status`);
    const data = await response.json();

    console.log('\n📊 Current Rate Limit Status:');
    console.log(`   Identifier: ${data.identifier}`);
    console.log(`   Current Tokens: ${data.currentTokens}/${data.capacity}`);
    console.log(`   Utilization: ${data.utilization}`);
    console.log(`   Refill Rate: ${data.refillRate} tokens/sec\n`);
  } catch (error) {
    console.error('💥 Error checking rate limit status', error);
  }
}

/**
 * Helper to reset rate limit.
 */
async function resetRateLimit(): Promise<void> {
  try {
    const response = await fetch(`${API_BASE}/api/v1/rate-limit/reset`, {
      method: 'POST',
    });
    const data = await response.json();
    console.log(`🔄 Rate limit reset: ${data.message}\n`);
  } catch (error) {
    console.error('💥 Error resetting rate limit', error);
  }
}

/**
 * Helper to wait with progress indicator.
 */
async function wait(seconds: number, message: string = ''): Promise<void> {
  if (message) console.log(`⏳ ${message}`);
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

// ─────────────────────────────────────────────────────────────────────────────
// EXAMPLE 1: Lightweight vs Heavy Routes
// ─────────────────────────────────────────────────────────────────────────────

async function example1_lightweightVsHeavy(): Promise<void> {
  console.log('\n' + '='.repeat(80));
  console.log('EXAMPLE 1: Lightweight vs Heavy Routes');
  console.log('='.repeat(80) + '\n');

  await resetRateLimit();
  await checkRateLimitStatus();

  console.log('Making 10 lightweight requests (weight=1 each)...\n');
  for (let i = 1; i <= 10; i++) {
    await makeTRPCRequest('contract.getStatus', {}, `Request ${i}/10`);
  }

  await checkRateLimitStatus();

  console.log('Making 5 heavy requests (weight=20 each)...\n');
  for (let i = 1; i <= 5; i++) {
    await makeTRPCRequest('analytics.getLeaderboard', {}, `Request ${i}/5`);
    await wait(0.1);
  }

  await checkRateLimitStatus();
}

// ─────────────────────────────────────────────────────────────────────────────
// EXAMPLE 2: Batched Requests
// ─────────────────────────────────────────────────────────────────────────────

async function example2_batchedRequests(): Promise<void> {
  console.log('\n' + '='.repeat(80));
  console.log('EXAMPLE 2: Batched Requests');
  console.log('='.repeat(80) + '\n');

  await resetRateLimit();
  await checkRateLimitStatus();

  console.log('Making a batched request (multiple routes in one call)...\n');
  await makeTRPCRequest(
    'contract.getStatus,organization.get,stats.getTVL',
    {},
    'Batched: getStatus + org.get + getTVL'
  );

  await checkRateLimitStatus();

  console.log('Making another batched request with heavy routes...\n');
  await makeTRPCRequest(
    'stats.getGlobalStats,analytics.getLeaderboard',
    {},
    'Batched: globalStats + leaderboard'
  );

  await checkRateLimitStatus();
}

// ─────────────────────────────────────────────────────────────────────────────
// EXAMPLE 3: Rate Limit Exhaustion and Recovery
// ─────────────────────────────────────────────────────────────────────────────

async function example3_exhaustionAndRecovery(): Promise<void> {
  console.log('\n' + '='.repeat(80));
  console.log('EXAMPLE 3: Rate Limit Exhaustion and Recovery');
  console.log('='.repeat(80) + '\n');

  await resetRateLimit();
  await checkRateLimitStatus();

  console.log('Exhausting the bucket with heavy requests...\n');
  for (let i = 1; i <= 10; i++) {
    await makeTRPCRequest('analytics.getLeaderboard', {}, `Heavy Request ${i}/10`);
    await wait(0.1);
  }

  await checkRateLimitStatus();

  console.log('Waiting 5 seconds for token refill (50 tokens at 10/sec)...\n');
  await wait(5, 'Refilling tokens...');

  await checkRateLimitStatus();

  console.log('Making requests after refill...\n');
  await makeTRPCRequest('stats.getGlobalStats', {}, 'After refill (weight=10)');
  await makeTRPCRequest('organization.get', {}, 'After refill (weight=3)');

  await checkRateLimitStatus();
}

// ─────────────────────────────────────────────────────────────────────────────
// EXAMPLE 4: Asymmetric DoS Protection
// ─────────────────────────────────────────────────────────────────────────────

async function example4_asymmetricDoSProtection(): Promise<void> {
  console.log('\n' + '='.repeat(80));
  console.log('EXAMPLE 4: Asymmetric DoS Protection');
  console.log('='.repeat(80) + '\n');

  await resetRateLimit();
  await checkRateLimitStatus();

  console.log('Scenario: Attacker tries to exhaust resources with heavy queries...\n');

  console.log('Attacker makes 3 expensive leaderboard queries (60 tokens)...\n');
  for (let i = 1; i <= 3; i++) {
    await makeTRPCRequest('analytics.getLeaderboard', {}, `Attacker Request ${i}/3`);
    await wait(0.1);
  }

  await checkRateLimitStatus();

  console.log('Attacker makes 2 more heavy queries (40 tokens)...\n');
  for (let i = 4; i <= 5; i++) {
    await makeTRPCRequest('analytics.getLeaderboard', {}, `Attacker Request ${i}/5`);
    await wait(0.1);
  }

  await checkRateLimitStatus();

  console.log('Attacker is now rate limited! ❌\n');
  await makeTRPCRequest('analytics.getLeaderboard', {}, 'Attacker Request 6 (BLOCKED)');

  console.log('\nLegitimate users can still make lightweight requests:\n');
  for (let i = 1; i <= 5; i++) {
    await makeTRPCRequest('contract.getStatus', {}, `Legitimate Request ${i}/5`);
    await wait(0.1);
  }

  await checkRateLimitStatus();
}

// ─────────────────────────────────────────────────────────────────────────────
// EXAMPLE 5: Mixed Traffic Pattern
// ─────────────────────────────────────────────────────────────────────────────

async function example5_mixedTrafficPattern(): Promise<void> {
  console.log('\n' + '='.repeat(80));
  console.log('EXAMPLE 5: Mixed Traffic Pattern (Realistic Usage)');
  console.log('='.repeat(80) + '\n');

  await resetRateLimit();
  await checkRateLimitStatus();

  console.log('Simulating realistic mixed traffic...\n');

  const requests = [
    { route: 'contract.getStatus', label: 'Health Check' },
    { route: 'organization.get', label: 'Get Organization' },
    { route: 'contract.getStatus', label: 'Health Check' },
    { route: 'stats.getTVL', label: 'Get TVL' },
    { route: 'organization.list', label: 'List Organizations' },
    { route: 'contract.getStatus', label: 'Health Check' },
    { route: 'stats.getFundingHistory', label: 'Funding History' },
    { route: 'stats.getGlobalStats', label: 'Global Stats (Heavy)' },
    { route: 'contract.getStatus', label: 'Health Check' },
    { route: 'analytics.getLeaderboard', label: 'Leaderboard (Very Heavy)' },
  ];

  for (const req of requests) {
    await makeTRPCRequest(req.route, {}, req.label);
    await wait(0.2);
  }

  await checkRateLimitStatus();
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Runner
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('\n');
  console.log('╔════════════════════════════════════════════════════════════════════════════╗');
  console.log('║                  TOKEN BUCKET RATE LIMITER EXAMPLES                        ║');
  console.log('╚════════════════════════════════════════════════════════════════════════════╝');

  try {
    // Check if server is running
    const response = await fetch(`${API_BASE}/health`);
    if (!response.ok) {
      throw new Error('Server is not running');
    }
    console.log('✅ Server is running at', API_BASE);
  } catch (error) {
    console.error('❌ Cannot connect to server at', API_BASE);
    console.error('   Please start the backend server first:');
    console.error('   $ cd packages/backend && npm run dev\n');
    process.exit(1);
  }

  // Run examples
  await example1_lightweightVsHeavy();
  await example2_batchedRequests();
  await example3_exhaustionAndRecovery();
  await example4_asymmetricDoSProtection();
  await example5_mixedTrafficPattern();

  console.log('\n' + '='.repeat(80));
  console.log('✨ All examples completed!');
  console.log('='.repeat(80) + '\n');
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}

export {
  example1_lightweightVsHeavy,
  example2_batchedRequests,
  example3_exhaustionAndRecovery,
  example4_asymmetricDoSProtection,
  example5_mixedTrafficPattern,
};

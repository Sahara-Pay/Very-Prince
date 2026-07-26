# Token Bucket Rate Limiting

## Overview

The Very-Prince backend implements a **dynamic token bucket rate limiter** that protects backend CPU resources from asymmetric DoS attacks by assigning computational cost weights to different tRPC routes.

Unlike standard IP-based rate limiting that treats all endpoints equally, this implementation:

- **Penalizes heavy analytical queries** while allowing lightweight health checks to flow freely
- **Uses distributed Redis state** to correctly throttle users across multiple scaled backend instances
- **Executes token deduction atomically** using Lua scripts to prevent race conditions
- **Returns strict RFC-compliant 429 responses** with `Retry-After` headers when the bucket depletes

## Architecture

### Components

```
┌──────────────────┐
│  Client Request  │
└────────┬─────────┘
         │
         ▼
┌─────────────────────────────────┐
│  tokenBucketMiddleware          │
│  - Extract route paths          │
│  - Calculate total cost         │
│  - Check token bucket           │
└────────┬────────────────────────┘
         │
         ▼
┌─────────────────────────────────┐
│  tokenBucketService             │
│  - Load Lua script              │
│  - Execute atomic deduction     │
│  - Return allow/deny decision   │
└────────┬────────────────────────┘
         │
         ▼
┌─────────────────────────────────┐
│  Redis (Lua Script)             │
│  - Refill tokens based on time  │
│  - Deduct cost atomically       │
│  - Calculate retry-after        │
└─────────────────────────────────┘
```

### Files

- **`src/trpc/tokenBucketMiddleware.ts`** - Fastify preHandler that intercepts requests
- **`src/services/tokenBucketService.ts`** - Redis-backed token bucket implementation
- **`src/config/rateLimitConfig.ts`** - Route cost weights configuration
- **`src/redis/tokenBucket.lua`** - Atomic token deduction Lua script
- **`src/routes/rateLimit.ts`** - Monitoring and management endpoints

## Configuration

### Token Bucket Settings

Default configuration in `src/config/rateLimitConfig.ts`:

```typescript
export const tokenBucketConfig = {
  enabled: true,
  capacity: 100,        // 100 tokens per bucket
  refillRate: 10,       // 10 tokens per second (600 per minute)
  logRejections: true,
};
```

### Route Cost Weights

Each tRPC route is assigned a computational cost weight:

| Weight | Category | Example Routes |
|--------|----------|----------------|
| 1 | Lightweight | `contract.getStatus`, `contract.getDetails` |
| 3-5 | Medium | `organization.get`, `organization.list`, `stats.getTVL` |
| 10-20 | Heavy | `stats.getGlobalStats`, `stats.getTopMaintainers`, `analytics.getLeaderboard` |
| 25+ | Very Heavy | `sync.forceSync` |

Routes not explicitly configured default to weight **5**.

### Example Cost Configuration

```typescript
{
  route: 'analytics.getLeaderboard',
  weight: 20,
  description: 'Complex multi-dimensional leaderboard calculation',
}
```

## How It Works

### 1. Request Interception

When a tRPC request arrives at `/trpc/:path`, the `tokenBucketMiddleware` runs before the procedure handler:

```typescript
server.post('/trpc/:path', {
  preHandler: [tokenBucketMiddleware, queryComplexityMiddleware],
}, async (request, reply) => { ... });
```

### 2. Cost Calculation

The middleware parses batched route paths and calculates total cost:

```typescript
// Single route
"organization.get" → cost = 3

// Batched routes
"organization.get,stats.getTVL,contract.getStatus" → cost = 3 + 4 + 1 = 8
```

### 3. Token Bucket Check

The service calls Redis via Lua script to:

1. **Calculate elapsed time** since last refill
2. **Add tokens** based on `refillRate × elapsed`
3. **Cap at capacity** (no overflow)
4. **Check if cost ≤ available tokens**
5. **Deduct tokens** if allowed, or calculate `retry-after` if denied

### 4. Response

**If allowed:**
```http
HTTP/1.1 200 OK
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 92
X-RateLimit-Cost: 8
```

**If denied:**
```http
HTTP/1.1 429 Too Many Requests
Retry-After: 5
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 2
X-RateLimit-Cost: 8
X-RateLimit-Reset: 1672531200

{
  "statusCode": 429,
  "error": "Too Many Requests",
  "message": "Rate limit exceeded. You have consumed 8 tokens but only 2 remain. Retry after 5 seconds.",
  "retryAfter": 5,
  "remainingTokens": 2,
  "cost": 8,
  "routes": [
    { "path": "organization.get", "weight": 3 },
    { "path": "stats.getTVL", "weight": 4 },
    { "path": "contract.getStatus", "weight": 1 }
  ]
}
```

## Lua Script

The atomic token deduction script (`src/redis/tokenBucket.lua`):

```lua
-- Retrieve current bucket state
local tokens = tonumber(bucket[1]) or capacity
local lastRefill = tonumber(bucket[2]) or currentTime

-- Calculate tokens to add based on elapsed time
local elapsed = math.max(0, currentTime - lastRefill)
local tokensToAdd = elapsed * refillRate
tokens = math.min(capacity, tokens + tokensToAdd)

-- Check if we have enough tokens
if tokens >= cost then
  tokens = tokens - cost
  redis.call('HMSET', bucketKey, 'tokens', tokens, 'lastRefill', currentTime)
  return {1, tokens, 0}
else
  local tokensNeeded = cost - tokens
  retryAfter = math.ceil(tokensNeeded / refillRate)
  return {0, tokens, retryAfter}
end
```

**Why Lua?**
- **Atomicity**: Redis executes Lua scripts without interleaving other commands
- **No race conditions**: Multiple backend instances can't create inconsistent state
- **Performance**: Script is loaded once and executed by SHA hash

## Monitoring Endpoints

### Check Rate Limit Status

```bash
GET /api/v1/rate-limit/status
```

**Response:**
```json
{
  "identifier": "127.0.0.1",
  "status": "active",
  "capacity": 100,
  "refillRate": 10,
  "currentTokens": 45,
  "lastRefill": "2024-01-01T12:00:00.000Z",
  "secondsSinceLastRefill": 2,
  "utilization": "55.0%"
}
```

### Get Configuration

```bash
GET /api/v1/rate-limit/config
```

**Response:**
```json
{
  "enabled": true,
  "capacity": 100,
  "refillRate": 10,
  "refillRatePerMinute": 600,
  "logRejections": true,
  "timeToFullRefill": "10 seconds",
  "description": "Token bucket rate limiter with dynamic cost weights"
}
```

### Reset Rate Limit (Admin)

```bash
POST /api/v1/rate-limit/reset
```

**Response:**
```json
{
  "success": true,
  "message": "Rate limit reset for identifier: 127.0.0.1",
  "identifier": "127.0.0.1"
}
```

## Distributed Behavior

The token bucket correctly handles distributed deployments:

1. **Shared Redis state**: All backend instances check the same Redis bucket
2. **Atomic operations**: Lua script prevents race conditions
3. **Per-identifier isolation**: Each IP/user gets their own bucket
4. **TTL cleanup**: Buckets auto-expire after inactivity

### Example: 3 Backend Instances

```
User → LoadBalancer
         ├── Backend 1 ─┐
         ├── Backend 2 ─┼─→ Redis (shared state)
         └── Backend 3 ─┘
```

- User makes request to Backend 1: consumes 10 tokens (90 remain)
- User makes request to Backend 2: sees 90 tokens, consumes 50 (40 remain)
- User makes request to Backend 3: sees 40 tokens, attempts 50 → **denied**

## Cost Weight Guidelines

When assigning cost weights to new routes:

1. **Measure actual CPU/DB impact** (use profiling tools)
2. **Consider query complexity**: joins, aggregations, sorting
3. **Account for caching**: cached queries should be lighter
4. **Test under load**: verify weights prevent resource exhaustion
5. **Document reasoning**: add description to `ROUTE_COST_WEIGHTS`

### Formula

```
weight = base_weight × complexity_multiplier

base_weight:
- Read single entity: 3
- Read collection: 5
- Aggregation: 10
- Complex analytics: 15-20

complexity_multiplier:
- Cached: 0.5-0.8
- Indexed query: 1.0
- Full table scan: 2.0-3.0
- Multiple joins: 1.5-2.5
```

## Testing

### Unit Tests

```bash
cd packages/backend
npm test src/trpc/__tests__/tokenBucketMiddleware.test.ts
npm test src/services/__tests__/tokenBucketService.test.ts
```

### Integration Test

Simulate heavy load:

```bash
# Lightweight requests (should succeed)
for i in {1..100}; do
  curl -X POST http://localhost:3001/trpc/contract.getStatus
done

# Heavy request (should be rate limited after 5 requests)
for i in {1..10}; do
  curl -X POST http://localhost:3001/trpc/analytics.getLeaderboard
  echo "Request $i"
done
```

### Load Testing

Use [k6](https://k6.io/) or [Artillery](https://www.artillery.io/):

```javascript
// k6 script
import http from 'k6/http';
import { check } from 'k6';

export default function () {
  const res = http.post('http://localhost:3001/trpc/stats.getGlobalStats');
  check(res, {
    'status is 200 or 429': (r) => [200, 429].includes(r.status),
  });
}
```

## Performance Considerations

### Redis Performance

- **Lua script execution**: ~0.1-0.5ms per call
- **Memory per bucket**: ~100 bytes
- **TTL cleanup**: automatic, no memory leak
- **Throughput**: Redis can handle 100k+ ops/sec

### Backend Impact

- **Middleware overhead**: ~1-2ms per request
- **Early rejection**: heavy queries never reach the database
- **Distributed state**: no in-memory sync required

## Environment Variables

```bash
# Enable/disable token bucket rate limiting
RATE_LIMIT_ENABLED=true

# Token bucket capacity (tokens)
RATE_LIMIT_CAPACITY=100

# Refill rate (tokens per second)
RATE_LIMIT_REFILL_RATE=10

# Log rejected requests
RATE_LIMIT_LOG_REJECTIONS=true
```

## Troubleshooting

### "NOSCRIPT" Error

If you see `NOSCRIPT No matching script` errors:

1. Redis was restarted and lost the loaded script
2. The service automatically reloads on next request
3. No manual intervention needed

### Rate Limit Too Strict

Adjust configuration in `src/config/rateLimitConfig.ts`:

```typescript
export const tokenBucketConfig = {
  capacity: 200,      // Increase capacity
  refillRate: 20,     // Increase refill rate
};
```

### Rate Limit Too Lenient

Lower route weights or adjust bucket capacity:

```typescript
{
  route: 'stats.getGlobalStats',
  weight: 20,  // Increase from 10
}
```

### Redis Unavailable

The service **fails open** (allows requests) if Redis is unavailable:

```typescript
logger.error('Token bucket check failed, allowing request by default');
return { allowed: true, remainingTokens: capacity, retryAfter: 0, cost };
```

## Migration from Old Rate Limiter

The old `@fastify/rate-limit` plugin is still enabled for backward compatibility:

```typescript
// OLD: In-memory, per-instance rate limiting
config: {
  rateLimit: {
    max: 60,
    timeWindow: '1 minute',
  },
}
```

**Migration plan:**

1. ✅ Deploy token bucket in parallel (current state)
2. Monitor metrics for 1 week
3. Adjust weights based on actual traffic
4. Remove old rate limiter configuration
5. Update all routes to rely on token bucket only

## Future Enhancements

- [ ] User-based buckets (authenticated users get higher limits)
- [ ] API key tiers (premium users get more tokens)
- [ ] Per-route bucket overrides
- [ ] Adaptive weights based on current load
- [ ] Grafana dashboard for rate limit metrics
- [ ] Circuit breaker integration
- [ ] Distributed tracing with OpenTelemetry

## References

- [Token Bucket Algorithm](https://en.wikipedia.org/wiki/Token_bucket)
- [RFC 6585 - Additional HTTP Status Codes](https://datatracker.ietf.org/doc/html/rfc6585)
- [Redis Lua Scripting](https://redis.io/docs/manual/programmability/eval-intro/)
- [Rate Limiting Best Practices](https://cloud.google.com/architecture/rate-limiting-strategies-techniques)

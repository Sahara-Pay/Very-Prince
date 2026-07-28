# Token Bucket Rate Limiter - Troubleshooting Guide

## Common Issues and Solutions

---

## 🔴 Issue: All requests immediately rate limited

### Symptoms
- Fresh server start, but requests are immediately getting 429 responses
- `X-RateLimit-Remaining: 0` on first request

### Possible Causes

1. **Previous bucket state still in Redis**
   ```bash
   # Check if bucket exists
   redis-cli GET ratelimit:token_bucket:127.0.0.1
   ```

2. **Low capacity or refill rate**
   ```bash
   # Check configuration
   curl http://localhost:3001/api/v1/rate-limit/config
   ```

### Solutions

**Solution 1: Reset rate limit**
```bash
curl -X POST http://localhost:3001/api/v1/rate-limit/reset
```

**Solution 2: Clear Redis (development only)**
```bash
redis-cli FLUSHDB
```

**Solution 3: Increase capacity/refill rate**
```bash
# Edit .env
RATE_LIMIT_CAPACITY=200
RATE_LIMIT_REFILL_RATE=20
```

---

## 🔴 Issue: Rate limiting not working at all

### Symptoms
- Can make unlimited heavy requests
- No 429 responses even after many requests
- Rate limit headers missing

### Possible Causes

1. **Rate limiting disabled**
   ```bash
   # Check if enabled
   curl http://localhost:3001/api/v1/rate-limit/config
   # Look for "enabled": false
   ```

2. **Redis connection failure**
   ```bash
   # Check Redis connectivity
   redis-cli ping
   ```

3. **Middleware not registered**
   ```typescript
   // Check src/trpc/server.ts
   preHandler: [tokenBucketMiddleware, queryComplexityMiddleware]
   ```

### Solutions

**Solution 1: Enable rate limiting**
```bash
# Edit .env
RATE_LIMIT_ENABLED=true
```

**Solution 2: Fix Redis connection**
```bash
# Check Redis is running
redis-cli ping
# Expected: PONG

# Check connection string
echo $REDIS_URL
# Expected: redis://localhost:6379
```

**Solution 3: Restart server**
```bash
# Stop server
# Start Redis if needed: docker run -d -p 6379:6379 redis:7-alpine
npm run dev
```

---

## 🟡 Issue: "NOSCRIPT No matching script" errors

### Symptoms
- Error in logs: `NOSCRIPT No matching script. Please use EVAL.`
- Intermittent failures

### Cause
Redis was restarted and lost the loaded Lua script from memory.

### Solution

**Automatic recovery:**
The service automatically reloads the script on next request. No action needed.

**Manual reload:**
```bash
# Restart backend server
npm run dev
```

**Verify script loaded:**
```bash
redis-cli SCRIPT EXISTS <sha>
```

---

## 🟡 Issue: Inconsistent rate limiting across instances

### Symptoms
- Same user gets different rate limit responses from different backend instances
- `X-RateLimit-Remaining` varies wildly

### Possible Causes

1. **Multiple Redis instances**
   - Backend 1 connects to Redis A
   - Backend 2 connects to Redis B

2. **Different identifier extraction**
   - One instance sees X-Forwarded-For
   - Another instance sees direct IP

### Solutions

**Solution 1: Verify Redis URL**
```bash
# On all backend instances
echo $REDIS_URL
# Should be IDENTICAL
```

**Solution 2: Check load balancer headers**
```bash
# Ensure X-Forwarded-For is set consistently
curl -H "X-Forwarded-For: 1.2.3.4" http://backend-1:3001/api/v1/rate-limit/status
curl -H "X-Forwarded-For: 1.2.3.4" http://backend-2:3001/api/v1/rate-limit/status
# identifiers should match
```

---

## 🟡 Issue: Lua script syntax errors

### Symptoms
- Error in logs: `ERR Error compiling script`
- Rate limiting fails completely

### Cause
The Lua script file is corrupted or has syntax errors.

### Solution

**Verify Lua script:**
```bash
redis-cli --eval packages/backend/src/redis/tokenBucket.lua , 10 100 10 1672530000
```

**Test script manually:**
```bash
redis-cli EVAL "$(cat packages/backend/src/redis/tokenBucket.lua)" 1 test:bucket 10 100 10 $(date +%s)
```

**Expected output:**
```
1) (integer) 1
2) (integer) 90
3) (integer) 0
```

---

## 🟢 Issue: Performance degradation

### Symptoms
- Increased response latency
- Redis CPU usage high
- Slow rate limit checks

### Possible Causes

1. **Too many buckets in Redis**
   ```bash
   redis-cli KEYS "ratelimit:token_bucket:*" | wc -l
   ```

2. **Script not cached (running EVAL instead of EVALSHA)**
   ```bash
   redis-cli INFO commandstats | grep eval
   # Look for high EVAL count (should be low)
   ```

3. **Redis under heavy load**
   ```bash
   redis-cli INFO stats
   ```

### Solutions

**Solution 1: Clean up stale buckets**
```bash
# Buckets should auto-expire via TTL
# But you can manually clean old ones:
redis-cli KEYS "ratelimit:token_bucket:*" | xargs redis-cli DEL
```

**Solution 2: Verify script caching**
```typescript
// Check logs for:
"Token bucket Lua script loaded into Redis"
// Should only appear once per server start
```

**Solution 3: Scale Redis**
```bash
# Use Redis Cluster or read replicas
# Or increase Redis resources
```

---

## 🟢 Issue: Memory leak in Redis

### Symptoms
- Redis memory usage grows unbounded
- `redis-cli INFO memory` shows increasing `used_memory`

### Cause
Buckets not expiring due to missing TTL.

### Solution

**Verify TTL is set:**
```bash
redis-cli TTL ratelimit:token_bucket:127.0.0.1
# Should return positive number (seconds until expiry)
# -1 means no expiry (BUG)
# -2 means key doesn't exist
```

**Check Lua script sets EXPIRE:**
```bash
grep -A 2 "EXPIRE" packages/backend/src/redis/tokenBucket.lua
# Should see: redis.call('EXPIRE', bucketKey, ttl)
```

**Manual cleanup (if needed):**
```bash
redis-cli --scan --pattern "ratelimit:token_bucket:*" | xargs redis-cli EXPIRE 600
```

---

## 🟢 Issue: Wrong identifier being used

### Symptoms
- Different users share the same bucket
- Rate limits apply globally instead of per-user

### Cause
Identifier extraction failing or returning constant value.

### Solution

**Check identifier extraction:**
```bash
curl http://localhost:3001/api/v1/rate-limit/status
# Look at "identifier" field
```

**Test from different IPs:**
```bash
# From machine A
curl http://api.example.com/api/v1/rate-limit/status
# identifier: "1.2.3.4"

# From machine B
curl http://api.example.com/api/v1/rate-limit/status
# identifier: "5.6.7.8"
# Should be DIFFERENT
```

**Custom identifier extraction:**
```typescript
// Edit src/config/rateLimitConfig.ts
export function extractIdentifier(request: any): string {
  // Add custom logic here
  const apiKey = request.headers['x-api-key'];
  if (apiKey) return `api:${apiKey}`;
  
  const userId = request.user?.id;
  if (userId) return `user:${userId}`;
  
  // Fall back to IP
  return request.ip || 'unknown';
}
```

---

## 🟢 Issue: Requests stuck at "refilling" state

### Symptoms
- Requests denied for long periods
- `retryAfter` always shows same value
- Tokens not refilling

### Cause
`lastRefill` timestamp not updating.

### Solution

**Check bucket state:**
```bash
redis-cli HGETALL ratelimit:token_bucket:127.0.0.1
```

**Expected:**
```
1) "tokens"
2) "45.5"
3) "lastRefill"
4) "1672530123"  <- Should be recent Unix timestamp
```

**If timestamp is old, reset:**
```bash
curl -X POST http://localhost:3001/api/v1/rate-limit/reset
```

**Check server time:**
```bash
date +%s
# Compare with lastRefill timestamp
```

---

## 🔵 Issue: Different route costs than expected

### Symptoms
- Heavy routes consuming fewer tokens than expected
- Light routes consuming more tokens than expected

### Cause
Route weights misconfigured or using default weight.

### Solution

**Check route weights:**
```typescript
// Edit src/config/rateLimitConfig.ts
import { ROUTE_COST_WEIGHTS } from './config/rateLimitConfig.js';
console.log(ROUTE_COST_WEIGHTS);
```

**Test specific route:**
```bash
curl -X POST http://localhost:3001/trpc/analytics.getLeaderboard \
  -H "Content-Type: application/json" \
  -v
# Check X-RateLimit-Cost header
```

**Add missing route weight:**
```typescript
// Edit src/config/rateLimitConfig.ts
export const ROUTE_COST_WEIGHTS: RouteCostWeight[] = [
  {
    route: 'myNewRoute.expensiveQuery',
    weight: 25,
    description: 'Very expensive operation',
  },
  // ...
];
```

---

## 🔵 Issue: Batch requests not calculating cost correctly

### Symptoms
- Batched requests show wrong `X-RateLimit-Cost`
- Cost doesn't match sum of individual routes

### Cause
Batch parsing failing or route paths malformed.

### Solution

**Test batch parsing:**
```typescript
import { calculateRequestCost } from './trpc/tokenBucketMiddleware.js';
const result = calculateRequestCost('route1,route2,route3');
console.log(result);
```

**Check tRPC batch format:**
```bash
# Batched tRPC requests use comma-separated paths
curl -X POST http://localhost:3001/trpc/org.get,stats.getTVL
# Cost should be: 3 + 4 = 7
```

**Verify in logs:**
```json
{
  "event": "token_bucket_rate_limit_exceeded",
  "routes": [
    { "path": "org.get", "weight": 3 },
    { "path": "stats.getTVL", "weight": 4 }
  ],
  "totalCost": 7
}
```

---

## Diagnostic Commands

### Check Rate Limit Status
```bash
curl http://localhost:3001/api/v1/rate-limit/status | jq
```

### Check Configuration
```bash
curl http://localhost:3001/api/v1/rate-limit/config | jq
```

### Reset Rate Limit
```bash
curl -X POST http://localhost:3001/api/v1/rate-limit/reset
```

### Check Redis Health
```bash
redis-cli ping
redis-cli INFO stats
redis-cli INFO memory
```

### List All Buckets
```bash
redis-cli KEYS "ratelimit:token_bucket:*"
```

### Inspect Specific Bucket
```bash
redis-cli HGETALL ratelimit:token_bucket:127.0.0.1
```

### Check Lua Script
```bash
redis-cli SCRIPT EXISTS <sha-hash>
```

### Monitor Redis Commands (Real-time)
```bash
redis-cli MONITOR
```

### Load Test
```bash
# Install apache bench
brew install httpd

# Test lightweight endpoint
ab -n 1000 -c 10 http://localhost:3001/trpc/contract.getStatus

# Test heavy endpoint
ab -n 100 -c 10 http://localhost:3001/trpc/analytics.getLeaderboard
```

---

## Debugging Checklist

When troubleshooting rate limiting issues, check these in order:

- [ ] Is Redis running? (`redis-cli ping`)
- [ ] Is rate limiting enabled? (`.env` file)
- [ ] Is `REDIS_URL` correct? (`.env` file)
- [ ] Can backend connect to Redis? (Check logs)
- [ ] Is Lua script loaded? (Check logs for "Lua script loaded")
- [ ] Is middleware registered? (`src/trpc/server.ts`)
- [ ] Are route weights configured? (`src/config/rateLimitConfig.ts`)
- [ ] Is identifier extraction working? (Check `/rate-limit/status`)
- [ ] Are buckets expiring? (`redis-cli TTL ...`)
- [ ] Is server time correct? (`date` command)

---

## Getting Help

If you're still experiencing issues:

1. **Enable debug logging:**
   ```bash
   # Edit .env
   RATE_LIMIT_LOG_REJECTIONS=true
   LOG_LEVEL=debug
   ```

2. **Collect diagnostic information:**
   ```bash
   # Rate limit status
   curl http://localhost:3001/api/v1/rate-limit/status > rate-limit-status.json
   
   # Rate limit config
   curl http://localhost:3001/api/v1/rate-limit/config > rate-limit-config.json
   
   # Redis info
   redis-cli INFO > redis-info.txt
   
   # Backend logs
   tail -n 100 backend.log > backend-logs.txt
   ```

3. **Check the logs for:**
   - `token_bucket_rate_limit_exceeded` events
   - `Token bucket check failed` errors
   - `Redis error` messages
   - `NOSCRIPT` errors

4. **Report issue with:**
   - Steps to reproduce
   - Expected vs actual behavior
   - Diagnostic files (above)
   - Backend logs with errors
   - Redis version and configuration

---

## Performance Tuning

### Scenario: Too strict (legitimate users being rate limited)

**Solution: Increase capacity or refill rate**
```bash
# Option 1: Increase capacity (more burst capacity)
RATE_LIMIT_CAPACITY=200

# Option 2: Increase refill rate (faster recovery)
RATE_LIMIT_REFILL_RATE=20

# Option 3: Lower route weights
# Edit src/config/rateLimitConfig.ts
{ route: 'stats.getGlobalStats', weight: 5 }  // was 10
```

### Scenario: Too lenient (attackers not being blocked)

**Solution: Decrease capacity or increase route weights**
```bash
# Option 1: Decrease capacity
RATE_LIMIT_CAPACITY=50

# Option 2: Decrease refill rate
RATE_LIMIT_REFILL_RATE=5

# Option 3: Increase heavy route weights
# Edit src/config/rateLimitConfig.ts
{ route: 'analytics.getLeaderboard', weight: 30 }  // was 20
```

### Scenario: Need per-user buckets (not IP-based)

**Solution: Customize identifier extraction**
```typescript
// Edit src/config/rateLimitConfig.ts
export function extractIdentifier(request: any): string {
  // Use authenticated user ID
  if (request.user?.id) {
    return `user:${request.user.id}`;
  }
  
  // Use API key
  if (request.headers['x-api-key']) {
    return `apikey:${request.headers['x-api-key']}`;
  }
  
  // Fall back to IP
  return `ip:${request.ip || 'unknown'}`;
}
```

---

## Testing Checklist

Before deploying to production:

- [ ] Run unit tests: `npm test tokenBucket`
- [ ] Run integration tests: `npx tsx docs/examples/rate-limiting-example.ts`
- [ ] Test with Redis down (should fail open)
- [ ] Test with high load (use `ab` or `k6`)
- [ ] Verify distributed behavior (multiple backend instances)
- [ ] Check Redis memory usage after load test
- [ ] Verify TTL cleanup (buckets should expire)
- [ ] Test different identifier types (IP, API key, user)
- [ ] Verify Retry-After headers are correct
- [ ] Check logs for errors or warnings

---

This troubleshooting guide should help resolve most common issues with the token bucket rate limiter. Remember to always check the basics first (Redis connection, configuration) before diving into complex debugging.

# Token Bucket Rate Limiting - Quick Start

## What is it?

A **dynamic token bucket rate limiter** that protects your API by assigning different "costs" to different operations:

- ✅ Lightweight health checks cost 1 token
- ⚠️ Medium queries cost 3-5 tokens  
- ❌ Heavy analytics cost 20+ tokens

This prevents attackers from exhausting your backend with expensive queries while allowing normal traffic to flow.

## Setup

### 1. Prerequisites

- Redis server running
- Environment variables configured

### 2. Environment Configuration

Add to your `.env` file:

```bash
# Required
REDIS_URL="redis://localhost:6379"

# Optional (defaults shown)
RATE_LIMIT_ENABLED=true
RATE_LIMIT_CAPACITY=100
RATE_LIMIT_REFILL_RATE=10
RATE_LIMIT_LOG_REJECTIONS=true
```

### 3. Start Redis (if not running)

```bash
# Using Docker
docker run -d -p 6379:6379 redis:7-alpine

# Or using Homebrew (macOS)
brew services start redis
```

### 4. Start the Backend

```bash
cd packages/backend
npm run dev
```

The rate limiter is now active! 🎉

## How to Use

### Check Your Rate Limit Status

```bash
curl http://localhost:3001/api/v1/rate-limit/status
```

**Response:**
```json
{
  "identifier": "127.0.0.1",
  "status": "active",
  "capacity": 100,
  "currentTokens": 95,
  "refillRate": 10,
  "utilization": "5.0%"
}
```

### Make Requests

All tRPC requests are automatically rate-limited:

```bash
# Lightweight request (costs 1 token)
curl -X POST http://localhost:3001/trpc/contract.getStatus

# Medium request (costs 3 tokens)
curl -X POST http://localhost:3001/trpc/organization.get \
  -H "Content-Type: application/json" \
  -d '{"id": "test-org"}'

# Heavy request (costs 20 tokens)
curl -X POST http://localhost:3001/trpc/analytics.getLeaderboard
```

### Handle 429 Responses

When rate limited, you'll receive:

```json
{
  "statusCode": 429,
  "error": "Too Many Requests",
  "message": "Rate limit exceeded. Retry after 5 seconds.",
  "retryAfter": 5,
  "remainingTokens": 2,
  "cost": 20
}
```

**Headers:**
- `Retry-After: 5` - Wait 5 seconds before retrying
- `X-RateLimit-Remaining: 2` - You have 2 tokens left
- `X-RateLimit-Cost: 20` - This request costs 20 tokens

## Configuration

### Adjust Bucket Capacity

Edit `.env`:

```bash
# Allow more requests
RATE_LIMIT_CAPACITY=200
RATE_LIMIT_REFILL_RATE=20
```

This gives users:
- 200 tokens maximum
- 20 tokens per second refill (1200/minute)

### Adjust Route Costs

Edit `packages/backend/src/config/rateLimitConfig.ts`:

```typescript
{
  route: 'myNewRoute.heavyOperation',
  weight: 25,
  description: 'Very expensive database operation',
}
```

## Testing

### Run Unit Tests

```bash
cd packages/backend
npm test tokenBucket
```

### Run Examples

```bash
npx tsx docs/examples/rate-limiting-example.ts
```

This demonstrates:
1. Lightweight vs heavy routes
2. Batched requests
3. Exhaustion and recovery
4. DoS protection
5. Mixed traffic patterns

### Manual Load Test

```bash
# Exhaust the bucket
for i in {1..10}; do
  curl -X POST http://localhost:3001/trpc/analytics.getLeaderboard
  echo "Request $i"
done
```

## Monitoring

### Prometheus Metrics (Coming Soon)

```
rate_limit_requests_total{route="organization.get",allowed="true"} 1234
rate_limit_requests_total{route="analytics.getLeaderboard",allowed="false"} 56
rate_limit_tokens_remaining{identifier="127.0.0.1"} 45
```

### Logs

When `RATE_LIMIT_LOG_REJECTIONS=true`, rejected requests are logged:

```json
{
  "event": "token_bucket_rate_limit_exceeded",
  "identifier": "127.0.0.1",
  "totalCost": 20,
  "remainingTokens": 5,
  "retryAfter": 2
}
```

## Troubleshooting

### "Rate limited immediately after starting"

Reset your rate limit:

```bash
curl -X POST http://localhost:3001/api/v1/rate-limit/reset
```

### "All requests getting through despite high load"

Check if rate limiting is enabled:

```bash
curl http://localhost:3001/api/v1/rate-limit/config
```

If `enabled: false`, set `RATE_LIMIT_ENABLED=true` in `.env`.

### "Redis connection errors"

Verify Redis is running:

```bash
redis-cli ping
# Should return: PONG
```

Check `REDIS_URL` in `.env` matches your Redis instance.

### "Lua script errors"

The service automatically reloads scripts after Redis restarts. No action needed.

## Next Steps

- 📖 Read the [full documentation](./RATE_LIMITING.md)
- 🧪 Explore [examples](./examples/rate-limiting-example.ts)
- ⚙️ Tune [route costs](../packages/backend/src/config/rateLimitConfig.ts)
- 📊 Set up monitoring dashboards
- 🔐 Add per-user or API key buckets

## Quick Reference

| Route Type | Weight | Requests/100 tokens |
|------------|--------|---------------------|
| Health check | 1 | 100 |
| Single entity | 3-5 | 20-33 |
| Collection | 5-10 | 10-20 |
| Analytics | 15-20 | 5-7 |
| Heavy sync | 25+ | 4 |

**Refill rate:** 10 tokens/second = 600 tokens/minute

**Time to full refill:** 10 seconds (100 tokens ÷ 10 tokens/sec)

--[[
  Token Bucket Rate Limiter - Atomic Token Deduction
  
  This Lua script ensures atomic token deduction with refill logic.
  
  KEYS[1] = bucket key (e.g., "ratelimit:token_bucket:127.0.0.1")
  ARGV[1] = cost (number of tokens to deduct)
  ARGV[2] = capacity (maximum tokens in bucket)
  ARGV[3] = refillRate (tokens added per second)
  ARGV[4] = currentTime (Unix timestamp in seconds)
  
  Returns:
    - If allowed: [1, remainingTokens, retryAfter]
    - If denied: [0, remainingTokens, retryAfter]
]]

local bucketKey = KEYS[1]
local cost = tonumber(ARGV[1])
local capacity = tonumber(ARGV[2])
local refillRate = tonumber(ARGV[3])
local currentTime = tonumber(ARGV[4])

-- Retrieve current bucket state
local bucket = redis.call('HMGET', bucketKey, 'tokens', 'lastRefill')
local tokens = tonumber(bucket[1]) or capacity
local lastRefill = tonumber(bucket[2]) or currentTime

-- Calculate tokens to add based on elapsed time
local elapsed = math.max(0, currentTime - lastRefill)
local tokensToAdd = elapsed * refillRate
tokens = math.min(capacity, tokens + tokensToAdd)

-- Calculate retry-after time (in seconds)
local retryAfter = 0

-- Check if we have enough tokens
if tokens >= cost then
  -- Deduct tokens
  tokens = tokens - cost
  
  -- Update bucket state with expiry (2x the time to refill full capacity)
  local ttl = math.ceil((capacity / refillRate) * 2)
  redis.call('HMSET', bucketKey, 'tokens', tokens, 'lastRefill', currentTime)
  redis.call('EXPIRE', bucketKey, ttl)
  
  return {1, tokens, 0}
else
  -- Calculate how long until enough tokens are available
  local tokensNeeded = cost - tokens
  retryAfter = math.ceil(tokensNeeded / refillRate)
  
  -- Update bucket state even on denial to track last refill time
  local ttl = math.ceil((capacity / refillRate) * 2)
  redis.call('HMSET', bucketKey, 'tokens', tokens, 'lastRefill', currentTime)
  redis.call('EXPIRE', bucketKey, ttl)
  
  return {0, tokens, retryAfter}
end

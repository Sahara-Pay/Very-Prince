# PayoutRegistry - Audit Readiness Documentation

## Overview
The PayoutRegistry is a multi-organization maintenance payout smart contract built on Stellar Soroban. It enables organizations to fund pools of tokens and allocate them to maintainers with time-locked claims.

## State Machine

### Contract States
- **Active**: Normal operation mode where all functions are available
- **Paused**: Emergency mode where funding, allocation, and claiming operations are disabled

### State Transitions
```
[Active] --pause_protocol()--> [Paused]
[Paused] --unpause_protocol()--> [Active]
```

### Data Flow States

#### Organization Lifecycle
1. **Unregistered** → **Registered** (via `register_org`)
2. **Registered** → **Funded** (via `fund_org`)
3. **Funded** → **Payout Allocated** (via `allocate_payout`/`batch_allocate`)
4. **Payout Allocated** → **Claimed** (via `claim_payout`)

#### Maintainer Lifecycle
1. **Unregistered** → **Registered** (via `add_maintainer`)
2. **Registered** → **Balance Available** (after payout allocation)
3. **Balance Available** → **Claimed** (via `claim_payout`)

## Core Invariants

### Financial Invariants
1. **Total Budget Conservation**: `total_budget >= allocated_payouts`
   - Enforced in `allocate_payout` and `batch_allocate` functions
   - Uses checked arithmetic to prevent overflow/underflow
   - Panics if allocation exceeds available budget

2. **Non-Negative Balances**: All monetary balances are always >= 0
   - Budget balances never go negative (checked_sub with panic on underflow)
   - Payout balances never go negative
   - Token transfers always validated for sufficient funds

3. **Overflow Protection**: All arithmetic operations use checked variants
   - `checked_add()` with explicit panic messages for overflow
   - `checked_sub()` with explicit panic messages for underflow
   - Prevents silent wrapping behavior

### Authorization Invariants
1. **Admin Authorization**: Only organization admins can:
   - Add/remove other admins
   - Add maintainers
   - Allocate payouts
   - Enforced via address comparison and authentication checks

2. **Protocol Admin Authorization**: Only protocol admin can:
   - Pause/unpause protocol
   - Upgrade contract
   - Stored in persistent storage and verified on each call

3. **Maintainer Authorization**: Only maintainers can:
   - Claim their own payouts
   - Enforced via `require_auth_for_args` with specific parameters

### Structural Invariants
1. **Admin Limits**: Maximum 10 admins per organization
2. **Maintainer Uniqueness**: Each maintainer belongs to exactly one organization
3. **Batch Size Limits**: Maximum 100 payout entries per batch
4. **Time Lock Enforcement**: Payouts only claimable after `unlock_timestamp`

## Security Patterns

### Check-Effects-Interactions (CEI) Pattern
All state-changing functions follow CEI pattern:
1. **Check**: Validate all conditions and authorizations
2. **Effects**: Update contract storage
3. **Interactions**: Perform external calls (token transfers)

### Reentrancy Protection
- State updates happen before external token transfers
- Claimable balances reset to 0 before token transfer
- No external calls between checks and effects
- Every state-mutating entry point acquires a global reentrancy mutex
  (`ReentrancyGuard`) on entry and releases it on exit (via `Drop`). A
  re-entrant call panics with `PrinceError::Reentrancy` before it can observe
  or mutate any inconsistent state. Combined with the atomic transaction
  semantics (a panicking call reverts the lock write), the guard can never
  dead-lock the contract and makes double-spend through reentrancy
  structurally unreachable.

### Access Control
- Role-based permissions (admin, maintainer, protocol admin)
- Parameter-bound authentication (`require_auth_for_args`)
- Address-based authorization checks

## Known Limitations

### Design Constraints
1. **Deterministic Org IDs**: Organization IDs are generated from admin address + name hash
   - Potential for ID collisions (extremely low probability)
   - No ID reuse mechanism

2. **Time Locks**: Once set, unlock timestamps cannot be changed
   - May cause UX issues if incorrect timestamps are set
   - No admin override mechanism for emergency releases

3. **Batch Processing**: Fixed maximum of 100 entries per batch
   - May require multiple transactions for large organizations
   - Trade-off between gas efficiency and flexibility

### Protocol Limitations
1. **No Emergency Pause for Individual Orgs**: Protocol pause affects all organizations
2. **No Partial Claiming**: Maintainers must claim entire balance
3. **No Payout History**: Limited on-chain historical data

## Gas Optimization Considerations

### Storage Patterns
- Persistent storage for long-term data
- Efficient data structures (Vec for collections)
- Minimal storage reads per operation

### Computation Limits
- Batch operations to reduce transaction count
- Early validation to fail fast
- Loop bounds to prevent infinite iterations

## Testing Coverage

### Unit Tests
- ✅ Initialization and configuration
- ✅ Organization registration and management
- ✅ Funding and budget management
- ✅ Payout allocation (single and batch)
- ✅ Payout claiming with time locks
- ✅ Authorization controls
- ✅ Error conditions and edge cases

### Property Tests
- ✅ Fuzz testing for edge cases
- ✅ Overflow/underflow protection
- ✅ State transition invariants

## Audit Recommendations

### High Priority
1. **Formal Verification**: Consider using formal verification tools for critical invariants
2. **Time Lock Review**: Validate time lock logic against real-world requirements
3. **Admin Recovery**: Consider admin recovery mechanisms for lost keys

### Medium Priority
1. **Gas Optimization**: Review gas usage for large-scale deployments
2. **Event Schema**: Ensure events provide sufficient off-chain data
3. **Upgrade Path**: Verify upgrade mechanism preserves all state

### Low Priority
1. **Documentation**: Improve inline documentation for complex logic
2. **Error Messages**: Standardize panic messages for better debugging
3. **Code Organization**: Consider splitting large functions

## Deployment Considerations

### Pre-Deployment Checklist
- [ ] All tests passing with 100% coverage
- [ ] Gas usage within acceptable limits
- [ ] Formal verification of critical invariants
- [ ] Security audit completed
- [ ] Upgrade mechanism tested

### Post-Deployment Monitoring
- Monitor for unusual patterns in budget allocations
- Track gas usage and optimization opportunities
- Watch for protocol pause/unpause events
- Monitor upgrade events for contract changes

## Contact Information

For audit questions or clarification:
- Repository: https://github.com/Zakky-Fatty/Very-prince
- Contract: packages/contracts/src/lib.rs
- Tests: packages/contracts/src/tests.rs

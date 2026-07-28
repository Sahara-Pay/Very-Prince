# TODO

## Task: Allow organizations to define custom vesting schedules for payouts

### Step 0: Plan approved
- [x] Reviewed current contract/BE/FE vesting implementation and identified legacy single `unlock_timestamp` storage.

### Step 1: Contract (Rust)
- [ ] Add new `allocate_payout_vesting` entrypoint accepting tranches.
- [ ] Implement tranche validation + storage in `MaintainerPayout` using `tranches` and `claimed_amount`.
- [x] Update `claim_payout` to release based on tranche schedule.

- [ ] Keep backward compatibility for existing `allocate_payout` path (map legacy unlock_timestamp -> single tranche).


### Step 2: Contract unit tests (Rust)
- [ ] Add tests for tranche-based claiming (before/between/after unlock timestamps).
- [ ] Add tests for invalid tranche inputs (empty, non-monotonic, sum mismatch).

### Step 3: Backend (Fastify/TS)
- [ ] Update POST `/payouts` request schema to accept optional `vestingTranches`.
- [ ] Route/Controller/Service: call `allocate_payout_vesting` when provided.
- [ ] Keep existing behavior when `vestingTranches` not provided.

### Step 4: Frontend (Next.js)
- [ ] Update `AllocatePayoutModal` to allow entering vesting tranches (UI).
- [ ] Update `sorobanClient` transaction builder to build vesting call.

### Step 5: Shared types (@very-prince/types)
- [ ] Add/extend vesting tranche types used by FE/BE.

### Step 6: Verification
- [ ] Run backend unit tests.
- [ ] Run contract tests.
- [ ] Smoke-test compilation for frontend.
- [ ] Verify no regressions.


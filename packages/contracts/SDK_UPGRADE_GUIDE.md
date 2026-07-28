# Soroban SDK Version Upgrade Guide

This guide provides a comprehensive approach to safely upgrading Soroban SDK versions in the Very-Prince project, based on real-world migration experience from SDK 21.x to 22.x.

## Overview

Soroban SDK upgrades introduce breaking changes that require careful handling to ensure:
- Contract functionality remains intact
- Test suites pass without modification
- Type safety is maintained
- No regressions are introduced in existing functionality

## Pre-Upgrade Checklist

Before beginning any SDK upgrade:

- [ ] Review the [Soroban SDK breaking changes documentation](https://mintlify.wiki/stellar/rs-soroban-sdk/migration/breaking-changes)
- [ ] Check the current SDK version in `packages/contracts/Cargo.toml`
- [ ] Identify all contract registration patterns in test files
- [ ] Run existing test suite to establish baseline
- [ ] Create a feature branch for the upgrade
- [ ] Backup current working state

## Breaking Changes by Version

### SDK 21.x → 22.x

#### Contract Registration API Changed

**Old API:**
```rust
let contract_id = env.register_contract(None, PayoutRegistry);
let contract_id = env.register_contract_wasm(wasm_bytes);
```

**New API:**
```rust
let contract_id = env.register(PayoutRegistry, ());
let contract_id = env.register(wasm_bytes, (arg1, arg2));
// Register at specific address
let address = Address::generate(&env);
env.register_at(&address, Contract, ());
```

**Key Changes:**
- `register_contract` and `register_contract_wasm` replaced by unified `register` and `register_at`
- Constructor arguments are now required (use `()` for no constructor args)
- Single API for both native and Wasm contracts
- More consistent with deployment API

#### Contract Deployment API Changed

**Old API:**
```rust
let contract_address = deployer.deploy(wasm_hash);
```

**New API:**
```rust
let contract_address = deployer.deploy_v2(wasm_hash, ());
let contract_address = deployer.deploy_v2(wasm_hash, (arg1, arg2));
```

**Key Changes:**
- `deploy` replaced by `deploy_v2`
- Constructor arguments now required
- More explicit about constructor invocation

#### Fuzz Testing Changes

**Deprecated:**
```rust
fuzz_catch_panic! { /* ... */ }
```

**Recommended:**
```rust
fuzz_target!(|input: Input| {
    let env = Env::default();
    let id = env.register(Contract, ());
    let client = ContractClient::new(&env, &id);
    let result = client.try_add(&input.x, &input.y);
    match result {
        Ok(Ok(_)) => {}, // Success with expected type
        Ok(Err(_)) => panic!("unexpected type"),
        Err(Ok(_)) => {}, // Contract error
        Err(Err(_)) => panic!("unexpected error"),
    }
});
```

#### Test Snapshot Events Changed

- **Old:** Contract events + system events + diagnostic events
- **New:** Contract events + system events only (diagnostic events filtered out)

## Upgrade Procedure

### Step 1: Update Cargo.toml

Update the SDK version in `packages/contracts/Cargo.toml`:

```toml
[dependencies]
soroban-sdk = { version = "22.0.0" }

[dev-dependencies]
soroban-sdk = { version = "22.0.0", features = ["testutils"] }
```

### Step 2: Update Contract Registration in Tests

Search for all instances of `register_contract` and replace with `register`:

```bash
# Search for deprecated API
grep -r "register_contract" packages/contracts/src/

# Replace with new API
# Old: env.register_contract(None, Contract)
# New: env.register(Contract, ())
```

**Common Patterns to Update:**

1. **Basic Contract Registration:**
   ```rust
   // Before
   let contract_id = env.register_contract(None, PayoutRegistry);
   
   // After
   let contract_id = env.register(PayoutRegistry, ());
   ```

2. **Wasm Contract Registration:**
   ```rust
   // Before
   let contract_id = env.register_contract_wasm(wasm_bytes);
   
   // After
   let contract_id = env.register(wasm_bytes, ());
   ```

3. **Registration at Specific Address:**
   ```rust
   // Before (not available in 21.x)
   
   // After
   let address = Address::generate(&env);
   env.register_at(&address, Contract, ());
   ```

### Step 3: Update Deployment API (if applicable)

```rust
// Before
let contract_address = deployer.deploy(wasm_hash);

// After
let contract_address = deployer.deploy_v2(wasm_hash, ());
```

### Step 4: Update Fuzz Tests (if applicable)

Replace `fuzz_catch_panic` with `try_` prefixed client methods:

```rust
// Before
fuzz_catch_panic!(|input: Input| {
    let env = Env::default();
    let id = env.register_contract(None, Contract);
    let client = ContractClient::new(&env, &id);
    client.add(&input.x, &input.y);
});

// After
fuzz_target!(|input: Input| {
    let env = Env::default();
    let id = env.register(Contract, ());
    let client = ContractClient::new(&env, &id);
    let result = client.try_add(&input.x, &input.y);
    match result {
        Ok(Ok(_)) => {},
        Ok(Err(_)) => panic!("unexpected type"),
        Err(Ok(_)) => {},
        Err(Err(_)) => panic!("unexpected error"),
    }
});
```

### Step 5: Run Test Suite

Execute the full test suite to identify any issues:

```bash
cd packages/contracts
cargo test
```

### Step 6: Fix Test Snapshot Changes

If test snapshots fail due to event filtering changes:

```bash
# Update snapshots
cargo test -- --accept
```

### Step 7: Verify Contract Compilation

Ensure the contract compiles successfully:

```bash
cd packages/contracts
cargo build --release
```

### Step 8: Run Integration Tests

If your project has integration tests, run them to ensure contract behavior is unchanged:

```bash
# Run integration tests
cargo test --test integration
```

## Post-Upgrade Verification

### Functional Testing

- [ ] All unit tests pass
- [ ] All integration tests pass
- [ ] Contract compiles without warnings
- [ ] Contract deploys successfully to testnet
- [ ] Contract functions execute correctly on testnet

### Performance Testing

- [ ] Contract execution time unchanged
- [ ] Gas consumption unchanged or improved
- [ ] WASM binary size unchanged or reduced

### Type Safety Verification

- [ ] No `unsafe` blocks introduced
- [ ] All type annotations correct
- [ ] No compiler warnings

## Common Issues and Solutions

### Issue: "register_contract not found"

**Cause:** Using deprecated API after SDK upgrade.

**Solution:** Replace `register_contract` with `register` and add constructor arguments.

### Issue: "Missing constructor arguments"

**Cause:** New API requires constructor arguments.

**Solution:** Add `()` for no constructor args or provide actual arguments.

### Issue: Test snapshots failing

**Cause:** Event filtering changed in test snapshots.

**Solution:** Update snapshots with `cargo test -- --accept`.

### Issue: Fuzz tests not compiling

**Cause:** `fuzz_catch_panic` deprecated.

**Solution:** Replace with `fuzz_target!` and `try_` prefixed methods.

## Rollback Procedure

If issues arise that cannot be resolved:

1. Revert `Cargo.toml` to previous SDK version
2. Revert all code changes to registration/deployment APIs
3. Revert test snapshot changes
4. Run test suite to verify restoration
5. Document the issue for future reference

## Best Practices

### Incremental Upgrades

- Upgrade one major version at a time (e.g., 20.x → 21.x → 22.x)
- Test thoroughly at each step
- Commit after each successful upgrade

### Documentation

- Document any custom patterns specific to your project
- Keep this guide updated with new breaking changes
- Share learnings with the team

### Testing Strategy

- Maintain comprehensive test coverage
- Add regression tests for critical functionality
- Use property-based testing (proptest) for complex logic

### CI/CD Integration

- Add SDK upgrade checks to CI pipeline
- Run full test suite on every SDK change
- Block merges if tests fail after upgrade

## Version-Specific Notes

### SDK 22.x

- **Protocol:** Protocol 22 compatible
- **Key Changes:** Registration API, deployment API, test snapshot events
- **Migration Complexity:** Medium
- **Breaking Changes:** High impact on test files

### SDK 21.x

- **Protocol:** Protocol 21 compatible
- **Key Changes:** CustomAccountInterface signature type
- **Migration Complexity:** Low
- **Breaking Changes:** Medium impact on custom account interfaces

## Resources

- [Soroban SDK Documentation](https://docs.rs/soroban-sdk)
- [Soroban SDK Breaking Changes](https://mintlify.wiki/stellar/rs-soroban-sdk/migration/breaking-changes)
- [Soroban SDK Migration Guide](https://mintlify.wiki/stellar/rs-soroban-sdk/migration/overview)
- [Stellar Developer Documentation](https://developers.stellar.org/docs)

## Appendix: Quick Reference

### API Changes Summary

| Old API | New API | Notes |
|---------|---------|-------|
| `env.register_contract(None, Contract)` | `env.register(Contract, ())` | Constructor args required |
| `env.register_contract_wasm(wasm)` | `env.register(wasm, ())` | Constructor args required |
| `deployer.deploy(hash)` | `deployer.deploy_v2(hash, ())` | Constructor args required |
| `fuzz_catch_panic!` | `fuzz_target!` with `try_` methods | Use try_ prefixed methods |

### Search Patterns

```bash
# Find deprecated registration API
grep -r "register_contract" src/

# Find deprecated deployment API
grep -r "\.deploy(" src/

# Find deprecated fuzz patterns
grep -r "fuzz_catch_panic" src/
```

### Replacement Patterns

```bash
# Replace registration (manual review required)
# register_contract(None, X) -> register(X, ())
# register_contract_wasm(X) -> register(X, ())

# Replace deployment (manual review required)
# .deploy(X) -> .deploy_v2(X, ())
```

## Changelog

### 2026-07-26
- Initial guide created based on SDK 21.x → 22.x migration
- Documented breaking changes and migration patterns
- Added verification procedures and rollback steps

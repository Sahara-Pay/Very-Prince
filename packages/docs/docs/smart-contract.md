---
id: smart-contract
title: Smart Contract API Reference
sidebar_label: Smart Contract API
---

# Smart Contract API Reference

The core logic of the **Very-Prince** payout infrastructure is implemented as a Soroban smart contract in Rust. The contract manages organization registration, public budgets, maintainer enrollment, and payout allocations with native Soroban authorization and protocol pause features.

---

## Data Types

### `Organization`
Represents a registered organization.
```rust
pub struct Organization {
    pub id: Symbol,
    pub name: String,
    pub admins: Vec<Address>,
    pub metadata_cid: Option<String>,
}
```

### `Maintainer`
Represents a maintainer enrolled under an organization.
```rust
pub struct Maintainer {
    pub address: Address,
    pub org_id: Symbol,
}
```

### `PayoutParams`
Represents a payout entry used in batch allocation.
```rust
pub struct PayoutParams {
    pub maintainer: Address,
    pub amount: i128,
}
```

### `MaintainerPayout`
Represents the remaining locked balance and vesting schedule for a maintainer.
```rust
pub struct MaintainerPayout {
    pub amount: i128,
    pub claimed_amount: i128,
    pub tranches: Vec<VestingTranche>,
}
```

### `ProtocolState`
Represents the global state of the protocol.
```rust
pub enum ProtocolState {
    Active,
    Paused,
}
```

---

## Errors (`PrinceError`)

| Value | Name | Description |
|---|---|---|
| `1` | `AlreadyInitialized` | Contract has already been initialized. |
| `2` | `EmptyAdminList` | Administrator list provided during initialization is empty. |
| `3` | `InvalidThreshold` | Native protocol admin config must contain exactly one admin and threshold `1`. |
| `4` | `ContractNotInitialized` | Attempted to call a function requiring contract initialization. |
| `5` | `ProtocolPaused` | Protocol is currently paused. |
| `6` | `InsufficientMultisigAuth` | Legacy signer payloads are no longer accepted for protocol admin operations. |
| `7` | `OrgAlreadyRegistered` | Organization with the specified ID already exists. |
| `8` | `OrgNotFound` | Organization could not be found. |
| `9` | `NotAuthorized` | The caller lacks permissions for this operation. |
| `10` | `InvalidAmount` | The amount provided must be a positive value. |
| `11` | `BudgetOverflow` | Organization budget would exceed maximum representable value. |
| `12` | `InsufficientBudget` | Organization budget is insufficient to cover the payout. |
| `13` | `MaxAdminLimitReached` | Organization has reached the maximum limit of 10 admins. |
| `14` | `AdminAlreadyExists` | Address is already an administrator of the organization. |
| `15` | `CannotRemoveLastAdmin` | Cannot remove the last administrator of an organization. |
| `16` | `NotAnAdmin` | Address is not an administrator of the organization. |
| `17` | `MaintainerAlreadyRegistered` | Maintainer is already registered in the system. |
| `18` | `MaintainerNotRegistered` | Maintainer is not registered in the system. |
| `19` | `MaintainerOrgMismatch` | Maintainer belongs to a different organization. |
| `20` | `PayoutOverflow` | Maintainer claimable balance would exceed maximum representable value. |
| `21` | `BatchSizeExceeded` | Batch payout size exceeds 100 entries. |
| `22` | `EmptyBatch` | Batch payout list is empty. |
| `23` | `NoClaimableBalance` | Maintainer has no funds available to claim. |
| `24` | `PayoutLocked` | Payout is currently locked (vesting period has not expired). |
| `25` | `NoPendingAdmin` | No pending global admin transfer proposal exists. |
| `26` | `NotPendingAdmin` | Caller is not the proposed pending global admin. |
| `27` | `AmountExceedsLimit` | The amount exceeds the maximum allowed limit of 1 trillion tokens. |

---

## Public Functions

### `init`
```rust
pub fn init(env: Env, token: Address, admins: Vec<Address>, threshold: u32)
```
Initializes the contract with the token address and a single native protocol admin address. If threshold policies are needed, configure them on that Stellar account or Soroban account contract.
- **Panics**:
  - `AlreadyInitialized` if already initialized.
  - `EmptyAdminList` if `admins` is empty.
  - `InvalidThreshold` if `admins.len() != 1` or `threshold != 1`.

### `get_token`
```rust
pub fn get_token(env: Env) -> Address
```
Returns the Stellar Asset Contract address configured during initialization.
- **Panics**:
  - `ContractNotInitialized` if not initialized.

### `get_multisig_admin`
```rust
pub fn get_multisig_admin(env: Env) -> MultisigAdmin
```
Returns the native protocol admin configuration. The legacy shape is retained, but `admins[0]` is the address authorized with Soroban native auth.
- **Panics**:
  - `ContractNotInitialized` if not initialized.

### `get_protocol_state`
```rust
pub fn get_protocol_state(env: Env) -> ProtocolState
```
Returns the current protocol state (`Active` or `Paused`).
- **Panics**:
  - `ContractNotInitialized` if not initialized.

---

### `register_org`
```rust
pub fn register_org(env: Env, id: Symbol, name: String, admin: Address)
```
Registers a new organization. Requires admin authorization.
- **Panics**:
  - `OrgAlreadyRegistered` if an organization with `id` exists.

### `get_org`
```rust
pub fn get_org(env: Env, id: Symbol) -> Organization
```
Retrieves the organization struct.
- **Panics**:
  - `OrgNotFound` if organization does not exist.

### `update_org_metadata`
```rust
pub fn update_org_metadata(env: Env, id: Symbol, admin: Address, metadata_cid: String)
```
Updates the metadata IPFS CID (Logo/Description) for the organization. Requires authorization from one of the organization admins.
- **Panics**:
  - `OrgNotFound` if organization does not exist.
  - `NotAuthorized` if caller is not an admin of the organization.

### `fund_org`
```rust
pub fn fund_org(env: Env, org_id: Symbol, from: Address, amount: i128)
```
Transfers `amount` of tokens from the caller's address `from` to the contract and increases the organization's budget.
- **Panics**:
  - `ProtocolPaused` if paused.
  - `InvalidAmount` if `amount <= 0`.
  - `AmountExceedsLimit` if `amount` exceeds 1 trillion tokens.
  - `OrgNotFound` if organization does not exist.
  - `BudgetOverflow` if the operation causes the budget to overflow.

### `add_admin`
```rust
pub fn add_admin(env: Env, org_id: Symbol, admin: Address, new_admin: Address)
```
Adds `new_admin` as an administrator of `org_id`. Requires authorization from `admin`.
- **Panics**:
  - `OrgNotFound` if organization does not exist.
  - `NotAuthorized` if caller is not an admin.
  - `MaxAdminLimitReached` if organization has 10 admins.
  - `AdminAlreadyExists` if `new_admin` is already an admin.

### `remove_admin`
```rust
pub fn remove_admin(env: Env, org_id: Symbol, admin: Address, admin_to_remove: Address)
```
Removes `admin_to_remove` from the administrators of `org_id`. Requires authorization from `admin`.
- **Panics**:
  - `OrgNotFound` if organization does not exist.
  - `NotAuthorized` if caller is not an admin.
  - `CannotRemoveLastAdmin` if organization has only 1 admin.
  - `NotAnAdmin` if `admin_to_remove` is not registered as an admin.

### `get_org_budget`
```rust
pub fn get_org_budget(env: Env, id: Symbol) -> i128
```
Returns the remaining token budget for `id`.

---

### `add_maintainer`
```rust
pub fn add_maintainer(env: Env, org_id: Symbol, maintainer: Address)
```
Enrolls `maintainer` under `org_id`. Requires organization admin authorization.
- **Panics**:
  - `OrgNotFound` if organization does not exist.
  - `MaintainerAlreadyRegistered` if maintainer is already registered with another org.

### `get_maintainer`
```rust
pub fn get_maintainer(env: Env, address: Address) -> Maintainer
```
Retrieves maintainer details.
- **Panics**:
  - `MaintainerNotRegistered` if maintainer is not registered.

### `get_maintainers`
```rust
pub fn get_maintainers(env: Env, org_id: Symbol) -> Vec<Address>
```
Lists all maintainer addresses registered under `org_id`.

---

### `allocate_payout`
```rust
pub fn allocate_payout(env: Env, org_id: Symbol, admin: Address, maintainer: Address, amount: i128, unlock_timestamp: u64)
```
Allocates a payout to a maintainer. The payout is locked until `unlock_timestamp` (Unix epoch time in seconds). Requires organization admin authorization.
- **Panics**:
  - `ProtocolPaused` if paused.
  - `NotAuthorized` if caller is not an admin.
  - `InvalidAmount` if `amount <= 0`.
  - `AmountExceedsLimit` if `amount` exceeds 1 trillion.
  - `MaintainerNotRegistered` if maintainer is not registered.
  - `MaintainerOrgMismatch` if maintainer belongs to a different org.
  - `InsufficientBudget` if the organization's budget is less than `amount`.
  - `PayoutOverflow` if the maintainer's claimable balance overflows.

### `batch_allocate`
```rust
pub fn batch_allocate(env: Env, admin: Address, org_id: Symbol, payouts: Vec<PayoutParams>)
```
Allocates multiple payouts in a single batch. Admin authorization is required once.
- **Panics**:
  - `ProtocolPaused` if paused.
  - `NotAuthorized` if caller is not an admin.
  - `BatchSizeExceeded` if `payouts.len() > 100`.
  - `EmptyBatch` if `payouts` is empty.
  - `InvalidAmount` / `AmountExceedsLimit` / `MaintainerNotRegistered` / `MaintainerOrgMismatch` for any entry in the batch.
  - `InsufficientBudget` if org budget cannot cover the total sum.
  - `PayoutOverflow` if any target maintainer's payout overflows.

### `get_claimable_balance`
```rust
pub fn get_claimable_balance(env: Env, maintainer: Address) -> i128
```
Returns the total claimable payout balance for `maintainer`.

### `claim_payout`
```rust
pub fn claim_payout(env: Env, maintainer: Address) -> i128
```
Claims the accumulated payout balance. Requires authorization from `maintainer`.
- **Panics**:
  - `ProtocolPaused` if paused.
  - `NoClaimableBalance` if claimable balance is 0.
  - `PayoutLocked` if the current ledger timestamp is less than `unlock_timestamp`.

---

### `pause_protocol`
```rust
pub fn pause_protocol(env: Env)
```
Pauses the protocol, blocking funding, allocation, and claim functions. Requires native authorization from the configured protocol admin address.

### `unpause_protocol`
```rust
pub fn unpause_protocol(env: Env)
```
Unpauses the protocol. Requires native authorization from the configured protocol admin address.

### `propose_admin`
```rust
pub fn propose_admin(env: Env, new_admin: Address)
```
Proposes a new global admin. Requires native authorization from the configured protocol admin address.

### `accept_admin`
```rust
pub fn accept_admin(env: Env, new_admin: Address)
```
Accepts the proposed global admin role and updates the native protocol admin configuration. Requires `new_admin` authorization.

### `upgrade`
```rust
pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>)
```
Upgrades the contract binary to the new WASM hash. Requires native authorization from the configured protocol admin address.

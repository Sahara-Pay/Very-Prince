#![no_std]

mod token_interface;

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, panic_with_error, symbol_short, token,
    Address, BytesN, Env, IntoVal, String, Symbol, Vec,
};
use token_interface::TokenMetadata;

// ─────────────────────────────────────────────────────────────────────────────
// Data Types
// ─────────────────────────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Organization {
    pub id: Symbol,
    pub name: String,
    pub admins: Vec<Address>,
    pub metadata_cid: Option<String>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Maintainer {
    pub address: Address,
    pub org_id: Symbol,
}

/// Represents a single payout entry in a batch allocation.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PayoutParams {
    pub maintainer: Address,
    pub amount: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MaintainerPayout {
    pub amount: i128,
    pub unlock_timestamp: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProtocolState {
    Active,
    Paused,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MultisigAdmin {
    pub admins: Vec<Address>,
    pub threshold: u32,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum PrinceError {
    /// The contract has already been initialized and cannot be re-configured.
    AlreadyInitialized = 1,
    /// The provided list of administrators for initialization is empty.
    EmptyAdminList = 2,
    /// The multisig threshold must be greater than zero and less than or equal to the number of admins.
    InvalidThreshold = 3,
    /// Attempted to call a function that requires the contract to be initialized.
    ContractNotInitialized = 4,
    /// The protocol is currently paused by the global administrators.
    ProtocolPaused = 5,
    /// The number of valid administrator signatures does not meet the required threshold.
    InsufficientMultisigAuth = 6,
    /// An organization with this ID (or derived from this admin/name) already exists.
    OrgAlreadyRegistered = 7,
    /// The requested organization could not be found in storage.
    OrgNotFound = 8,
    /// The caller does not have the necessary permissions for this operation.
    NotAuthorized = 9,
    /// The amount provided (funding or payout) must be a positive value.
    InvalidAmount = 10,
    /// The organization's total budget would exceed the maximum representable value.
    BudgetOverflow = 11,
    /// The organization does not have enough remaining budget to cover the payout.
    InsufficientBudget = 12,
    /// An organization cannot have more than 10 administrators.
    MaxAdminLimitReached = 13,
    /// The address is already registered as an administrator for this organization.
    AdminAlreadyExists = 14,
    /// Cannot remove the last administrator; an organization must have at least one.
    CannotRemoveLastAdmin = 15,
    /// The address is not currently an administrator of the specified organization.
    NotAnAdmin = 16,
    /// This maintainer is already associated with an organization.
    MaintainerAlreadyRegistered = 17,
    /// This maintainer is not registered in the system.
    MaintainerNotRegistered = 18,
    /// The maintainer is registered but belongs to a different organization.
    MaintainerOrgMismatch = 19,
    /// The maintainer's total claimable balance would exceed the maximum representable value.
    PayoutOverflow = 20,
    /// A batch payout operation cannot exceed 100 entries to prevent timeout.
    BatchSizeExceeded = 21,
    /// The provided list of payouts for a batch operation is empty.
    EmptyBatch = 22,
    /// The maintainer has no funds available to claim.
    NoClaimableBalance = 23,
    /// The payout is currently within its mandatory lock/vesting period.
    PayoutLocked = 24,
    /// There is no pending administrator proposal to accept.
    NoPendingAdmin = 25,
    /// The caller is not the address currently proposed as a new administrator.
    NotPendingAdmin = 26,
    /// Token metadata (name/symbol/decimals) could not be fetched during initialisation.
    TokenMetadataUnavailable = 27,
}

#[contracttype]
pub enum DataKey {
    /// The global Stellar Asset Contract address configured during initialization.
    Token,
    Organization(Symbol),
    OrgAdmin(Symbol),
    OrgMaintainers(Symbol),
    MaintainerOrg(Address),
    MaintainerBalance(Address),
    /// Total budget currently held by this org (in stroops).
    OrgBudget(Symbol),
    /// Multisig admin configuration for contract upgrades and emergency functions.
    MultisigAdmin,
    /// Current protocol state (Active or Paused).
    ProtocolState,
    /// Pending admin address proposed via propose_admin (two-step transfer).
    PendingAdmin,
    /// Cached token name from the underlying SAC (populated during init).
    TokenName,
    /// Cached token symbol from the underlying SAC (populated during init).
    TokenSymbol,
    /// Cached token decimals from the underlying SAC (populated during init).
    TokenDecimals,
}

// ─────────────────────────────────────────────────────────────────────────────
// TTL Constants
//
// Stellar charges rent for persistent ledger entries. Failing to extend TTLs
// is the #1 reason Soroban contracts fail on Mainnet after a few weeks.
//
// Ledger close time ≈ 5 seconds on Mainnet / Testnet.
//   30 days  ≈ 518_400 ledgers
//   7 days   ≈ 120_960 ledgers  (threshold — extend before this point)
// ─────────────────────────────────────────────────────────────────────────────

/// Extend persistent entries to live for ~30 days from the current ledger.
const PERSISTENT_BUMP_AMOUNT: u32 = 518_400;
/// Trigger an extension when fewer than ~7 days of TTL remain.
const PERSISTENT_LIFETIME_THRESHOLD: u32 = 120_960;

// ─────────────────────────────────────────────────────────────────────────────
// Technical Design Notes: Soroban Storage Model
//
// Soroban uses a state-archiving model to keep the ledger size manageable.
// Every entry (Persistent, Instance, Temporary) has a Time-To-Live (TTL).
//
// - Persistent: High-cost, long-lived data (Orgs, Maintainers).
// - Instance: Data associated with the contract instance itself.
// - Temporary: Low-cost data that expires quickly (not used here).
//
// Our implementation proactively bumps TTLs during read/write operations
// to ensure that registered organizations and their budgets never "evict"
// from the active ledger state.
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Contract
// ─────────────────────────────────────────────────────────────────────────────

#[contract]
pub struct PayoutRegistry;

#[contractimpl]
impl PayoutRegistry {
    // ─────────────────────────────────────────────────────────────────────────
    // Initialization
    // ─────────────────────────────────────────────────────────────────────────

    pub fn init(env: Env, token: Address, admins: Vec<Address>, threshold: u32) {
        if env.storage().persistent().has(&DataKey::Token) {
            panic_with_error!(&env, PrinceError::AlreadyInitialized);
        }

        if admins.is_empty() {
            panic_with_error!(&env, PrinceError::EmptyAdminList);
        }

        if threshold == 0 || threshold > admins.len() {
            panic_with_error!(&env, PrinceError::InvalidThreshold);
        }

        env.storage().persistent().set(&DataKey::Token, &token);
        env.storage().persistent().extend_ttl(
            &DataKey::Token,
            PERSISTENT_LIFETIME_THRESHOLD,
            PERSISTENT_BUMP_AMOUNT,
        );

        let multisig_admin = MultisigAdmin {
            admins: admins.clone(),
            threshold,
        };
        env.storage()
            .persistent()
            .set(&DataKey::MultisigAdmin, &multisig_admin);
        env.storage().persistent().extend_ttl(
            &DataKey::MultisigAdmin,
            PERSISTENT_LIFETIME_THRESHOLD,
            PERSISTENT_BUMP_AMOUNT,
        );
        env.storage()
            .persistent()
            .set(&DataKey::ProtocolState, &ProtocolState::Active);
        env.storage().persistent().extend_ttl(
            &DataKey::ProtocolState,
            PERSISTENT_LIFETIME_THRESHOLD,
            PERSISTENT_BUMP_AMOUNT,
        );

        // Fetch and cache token metadata from the SAC for 1:1 parameter mapping.
        // This ensures external contracts can query token params without calling
        // the token contract directly — a single source of truth.
        let metadata = token_interface::fetch_token_metadata(&env, &token);
        env.storage()
            .persistent()
            .set(&DataKey::TokenName, &metadata.name);
        env.storage().persistent().extend_ttl(
            &DataKey::TokenName,
            PERSISTENT_LIFETIME_THRESHOLD,
            PERSISTENT_BUMP_AMOUNT,
        );
        env.storage()
            .persistent()
            .set(&DataKey::TokenSymbol, &metadata.symbol);
        env.storage().persistent().extend_ttl(
            &DataKey::TokenSymbol,
            PERSISTENT_LIFETIME_THRESHOLD,
            PERSISTENT_BUMP_AMOUNT,
        );
        env.storage()
            .persistent()
            .set(&DataKey::TokenDecimals, &metadata.decimals);
        env.storage().persistent().extend_ttl(
            &DataKey::TokenDecimals,
            PERSISTENT_LIFETIME_THRESHOLD,
            PERSISTENT_BUMP_AMOUNT,
        );

        env.events().publish(
            (
                Symbol::new(&env, "VeryPrince"),
                Symbol::new(&env, "Initialized"),
            ),
            (token, admins.len(), threshold),
        );
    }

    /// Retrieve the cached SAC token metadata (name, symbol, decimals).
    ///
    /// This returns the metadata that was fetched during contract initialisation.
    /// It maps 1:1 with the SEP-41 token standard, ensuring AMM compatibility.
    ///
    /// # Returns
    /// `TokenMetadata` struct with name, symbol, and decimals.
    ///
    /// # Panics
    /// If the contract has not been initialised.
    pub fn get_token_metadata(env: Env) -> TokenMetadata {
        if !env.storage().persistent().has(&DataKey::TokenName) {
            panic_with_error!(&env, PrinceError::ContractNotInitialized);
        }
        env.storage().persistent().extend_ttl(
            &DataKey::TokenName,
            PERSISTENT_LIFETIME_THRESHOLD,
            PERSISTENT_BUMP_AMOUNT,
        );
        env.storage().persistent().extend_ttl(
            &DataKey::TokenSymbol,
            PERSISTENT_LIFETIME_THRESHOLD,
            PERSISTENT_BUMP_AMOUNT,
        );
        env.storage().persistent().extend_ttl(
            &DataKey::TokenDecimals,
            PERSISTENT_LIFETIME_THRESHOLD,
            PERSISTENT_BUMP_AMOUNT,
        );
        let name: String = env
            .storage()
            .persistent()
            .get(&DataKey::TokenName)
            .unwrap_or_else(|| panic_with_error!(&env, PrinceError::TokenMetadataUnavailable));
        let symbol: String = env
            .storage()
            .persistent()
            .get(&DataKey::TokenSymbol)
            .unwrap_or_else(|| panic_with_error!(&env, PrinceError::TokenMetadataUnavailable));
        let decimals: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::TokenDecimals)
            .unwrap_or_else(|| panic_with_error!(&env, PrinceError::TokenMetadataUnavailable));
        TokenMetadata {
            name,
            symbol,
            decimals,
        }
    }

    /// Query the token balance of any address.
    ///
    /// Delegates to the SAC `balance(id: Address) -> i128` function.
    /// This is a read-only function — no authentication required.
    pub fn token_balance(env: Env, id: Address) -> i128 {
        let token_addr = Self::get_token(env.clone());
        token_interface::sac_balance(&env, &token_addr, &id)
    }

    /// Mint new tokens to the specified address.
    ///
    /// Requires multisig authorization from protocol admins because minting
    /// inflates the token supply. This delegates to the SAC admin `mint` function.
    ///
    /// # Arguments
    /// * `env` - The contract environment.
    /// * `signers` - Multisig signers who must meet the threshold.
    /// * `to` - Recipient address for the newly minted tokens.
    /// * `amount` - Amount of tokens to mint (in the token's base unit).
    ///
    /// # Panics
    /// * If insufficient multisig signatures are provided.
    /// * If the amount is not positive.
    pub fn mint_token(env: Env, signers: Vec<Address>, to: Address, amount: i128) {
        Self::verify_multisig_auth(&env, &signers);

        if amount <= 0 {
            panic_with_error!(&env, PrinceError::InvalidAmount);
        }

        let token_addr = Self::get_token(env.clone());
        token_interface::sac_mint(&env, &token_addr, &to, &amount);

        env.events().publish(
            (
                Symbol::new(&env, "VeryPrince"),
                Symbol::new(&env, "TokenMinted"),
            ),
            (to, amount),
        );
    }

    /// Query the allowance `from` has granted to `spender`.
    ///
    /// Delegates to the SAC `allowance(from, spender) -> i128` function.
    /// This is required for AMM compatibility — AMM routers check allowances
    /// before executing swaps.
    pub fn token_allowance(env: Env, from: Address, spender: Address) -> i128 {
        let token_addr = Self::get_token(env.clone());
        token_interface::sac_allowance(&env, &token_addr, &from, &spender)
    }

    /// Approve `spender` to transfer up to `amount` tokens from `from`.
    ///
    /// Delegates to the SAC `approve(from, spender, amount, expiration_ledger)`.
    /// This is required for AMM compatibility — AMM routers call `approve` on the
    /// token before executing swaps.
    ///
    /// # Authorization
    /// The `from` address must authorise this call.
    pub fn token_approve(
        env: Env,
        from: Address,
        spender: Address,
        amount: i128,
        expiration_ledger: u32,
    ) {
        from.require_auth_for_args(
            (from.clone(), spender.clone(), amount, expiration_ledger).into_val(&env),
        );

        if amount < 0 {
            panic_with_error!(&env, PrinceError::InvalidAmount);
        }

        let token_addr = Self::get_token(env.clone());
        token_interface::sac_approve(&env, &token_addr, &from, &spender, amount, expiration_ledger);

        env.events().publish(
            (
                Symbol::new(&env, "VeryPrince"),
                Symbol::new(&env, "TokenApproved"),
            ),
            (from, spender, amount),
        );
    }

    /// Transfer tokens on behalf of another address using an allowance.
    ///
    /// Delegates to the SAC `transfer_from(spender, from, to, amount)`.
    /// This is required for AMM compatibility — AMM routers use this to move tokens
    /// on behalf of users who have approved an allowance.
    ///
    /// # Authorization
    /// The `spender` address must authorise this call.
    pub fn token_transfer_from(
        env: Env,
        spender: Address,
        from: Address,
        to: Address,
        amount: i128,
    ) {
        spender.require_auth_for_args(
            (spender.clone(), from.clone(), to.clone(), amount).into_val(&env),
        );

        if amount <= 0 {
            panic_with_error!(&env, PrinceError::InvalidAmount);
        }

        let token_addr = Self::get_token(env.clone());
        token_interface::sac_transfer_from(&env, &token_addr, &spender, &from, &to, &amount);

        env.events().publish(
            (
                Symbol::new(&env, "VeryPrince"),
                Symbol::new(&env, "TokenTransferFrom"),
            ),
            (spender, from, to, amount),
        );
    }

    pub fn get_token(env: Env) -> Address {
        env.storage().persistent().extend_ttl(
            &DataKey::Token,
            PERSISTENT_LIFETIME_THRESHOLD,
            PERSISTENT_BUMP_AMOUNT,
        );
        env.storage()
            .persistent()
            .get(&DataKey::Token)
            .unwrap_or_else(|| panic_with_error!(&env, PrinceError::ContractNotInitialized))
    }

    /// Retrieve the multisig admin configuration.
    ///
    /// # Panics
    /// If the contract has not been initialized.
    pub fn get_multisig_admin(env: Env) -> MultisigAdmin {
        env.storage().persistent().extend_ttl(
            &DataKey::MultisigAdmin,
            PERSISTENT_LIFETIME_THRESHOLD,
            PERSISTENT_BUMP_AMOUNT,
        );
        env.storage()
            .persistent()
            .get(&DataKey::MultisigAdmin)
            .unwrap_or_else(|| panic_with_error!(&env, PrinceError::ContractNotInitialized))
    }

    /// Retrieve the current protocol state.
    ///
    /// # Panics
    /// If the contract has not been initialized.
    pub fn get_protocol_state(env: Env) -> ProtocolState {
        env.storage().persistent().extend_ttl(
            &DataKey::ProtocolState,
            PERSISTENT_LIFETIME_THRESHOLD,
            PERSISTENT_BUMP_AMOUNT,
        );
        env.storage()
            .persistent()
            .get(&DataKey::ProtocolState)
            .unwrap_or_else(|| panic_with_error!(&env, PrinceError::ContractNotInitialized))
    }

    /// Assert that the protocol is currently active.
    ///
    /// # Panics
    /// If the protocol is paused.
    fn assert_active(env: &Env) {
        let state = Self::get_protocol_state(env.clone());
        match state {
            ProtocolState::Active => {} // Continue normally
            ProtocolState::Paused => panic_with_error!(env, PrinceError::ProtocolPaused),
        }
    }

    /// Verify that the caller has sufficient multisig authorization.
    ///
    /// This function checks that at least `threshold` admins from the multisig
    /// configuration have authorized the action. In Soroban, this is handled
    /// natively by the Stellar network's account structure, but we need to
    /// verify that the authorization payload contains the required signatures.
    ///
    /// # Panics
    /// If insufficient signatures are provided
    fn verify_multisig_auth(env: &Env, signers: &Vec<Address>) {
        let multisig_admin = Self::get_multisig_admin(env.clone());

        // Verify unique signers count meets threshold
        let mut unique_signers = Vec::new(env);
        for signer in signers.iter() {
            if !unique_signers.contains(&signer) {
                unique_signers.push_back(signer.clone());
            }
        }

        if unique_signers.len() < multisig_admin.threshold {
            panic_with_error!(env, PrinceError::InsufficientMultisigAuth);
        }

        // Check that each signer is a registered admin and has authorized this call
        for signer in unique_signers.iter() {
            if !multisig_admin.admins.contains(&signer) {
                panic_with_error!(env, PrinceError::NotAuthorized);
            }
            signer.require_auth();
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Organisation Management & Funding
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Register a new organization on the contract.
     *
     * This function generates a deterministic organization ID based on the admin's
     * address and the organization's name. It initializes the organization's
     * data structure, budget, and maintainer list in persistent storage.
     *
     * @param env - The Soroban execution environment.
     * @param admin - The Stellar address of the initial administrator.
     * @param name - The human-readable name of the organization.
     * @returns The generated 32-byte organization ID.
     */
    pub fn register_org(env: Env, id: Symbol, name: String, admin: Address) {
        admin.require_auth();

        let org_key = DataKey::Organization(id.clone());

        if env.storage().persistent().has(&org_key) {
            panic_with_error!(&env, PrinceError::OrgAlreadyRegistered);
        }

        let mut admins = Vec::new(&env);
        admins.push_back(admin.clone());

        let org = Organization {
            id: id.clone(),
            name,
            admins: admins.clone(),
            metadata_cid: None,
        };
        env.storage().persistent().set(&org_key, &org);
        env.storage().persistent().extend_ttl(
            &org_key,
            PERSISTENT_LIFETIME_THRESHOLD,
            PERSISTENT_BUMP_AMOUNT,
        );

        env.storage()
            .persistent()
            .set(&DataKey::OrgAdmin(id.clone()), &admin);
        env.storage().persistent().extend_ttl(
            &DataKey::OrgAdmin(id.clone()),
            PERSISTENT_LIFETIME_THRESHOLD,
            PERSISTENT_BUMP_AMOUNT,
        );

        let empty_list: Vec<Address> = Vec::new(&env);
        env.storage()
            .persistent()
            .set(&DataKey::OrgMaintainers(id.clone()), &empty_list);
        env.storage().persistent().extend_ttl(
            &DataKey::OrgMaintainers(id.clone()),
            PERSISTENT_LIFETIME_THRESHOLD,
            PERSISTENT_BUMP_AMOUNT,
        );

        env.storage()
            .persistent()
            .set(&DataKey::OrgBudget(id.clone()), &0_i128);
        env.storage().persistent().extend_ttl(
            &DataKey::OrgBudget(id.clone()),
            PERSISTENT_LIFETIME_THRESHOLD,
            PERSISTENT_BUMP_AMOUNT,
        );

        env.events().publish(
            (
                Symbol::new(&env, "VeryPrince"),
                Symbol::new(&env, "org_registered"),
            ),
            (id.clone(), admin.clone()),
        );
    }

    pub fn get_org(env: Env, id: Symbol) -> Organization {
        env.storage().persistent().extend_ttl(
            &DataKey::Organization(id.clone()),
            PERSISTENT_LIFETIME_THRESHOLD,
            PERSISTENT_BUMP_AMOUNT,
        );
        env.storage()
            .persistent()
            .get(&DataKey::Organization(id))
            .unwrap_or_else(|| panic_with_error!(&env, PrinceError::OrgNotFound))
    }

    /// Update the IPFS CID for an organization's metadata (Logo/Description).
    /// Requires authorization from the specified organization admin.
    pub fn update_org_metadata(env: Env, id: Symbol, admin: Address, metadata_cid: String) {
        admin.require_auth();

        let org_key = DataKey::Organization(id.clone());
        let mut org: Organization = env
            .storage()
            .persistent()
            .get(&org_key)
            .unwrap_or_else(|| panic_with_error!(&env, PrinceError::OrgNotFound));

        // Verify that the signer is indeed an admin of the organization
        let mut is_authorized = false;
        for i in 0..org.admins.len() {
            if org.admins.get(i).unwrap() == admin {
                is_authorized = true;
                break;
            }
        }

        if !is_authorized {
            panic_with_error!(&env, PrinceError::NotAuthorized);
        }

        org.metadata_cid = Some(metadata_cid.clone());
        env.storage().persistent().set(&org_key, &org);
        env.storage().persistent().extend_ttl(
            &org_key,
            PERSISTENT_LIFETIME_THRESHOLD,
            PERSISTENT_BUMP_AMOUNT,
        );

        env.events().publish(
            (
                Symbol::new(&env, "VeryPrince"),
                Symbol::new(&env, "OrgMetadataUpdated"),
            ),
            (id, metadata_cid),
        );
    }

    pub fn fund_org(env: Env, org_id: Symbol, from: Address, amount: i128) {
        Self::assert_active(&env);

        // Strict authorization: bind the signature to the exact parameters
        from.require_auth_for_args((org_id.clone(), from.clone(), amount).into_val(&env));

        if amount <= 0 {
            panic_with_error!(&env, PrinceError::InvalidAmount);
        }

        if !env
            .storage()
            .persistent()
            .has(&DataKey::Organization(org_id.clone()))
        {
            panic_with_error!(&env, PrinceError::OrgNotFound);
        }

        // Effects: Update the Persistent Storage first (CEI)
        let budget_key = DataKey::OrgBudget(org_id.clone());
        let current_budget: i128 = env.storage().persistent().get(&budget_key).unwrap_or(0);
        let new_budget = current_budget
            .checked_add(amount)
            .unwrap_or_else(|| panic_with_error!(&env, PrinceError::BudgetOverflow));
        env.storage().persistent().set(&budget_key, &new_budget);
        env.storage().persistent().extend_ttl(
            &budget_key,
            PERSISTENT_LIFETIME_THRESHOLD,
            PERSISTENT_BUMP_AMOUNT,
        );

        // Interactions: Execute the token transfer as the absolute last step
        // This follows the Check-Effects-Interactions pattern.
        let token = Self::get_token(env.clone());
        token_interface::sac_transfer(&env, &token, &from, &env.current_contract_address(), &amount);

        env.events().publish(
            (
                Symbol::new(&env, "VeryPrince"),
                Symbol::new(&env, "OrgFunded"),
            ),
            (org_id, from, amount),
        );
    }

    pub fn add_admin(env: Env, org_id: Symbol, admin: Address, new_admin: Address) {
        admin.require_auth();
        let mut org = Self::get_org(env.clone(), org_id.clone());

        // Authorization: Check if the passed admin is an existing admin
        if !org.admins.contains(&admin) {
            panic_with_error!(&env, PrinceError::NotAuthorized);
        }

        if org.admins.len() >= 10 {
            panic_with_error!(&env, PrinceError::MaxAdminLimitReached);
        }

        for i in 0..org.admins.len() {
            if org.admins.get(i).unwrap() == new_admin {
                panic_with_error!(&env, PrinceError::AdminAlreadyExists);
            }
        }

        org.admins.push_back(new_admin.clone());
        env.storage()
            .persistent()
            .set(&DataKey::Organization(org_id.clone()), &org);
        env.storage().persistent().extend_ttl(
            &DataKey::Organization(org_id.clone()),
            PERSISTENT_LIFETIME_THRESHOLD,
            PERSISTENT_BUMP_AMOUNT,
        );

        env.events().publish(
            (
                Symbol::new(&env, "VeryPrince"),
                Symbol::new(&env, "AdminAdded"),
            ),
            (org_id, new_admin),
        );
    }

    pub fn remove_admin(env: Env, org_id: Symbol, admin: Address, admin_to_remove: Address) {
        admin.require_auth();
        let mut org = Self::get_org(env.clone(), org_id.clone());

        // Authorization: Check if the passed admin is an existing admin
        if !org.admins.contains(&admin) {
            panic_with_error!(&env, PrinceError::NotAuthorized);
        }

        if org.admins.len() <= 1 {
            panic_with_error!(&env, PrinceError::CannotRemoveLastAdmin);
        }

        let mut index = None;
        for i in 0..org.admins.len() {
            if org.admins.get(i).unwrap() == admin_to_remove {
                index = Some(i);
                break;
            }
        }

        match index {
            Some(i) => {
                org.admins.remove(i);
                env.storage()
                    .persistent()
                    .set(&DataKey::Organization(org_id.clone()), &org);
                env.storage().persistent().extend_ttl(
                    &DataKey::Organization(org_id.clone()),
                    PERSISTENT_LIFETIME_THRESHOLD,
                    PERSISTENT_BUMP_AMOUNT,
                );
            }
            None => panic_with_error!(&env, PrinceError::NotAnAdmin),
        }

        env.events().publish(
            (
                Symbol::new(&env, "VeryPrince"),
                Symbol::new(&env, "AdminRemoved"),
            ),
            (org_id, admin_to_remove),
        );
    }

    pub fn get_org_budget(env: Env, id: Symbol) -> i128 {
        env.storage().persistent().extend_ttl(
            &DataKey::OrgBudget(id.clone()),
            PERSISTENT_LIFETIME_THRESHOLD,
            PERSISTENT_BUMP_AMOUNT,
        );
        env.storage()
            .persistent()
            .get(&DataKey::OrgBudget(id))
            .unwrap_or(0_i128)
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Maintainer Management
    // ─────────────────────────────────────────────────────────────────────────

    pub fn add_maintainer(env: Env, org_id: Symbol, maintainer: Address) {
        let admin: Address = env
            .storage()
            .persistent()
            .get(&DataKey::OrgAdmin(org_id.clone()))
            .unwrap_or_else(|| panic_with_error!(&env, PrinceError::OrgNotFound));
        admin.require_auth();

        if env
            .storage()
            .persistent()
            .has(&DataKey::MaintainerOrg(maintainer.clone()))
        {
            panic_with_error!(&env, PrinceError::MaintainerAlreadyRegistered);
        }

        env.storage()
            .persistent()
            .set(&DataKey::MaintainerOrg(maintainer.clone()), &org_id);
        env.storage().persistent().extend_ttl(
            &DataKey::MaintainerOrg(maintainer.clone()),
            PERSISTENT_LIFETIME_THRESHOLD,
            PERSISTENT_BUMP_AMOUNT,
        );

        env.storage().persistent().set(
            &DataKey::MaintainerBalance(maintainer.clone()),
            &MaintainerPayout {
                amount: 0,
                unlock_timestamp: 0,
            },
        );
        env.storage().persistent().extend_ttl(
            &DataKey::MaintainerBalance(maintainer.clone()),
            PERSISTENT_LIFETIME_THRESHOLD,
            PERSISTENT_BUMP_AMOUNT,
        );

        let maintainer_list_key = DataKey::OrgMaintainers(org_id.clone());
        let mut maintainers: Vec<Address> = env
            .storage()
            .persistent()
            .get(&maintainer_list_key)
            .unwrap_or_else(|| Vec::new(&env));
        maintainers.push_back(maintainer.clone());
        env.storage()
            .persistent()
            .set(&maintainer_list_key, &maintainers);
        env.storage().persistent().extend_ttl(
            &maintainer_list_key,
            PERSISTENT_LIFETIME_THRESHOLD,
            PERSISTENT_BUMP_AMOUNT,
        );

        env.events().publish(
            (
                Symbol::new(&env, "VeryPrince"),
                Symbol::new(&env, "MaintainerAdded"),
            ),
            (org_id, maintainer),
        );
    }

    pub fn get_maintainer(env: Env, address: Address) -> Maintainer {
        env.storage().persistent().extend_ttl(
            &DataKey::MaintainerOrg(address.clone()),
            PERSISTENT_LIFETIME_THRESHOLD,
            PERSISTENT_BUMP_AMOUNT,
        );
        let org_id: Symbol = env
            .storage()
            .persistent()
            .get(&DataKey::MaintainerOrg(address.clone()))
            .unwrap_or_else(|| panic_with_error!(&env, PrinceError::MaintainerNotRegistered));
        Maintainer { address, org_id }
    }

    pub fn get_maintainers(env: Env, org_id: Symbol) -> Vec<Address> {
        env.storage().persistent().extend_ttl(
            &DataKey::OrgMaintainers(org_id.clone()),
            PERSISTENT_LIFETIME_THRESHOLD,
            PERSISTENT_BUMP_AMOUNT,
        );
        env.storage()
            .persistent()
            .get(&DataKey::OrgMaintainers(org_id))
            .unwrap_or_else(|| Vec::new(&env))
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Payout Allocation & Claiming
    // ─────────────────────────────────────────────────────────────────────────

    pub fn allocate_payout(
        env: Env,
        org_id: Symbol,
        admin: Address,
        maintainer: Address,
        amount: i128,
        unlock_timestamp: u64,
    ) {
        Self::assert_active(&env);
        let org = Self::get_org(env.clone(), org_id.clone());

        // Authorization: Check if the passed admin is an existing admin
        if !org.admins.contains(&admin) {
            panic_with_error!(&env, PrinceError::NotAuthorized);
        }

        admin.require_auth_for_args(
            (
                org_id.clone(),
                admin.clone(),
                maintainer.clone(),
                amount,
                unlock_timestamp,
            )
                .into_val(&env),
        );

        if amount <= 0 {
            panic_with_error!(&env, PrinceError::InvalidAmount);
        }

        let maintainer_org: Symbol = env
            .storage()
            .persistent()
            .get(&DataKey::MaintainerOrg(maintainer.clone()))
            .unwrap_or_else(|| panic_with_error!(&env, PrinceError::MaintainerNotRegistered));
        if maintainer_org != org_id {
            panic_with_error!(&env, PrinceError::MaintainerOrgMismatch);
        }

        let budget_key = DataKey::OrgBudget(org_id.clone());
        let current_budget: i128 = env.storage().persistent().get(&budget_key).unwrap_or(0);
        if current_budget < amount {
            panic_with_error!(&env, PrinceError::InsufficientBudget);
        }

        env.storage()
            .persistent()
            .set(&budget_key, &(current_budget - amount));
        env.storage().persistent().extend_ttl(
            &budget_key,
            PERSISTENT_LIFETIME_THRESHOLD,
            PERSISTENT_BUMP_AMOUNT,
        );

        let balance_key = DataKey::MaintainerBalance(maintainer.clone());
        let mut current_payout: MaintainerPayout = env
            .storage()
            .persistent()
            .get(&balance_key)
            .unwrap_or(MaintainerPayout {
                amount: 0,
                unlock_timestamp: 0,
            });
        current_payout.amount = current_payout
            .amount
            .checked_add(amount)
            .unwrap_or_else(|| panic_with_error!(&env, PrinceError::PayoutOverflow));
        current_payout.unlock_timestamp = unlock_timestamp;
        env.storage()
            .persistent()
            .set(&balance_key, &current_payout);
        env.storage().persistent().extend_ttl(
            &balance_key,
            PERSISTENT_LIFETIME_THRESHOLD,
            PERSISTENT_BUMP_AMOUNT,
        );

        env.events().publish(
            (
                Symbol::new(&env, "VeryPrince"),
                Symbol::new(&env, "PayoutAllocated"),
            ),
            (org_id, maintainer, amount),
        );
    }

    /// Allocate payouts to multiple maintainers in a single transaction.
    ///
    /// Admin auth is required only once for the entire batch.
    /// The total sum of all payouts must not exceed the organization's current budget.
    /// Maximum batch size is 100 entries to stay within Soroban CPU/instruction limits.
    pub fn batch_allocate(env: Env, admin: Address, org_id: Symbol, payouts: Vec<PayoutParams>) {
        // Require admin auth once for the entire batch
        admin.require_auth();

        // Verify caller is one of the registered admins for this org
        let org = Self::get_org(env.clone(), org_id.clone());
        let mut is_authorized = false;
        for i in 0..org.admins.len() {
            if org.admins.get(i).unwrap() == admin {
                is_authorized = true;
                break;
            }
        }
        if !is_authorized {
            panic_with_error!(&env, PrinceError::NotAuthorized);
        }

        // Enforce batch size limit to prevent out-of-gas errors
        if payouts.len() > 100 {
            panic_with_error!(&env, PrinceError::BatchSizeExceeded);
        }

        if payouts.is_empty() {
            panic_with_error!(&env, PrinceError::EmptyBatch);
        }

        // Compute total payout sum and validate each entry before touching storage
        let mut total: i128 = 0_i128;
        for i in 0..payouts.len() {
            let entry = payouts.get(i).unwrap();
            if entry.amount <= 0 {
                panic_with_error!(&env, PrinceError::InvalidAmount);
            }
            let maintainer_org: Symbol = env
                .storage()
                .persistent()
                .get(&DataKey::MaintainerOrg(entry.maintainer.clone()))
                .unwrap_or_else(|| panic_with_error!(&env, PrinceError::MaintainerNotRegistered));
            if maintainer_org != org_id {
                panic_with_error!(&env, PrinceError::MaintainerOrgMismatch);
            }
            total = total
                .checked_add(entry.amount)
                .unwrap_or_else(|| panic_with_error!(&env, PrinceError::PayoutOverflow));
        }

        // Verify the org has enough budget to cover the entire batch
        let budget_key = DataKey::OrgBudget(org_id.clone());
        let current_budget: i128 = env.storage().persistent().get(&budget_key).unwrap_or(0);
        if current_budget < total {
            panic_with_error!(&env, PrinceError::InsufficientBudget);
        }

        // Deduct total from org budget in one write
        env.storage()
            .persistent()
            .set(&budget_key, &(current_budget - total));
        env.storage().persistent().extend_ttl(
            &budget_key,
            PERSISTENT_LIFETIME_THRESHOLD,
            PERSISTENT_BUMP_AMOUNT,
        );

        // Accumulate each maintainer's claimable balance
        for i in 0..payouts.len() {
            let entry = payouts.get(i).unwrap();
            let balance_key = DataKey::MaintainerBalance(entry.maintainer.clone());
            let mut current_payout: MaintainerPayout = env
                .storage()
                .persistent()
                .get(&balance_key)
                .unwrap_or(MaintainerPayout {
                    amount: 0,
                    unlock_timestamp: 0,
                });
            current_payout.amount = current_payout
                .amount
                .checked_add(entry.amount)
                .unwrap_or_else(|| panic_with_error!(&env, PrinceError::PayoutOverflow));
            env.storage()
                .persistent()
                .set(&balance_key, &current_payout);
            env.storage().persistent().extend_ttl(
                &balance_key,
                PERSISTENT_LIFETIME_THRESHOLD,
                PERSISTENT_BUMP_AMOUNT,
            );
        }

        // Emit a single batch_allocated event
        env.events().publish(
            (symbol_short!("payout"), symbol_short!("batch_alc")),
            (org_id, admin, total),
        );
    }

    pub fn get_claimable_balance(env: Env, maintainer: Address) -> i128 {
        env.storage().persistent().extend_ttl(
            &DataKey::MaintainerBalance(maintainer.clone()),
            PERSISTENT_LIFETIME_THRESHOLD,
            PERSISTENT_BUMP_AMOUNT,
        );
        let payout: MaintainerPayout = env
            .storage()
            .persistent()
            .get(&DataKey::MaintainerBalance(maintainer))
            .unwrap_or(MaintainerPayout {
                amount: 0,
                unlock_timestamp: 0,
            });
        payout.amount
    }

    pub fn claim_payout(env: Env, maintainer: Address) -> i128 {
        Self::assert_active(&env);

        // Strict authorization: ensure the maintainer is the one claiming
        maintainer.require_auth_for_args((maintainer.clone(),).into_val(&env));

        let balance_key = DataKey::MaintainerBalance(maintainer.clone());
        let mut payout: MaintainerPayout =
            env.storage()
                .persistent()
                .get(&balance_key)
                .unwrap_or(MaintainerPayout {
                    amount: 0,
                    unlock_timestamp: 0,
                });

        if payout.amount == 0 {
            panic_with_error!(&env, PrinceError::NoClaimableBalance);
        }

        if env.ledger().timestamp() < payout.unlock_timestamp {
            panic_with_error!(&env, PrinceError::PayoutLocked);
        }

        let amount_to_claim = payout.amount;

        // Effects: Update the Persistent Storage first (CEI)
        // Reset balance BEFORE transfer to prevent reentrancy or state corruption
        payout.amount = 0;
        env.storage().persistent().set(&balance_key, &payout);
        env.storage().persistent().extend_ttl(
            &balance_key,
            PERSISTENT_LIFETIME_THRESHOLD,
            PERSISTENT_BUMP_AMOUNT,
        );

        // Interactions: Execute the token transfer as the absolute last step
        // This follows the Check-Effects-Interactions pattern.
        let token = Self::get_token(env.clone());
        token_interface::sac_transfer(
            &env,
            &token,
            &env.current_contract_address(),
            &maintainer,
            &amount_to_claim,
        );

        env.events().publish(
            (
                Symbol::new(&env, "VeryPrince"),
                Symbol::new(&env, "PayoutClaimed"),
            ),
            (maintainer, amount_to_claim),
        );

        amount_to_claim
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Protocol Pause/Unpause
    // ─────────────────────────────────────────────────────────────────────────

    /// Pause the protocol. Requires multisig authorization from protocol admins.
    ///
    /// When paused, all fund_org, allocate_payout, and claim_payout operations
    /// will be blocked with a "protocol is paused" error.
    ///
    /// # Arguments
    /// * `env` - The contract environment
    pub fn pause_protocol(env: Env, signers: Vec<Address>) {
        // Verify multisig authorization
        Self::verify_multisig_auth(&env, &signers);

        // Update the protocol state to paused
        env.storage()
            .persistent()
            .set(&DataKey::ProtocolState, &ProtocolState::Paused);
        env.storage().persistent().extend_ttl(
            &DataKey::ProtocolState,
            PERSISTENT_LIFETIME_THRESHOLD,
            PERSISTENT_BUMP_AMOUNT,
        );

        // Emit pause event
        env.events().publish(
            (
                Symbol::new(&env, "VeryPrince"),
                Symbol::new(&env, "ProtocolPaused"),
            ),
            env.ledger().timestamp(),
        );
    }

    /// Unpause the protocol. Requires multisig authorization from protocol admins.
    ///
    /// When unpaused, normal operations resume.
    ///
    /// # Arguments
    /// * `env` - The contract environment
    pub fn unpause_protocol(env: Env, signers: Vec<Address>) {
        // Verify multisig authorization
        Self::verify_multisig_auth(&env, &signers);

        // Update the protocol state to active
        env.storage()
            .persistent()
            .set(&DataKey::ProtocolState, &ProtocolState::Active);
        env.storage().persistent().extend_ttl(
            &DataKey::ProtocolState,
            PERSISTENT_LIFETIME_THRESHOLD,
            PERSISTENT_BUMP_AMOUNT,
        );

        // Emit unpause event
        env.events().publish(
            (
                Symbol::new(&env, "VeryPrince"),
                Symbol::new(&env, "ProtocolUnpaused"),
            ),
            env.ledger().timestamp(),
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Protocol Admin Rotation (two-step ownership transfer)
    // ─────────────────────────────────────────────────────────────────────────

    /// Step 1 of admin transfer: the current multisig admin proposes a new admin.
    ///
    /// The new admin is stored as `PendingAdmin` and must call `accept_admin` to
    /// complete the transfer. This prevents accidentally transferring ownership to
    /// an invalid or burned address.
    ///
    /// # Panics
    /// * If multisig authorization is insufficient.
    pub fn propose_admin(env: Env, signers: Vec<Address>, new_admin: Address) {
        Self::verify_multisig_auth(&env, &signers);
        env.storage()
            .persistent()
            .set(&DataKey::PendingAdmin, &new_admin);
        env.events().publish(
            (
                Symbol::new(&env, "VeryPrince"),
                Symbol::new(&env, "AdminProposed"),
            ),
            new_admin,
        );
    }

    /// Step 2 of admin transfer: the proposed new admin accepts ownership.
    ///
    /// Replaces the multisig admin list with a single-member list containing
    /// `new_admin` and clears the pending admin slot.
    ///
    /// # Panics
    /// * If there is no pending admin proposal.
    /// * If the caller is not the pending admin.
    pub fn accept_admin(env: Env, new_admin: Address) {
        new_admin.require_auth();
        let pending: Address = env
            .storage()
            .persistent()
            .get(&DataKey::PendingAdmin)
            .unwrap_or_else(|| panic_with_error!(&env, PrinceError::NoPendingAdmin));
        if pending != new_admin {
            panic_with_error!(&env, PrinceError::NotPendingAdmin);
        }
        // Build a new single-member multisig with threshold 1
        let mut admins = Vec::new(&env);
        admins.push_back(new_admin.clone());
        let multisig_admin = MultisigAdmin {
            admins,
            threshold: 1,
        };
        env.storage()
            .persistent()
            .set(&DataKey::MultisigAdmin, &multisig_admin);
        env.storage().persistent().remove(&DataKey::PendingAdmin);
        env.events().publish(
            (
                Symbol::new(&env, "VeryPrince"),
                Symbol::new(&env, "admin_transferred"),
            ),
            new_admin,
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Contract Upgradeability
    // ─────────────────────────────────────────────────────────────────────────

    /// Upgrade the contract to a new WASM binary.
    ///
    /// This function requires multisig authorization from protocol admins and allows for
    /// upgrading the contract code while preserving all contract state.
    ///
    /// # Arguments
    /// * `env` - The contract environment
    /// * `new_wasm_hash` - The 32-byte hash of the new WASM binary
    ///
    /// # Panics
    /// * If insufficient multisig signatures are provided
    /// * If the WASM hash is invalid
    pub fn upgrade(env: Env, signers: Vec<Address>, new_wasm_hash: BytesN<32>) {
        // Verify multisig authorization
        Self::verify_multisig_auth(&env, &signers);

        // Perform the upgrade
        env.deployer()
            .update_current_contract_wasm(new_wasm_hash.clone());

        // Emit upgrade event
        env.events().publish(
            (
                Symbol::new(&env, "VeryPrince"),
                Symbol::new(&env, "ContractUpgraded"),
            ),
            (new_wasm_hash, env.ledger().timestamp()),
        );
    }
}
#[cfg(test)]
mod tests;

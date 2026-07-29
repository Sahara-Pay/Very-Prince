//! SAC (Stellar Asset Contract) Token Interface
//!
//! This module provides a standardised wrapper around the Stellar Asset Contract
//! (SAC) token interface. It exposes the full SEP-41 token trait as defined by
//! the Soroban SDK, ensuring 1:1 parameter mapping for AMM compatibility.
//!
//! The PayoutRegistry contract is a **consumer** of SAC tokens — it holds tokens
//! in its vault and transfers them to maintainers. This module gives external
//! contracts and off-chain clients a single source of truth for token metadata
//! and admin operations.
//!
//! ## SAC Token Interface (SEP-41)
//!
//! | Function         | Signature                                              |
//! |-----------------|--------------------------------------------------------|
//! | `name`          | `() -> String`                                         |
//! | `symbol`        | `() -> String`                                         |
//! | `decimals`      | `() -> u32`                                            |
//! | `balance`       | `(Address) -> i128`                                    |
//! | `allowance`     | `(Address, Address) -> i128`                           |
//! | `approve`       | `(Address, Address, i128, u32) -> ()`                  |
//! | `transfer`      | `(Address, Address, i128) -> ()`                       |
//! | `transfer_from` | `(Address, Address, Address, i128) -> ()`              |
//!
//! ## SAC Admin Interface
//!
//! | Function       | Signature                         |
//! |---------------|-----------------------------------|
//! | `mint`        | `(Address, i128) -> ()`           |
//! | `set_admin`   | `(Address) -> ()`                 |
//! | `clawback`    | `(Address, i128) -> ()`           |

use soroban_sdk::{contracttype, token, Address, Env, String};

/// Token metadata cached during contract initialisation.
///
/// Maps 1:1 with the SEP-41 `name()`, `symbol()`, and `decimals()` return values
/// from the underlying Stellar Asset Contract.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TokenMetadata {
    pub name: String,
    pub symbol: String,
    pub decimals: u32,
}

/// Fetch token metadata from the underlying SAC token and cache the result.
///
/// This function is called once during contract initialisation. After that,
/// `get_cached_metadata` can be used to retrieve the cached values without
/// making an external cross-contract call.
///
/// # Arguments
/// * `env` - The Soroban execution environment.
/// * `token_address` - The address of the deployed Stellar Asset Contract.
///
/// # Returns
/// `TokenMetadata` containing the token's name, symbol, and decimals.
pub fn fetch_token_metadata(env: &Env, token_address: &Address) -> TokenMetadata {
    let token_client = token::Client::new(env, token_address);

    TokenMetadata {
        name: token_client.name(),
        symbol: token_client.symbol(),
        decimals: token_client.decimals(),
    }
}

/// Create a `token::Client` for the given token address.
///
/// Convenience helper so that every function that needs to interact with the
/// SAC token does not have to repeat the client construction.
#[inline]
pub fn sac_client<'a>(env: &Env, token_address: &Address) -> token::Client<'a> {
    token::Client::new(env, token_address)
}

/// Query the token balance of a given address.
///
/// Delegates directly to the SAC `balance(id: Address) -> i128` function.
#[inline]
pub fn sac_balance(env: &Env, token_address: &Address, id: &Address) -> i128 {
    sac_client(env, token_address).balance(id)
}

/// Query the allowance `from` has granted to `spender`.
///
/// Delegates directly to the SAC `allowance(from, spender) -> i128` function.
#[inline]
pub fn sac_allowance(
    env: &Env,
    token_address: &Address,
    from: &Address,
    spender: &Address,
) -> i128 {
    sac_client(env, token_address).allowance(from, spender)
}

/// Approve `spender` to transfer up to `amount` tokens from `from`.
///
/// Delegates directly to the SAC `approve(from, spender, amount, expiration_ledger)` function.
/// This is required for AMM compatibility — AMM routers call `approve` on the
/// token before executing swaps.
#[inline]
pub fn sac_approve(
    env: &Env,
    token_address: &Address,
    from: &Address,
    spender: &Address,
    amount: i128,
    expiration_ledger: u32,
) {
    sac_client(env, token_address).approve(from, spender, &amount, &expiration_ledger);
}

/// Transfer `amount` tokens from `from` to `to`.
///
/// Delegates directly to the SAC `transfer(from, to, amount)` function.
/// This is the primary function used by the PayoutRegistry for funding and claiming.
#[inline]
pub fn sac_transfer(
    env: &Env,
    token_address: &Address,
    from: &Address,
    to: &Address,
    amount: &i128,
) {
    sac_client(env, token_address).transfer(from, to, amount);
}

/// Transfer `amount` tokens from `from` to `to` using the `spender`'s allowance.
///
/// Delegates directly to the SAC `transfer_from(spender, from, to, amount)` function.
/// This is required for AMM compatibility — AMM routers use this to move tokens
/// on behalf of users who have approved an allowance.
#[inline]
pub fn sac_transfer_from(
    env: &Env,
    token_address: &Address,
    spender: &Address,
    from: &Address,
    to: &Address,
    amount: &i128,
) {
    sac_client(env, token_address).transfer_from(spender, from, to, amount);
}

/// Mint new tokens to the specified `to` address.
///
/// Delegates to the SAC admin `mint(to, amount)` function. This requires the
/// caller to be the token administrator. In our contract, this is gated behind
/// multisig authorization.
///
/// # Safety
/// Minting inflates the token supply and should only be callable by protocol
/// admins who have passed the multisig threshold.
#[inline]
pub fn sac_mint(
    env: &Env,
    token_address: &Address,
    to: &Address,
    amount: &i128,
) {
    let sac_admin = token::StellarAssetClient::new(env, token_address);
    sac_admin.mint(to, amount);
}

/// Burn tokens from the specified `from` address.
///
/// Delegates to the SAC admin `burn(from, amount)` function. This requires the
/// caller to be the token administrator.
#[inline]
pub fn sac_burn(
    env: &Env,
    token_address: &Address,
    from: &Address,
    amount: &i128,
) {
    let sac_admin = token::StellarAssetClient::new(env, token_address);
    sac_admin.clawback(from, amount);
}

/// Set the administrator of the SAC token.
///
/// Delegates to the SAC admin `set_admin(new_admin)` function.
#[inline]
pub fn sac_set_admin(
    env: &Env,
    token_address: &Address,
    new_admin: &Address,
) {
    let sac_admin = token::StellarAssetClient::new(env, token_address);
    sac_admin.set_admin(new_admin);
}

/// Clawback tokens from the specified `from` address.
///
/// Delegates to the SAC admin `clawback(from, amount)` function. This is useful
/// for regulatory compliance or recovering mistakenly sent tokens.
#[inline]
pub fn sac_clawback(
    env: &Env,
    token_address: &Address,
    from: &Address,
    amount: &i128,
) {
    let sac_admin = token::StellarAssetClient::new(env, token_address);
    sac_admin.clawback(from, amount);
}

/// Flash Loan Module — Test Suite
///
/// Covers all three acceptance criteria from issue #480:
///   1. Flash loans execute successfully for compliant arbitrage contracts.
///   2. Non-compliant or malicious callbacks result in complete state reversion.
///   3. Flash loan fees are securely credited to the fractional asset holders.
#[cfg(test)]
mod flash_loan_tests {
    use crate::{PayoutRegistry, PayoutRegistryClient, PrinceError};
    use soroban_sdk::testutils::Address as _;
    use soroban_sdk::{token, Address, Env, Symbol, Val, Vec};

    // ─────────────────────────────────────────────────────────────────────────
    // Helper: standard test setup
    // ─────────────────────────────────────────────────────────────────────────

    struct Setup {
        env: Env,
        client: PayoutRegistryClient<'static>,
        token_id: Address,
        protocol_admin: Address,
    }

    fn setup() -> Setup {
        let env = Env::default();
        env.mock_all_auths();

        let token_admin = Address::generate(&env);
        let token_contract = env.register_stellar_asset_contract_v2(token_admin.clone());
        let token_id = token_contract.address();

        let contract_id = env.register(PayoutRegistry, ());
        let client = PayoutRegistryClient::new(&env, &contract_id);

        let protocol_admin = Address::generate(&env);
        let mut admins = Vec::new(&env);
        admins.push_back(protocol_admin.clone());
        client.init(&token_id, &admins, &1);

        Setup {
            env,
            client,
            token_id,
            protocol_admin,
        }
    }

    /// Seed the registry contract with `liquidity` tokens so flash loans have
    /// funds to disburse. We use `fund_org` against a dummy org to do this
    /// cleanly through the contract's own accounting path.
    fn seed_contract_liquidity(setup: &Setup, liquidity: i128) {
        let Setup {
            env,
            client,
            token_id,
            ..
        } = setup;

        // Register a dummy org used only for seeding liquidity.
        let org_id = Symbol::new(env, "seedorg");
        let seed_admin = Address::generate(env);
        client.register_org(&org_id, &soroban_sdk::String::from_str(env, "Seed Org"), &seed_admin);

        // Mint tokens to a funder then deposit into the org budget (which holds
        // tokens in the contract address).
        let funder = Address::generate(env);
        let sac = token::StellarAssetClient::new(env, token_id);
        sac.mint(&funder, &liquidity);
        client.fund_org(&org_id, &funder, &liquidity);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Compliant borrower contract — repays principal + fee immediately.
    // Isolated in its own sub-module so the `#[contractimpl]` macro symbols
    // (e.g. `__execute_flash_loan`) do not collide with the other borrowers.
    // ─────────────────────────────────────────────────────────────────────────
    mod compliant {
        use soroban_sdk::{contract, contractimpl, token, Address, Env, Symbol, Val, Vec};

        /// A minimal compliant borrower: on `execute_flash_loan` it transfers
        /// `amount + fee` back to the registry contract.
        #[contract]
        pub struct CompliantBorrower;

        #[contractimpl]
        impl CompliantBorrower {
            /// Called by the registry during a flash loan.
            ///
            /// Simulates profitable arbitrage by receiving extra "profit" tokens
            /// minted externally during the test, then repaying principal + fee.
            pub fn execute_flash_loan(env: Env, amount: i128, fee: i128, _data: Vec<Val>) {
                let registry_id: Address = env
                    .storage()
                    .persistent()
                    .get(&Symbol::new(&env, "registry"))
                    .unwrap();
                let token_id: Address = env
                    .storage()
                    .persistent()
                    .get(&Symbol::new(&env, "token"))
                    .unwrap();

                let repayment = amount
                    .checked_add(fee)
                    .expect("repayment overflow");
                token::Client::new(&env, &token_id).transfer(
                    &env.current_contract_address(),
                    &registry_id,
                    &repayment,
                );
            }

            /// Store the registry and token addresses so the callback can use them.
            pub fn setup(env: Env, registry: Address, token: Address) {
                env.storage()
                    .persistent()
                    .set(&Symbol::new(&env, "registry"), &registry);
                env.storage()
                    .persistent()
                    .set(&Symbol::new(&env, "token"), &token);
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Non-compliant borrower contract — repays nothing (malicious).
    // Isolated in its own sub-module for the same reason as above.
    // ─────────────────────────────────────────────────────────────────────────
    mod malicious {
        use soroban_sdk::{contract, contractimpl, Env, Val, Vec};

        #[contract]
        pub struct MaliciousBorrower;

        #[contractimpl]
        impl MaliciousBorrower {
            /// Receives the flash loan but deliberately refuses to repay.
            pub fn execute_flash_loan(_env: Env, _amount: i128, _fee: i128, _data: Vec<Val>) {
                // Intentionally does nothing — the invariant check in the registry
                // must catch this and revert the entire transaction.
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Partial-repayment borrower — returns only the principal, skips the fee.
    // ─────────────────────────────────────────────────────────────────────────
    mod partial {
        use soroban_sdk::{contract, contractimpl, token, Address, Env, Symbol, Val, Vec};

        #[contract]
        pub struct PartialBorrower;

        #[contractimpl]
        impl PartialBorrower {
            pub fn execute_flash_loan(env: Env, amount: i128, _fee: i128, _data: Vec<Val>) {
                // Returns only the principal, withholds the fee.
                let registry_id: Address = env
                    .storage()
                    .persistent()
                    .get(&Symbol::new(&env, "registry"))
                    .unwrap();
                let token_id: Address = env
                    .storage()
                    .persistent()
                    .get(&Symbol::new(&env, "token"))
                    .unwrap();

                token::Client::new(&env, &token_id).transfer(
                    &env.current_contract_address(),
                    &registry_id,
                    &amount, // fee deliberately omitted
                );
            }

            pub fn setup(env: Env, registry: Address, token: Address) {
                env.storage()
                    .persistent()
                    .set(&Symbol::new(&env, "registry"), &registry);
                env.storage()
                    .persistent()
                    .set(&Symbol::new(&env, "token"), &token);
            }
        }
    }

    // Re-export clients generated by the macros so tests can reference them.
    use compliant::{CompliantBorrower, CompliantBorrowerClient};
    use malicious::{MaliciousBorrower, MaliciousBorrowerClient};
    use partial::{PartialBorrower, PartialBorrowerClient};

    // ─────────────────────────────────────────────────────────────────────────
    // AC1: Compliant flash loan executes successfully
    // ─────────────────────────────────────────────────────────────────────────

    #[test]
    fn test_flash_loan_compliant_borrower_succeeds() {
        let setup = setup();
        let Setup {
            ref env,
            ref client,
            ref token_id,
            ..
        } = setup;

        let liquidity: i128 = 1_000_000_000; // 1,000 tokens in stroops
        seed_contract_liquidity(&setup, liquidity);

        // Deploy compliant borrower
        let borrower_id = env.register(CompliantBorrower, ());
        let borrower_client = CompliantBorrowerClient::new(env, &borrower_id);
        borrower_client.setup(&client.address, token_id);

        // Mint extra tokens to the borrower so it can pay the fee.
        // (Simulates profit from arbitrage.)
        let loan_amount: i128 = 500_000_000;
        let fee_bps: i128 = 30;
        // ceil(500_000_000 * 30 / 10_000) = 1_500_000
        let expected_fee = (loan_amount * fee_bps + 9_999) / 10_000;
        let sac = token::StellarAssetClient::new(env, token_id);
        // Give the borrower extra tokens equal to the fee (simulates profit).
        sac.mint(&borrower_id, &expected_fee);

        let contract_balance_before: i128 =
            token::Client::new(env, token_id).balance(&client.address);

        // Execute flash loan
        let data: Vec<Val> = Vec::new(env);
        client.flash_loan(&borrower_id, &loan_amount, &data);

        let contract_balance_after: i128 =
            token::Client::new(env, token_id).balance(&client.address);

        // Contract balance must have grown by exactly the fee.
        assert_eq!(
            contract_balance_after,
            contract_balance_before + expected_fee,
            "contract balance should increase by the flash loan fee"
        );

        // Borrower should have zero tokens left (repaid principal + fee).
        assert_eq!(
            token::Client::new(env, token_id).balance(&borrower_id),
            0,
            "compliant borrower should have repaid everything"
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // AC2a: Malicious borrower (no repayment) is rejected with full reversion
    // ─────────────────────────────────────────────────────────────────────────

    #[test]
    fn test_flash_loan_malicious_borrower_reverts() {
        let setup = setup();
        let Setup {
            ref env,
            ref client,
            ref token_id,
            ..
        } = setup;

        let liquidity: i128 = 1_000_000_000;
        seed_contract_liquidity(&setup, liquidity);

        let malicious_id = env.register(MaliciousBorrower, ());
        // MaliciousBorrower has no `setup` fn — it just ignores the repayment.
        let _ = MaliciousBorrowerClient::new(env, &malicious_id);

        let contract_balance_before: i128 =
            token::Client::new(env, token_id).balance(&client.address);

        let data: Vec<Val> = Vec::new(env);
        let result = client.try_flash_loan(&malicious_id, &500_000_000_i128, &data);

        // Must fail with FlashLoanRepaymentFailed
        assert!(result.is_err(), "malicious borrower must be rejected");

        // Because Soroban transactions are atomic, the contract balance must be
        // unchanged after the failed call.
        let contract_balance_after: i128 =
            token::Client::new(env, token_id).balance(&client.address);
        assert_eq!(
            contract_balance_after, contract_balance_before,
            "contract balance must be unchanged after a failed flash loan"
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // AC2b: Partial repayment (principal only, no fee) is rejected
    // ─────────────────────────────────────────────────────────────────────────

    #[test]
    fn test_flash_loan_partial_repayment_reverts() {
        let setup = setup();
        let Setup {
            ref env,
            ref client,
            ref token_id,
            ..
        } = setup;

        let liquidity: i128 = 1_000_000_000;
        seed_contract_liquidity(&setup, liquidity);

        let borrower_id = env.register(PartialBorrower, ());
        let partial_client = PartialBorrowerClient::new(env, &borrower_id);
        partial_client.setup(&client.address, token_id);

        // Mint principal back to the borrower but NOT the fee.
        let loan_amount: i128 = 500_000_000;
        let sac = token::StellarAssetClient::new(env, token_id);
        sac.mint(&borrower_id, &loan_amount);

        let data: Vec<Val> = Vec::new(env);
        let result = client.try_flash_loan(&borrower_id, &loan_amount, &data);
        assert!(
            result.is_err(),
            "partial repayment (no fee) must be rejected"
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // AC3: Fee is credited to the vault (net balance increases by fee)
    // ─────────────────────────────────────────────────────────────────────────

    #[test]
    fn test_flash_loan_fee_credited_to_vault() {
        let setup = setup();
        let Setup {
            ref env,
            ref client,
            ref token_id,
            ..
        } = setup;

        let liquidity: i128 = 2_000_000_000;
        seed_contract_liquidity(&setup, liquidity);

        let borrower_id = env.register(CompliantBorrower, ());
        let borrower_client = CompliantBorrowerClient::new(env, &borrower_id);
        borrower_client.setup(&client.address, token_id);

        let loan_amount: i128 = 1_000_000_000;
        let fee_bps: i128 = 30;
        let expected_fee = (loan_amount * fee_bps + 9_999) / 10_000;

        // Give borrower enough to cover the fee (simulates arbitrage profit).
        let sac = token::StellarAssetClient::new(env, token_id);
        sac.mint(&borrower_id, &expected_fee);

        let before = token::Client::new(env, token_id).balance(&client.address);

        let data: Vec<Val> = Vec::new(env);
        client.flash_loan(&borrower_id, &loan_amount, &data);

        let after = token::Client::new(env, token_id).balance(&client.address);

        assert_eq!(
            after - before,
            expected_fee,
            "vault balance should grow by exactly the flash loan fee"
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Edge: Borrow more than available liquidity
    // ─────────────────────────────────────────────────────────────────────────

    #[test]
    fn test_flash_loan_insufficient_liquidity_rejected() {
        let setup = setup();
        let Setup {
            ref env,
            ref client,
            ..
        } = setup;

        let liquidity: i128 = 100_000;
        seed_contract_liquidity(&setup, liquidity);

        let borrower_id = Address::generate(env);
        let data: Vec<Val> = Vec::new(env);
        // Request more than the vault holds.
        let result = client.try_flash_loan(&borrower_id, &(liquidity + 1), &data);
        assert!(
            result.is_err(),
            "borrowing more than liquidity must be rejected"
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Edge: Invalid amount (zero)
    // ─────────────────────────────────────────────────────────────────────────

    #[test]
    fn test_flash_loan_zero_amount_rejected() {
        let setup = setup();
        let Setup {
            ref env,
            ref client,
            ..
        } = setup;

        let borrower_id = Address::generate(env);
        let data: Vec<Val> = Vec::new(env);
        let result = client.try_flash_loan(&borrower_id, &0_i128, &data);
        assert!(result.is_err(), "zero-amount flash loan must be rejected");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Admin: set_flash_loan_fee only callable by protocol admin
    // ─────────────────────────────────────────────────────────────────────────

    #[test]
    fn test_set_flash_loan_fee_authorized() {
        let setup = setup();
        let Setup {
            ref client,
            ref protocol_admin,
            ..
        } = setup;

        // Default fee should be 30 bps.
        assert_eq!(client.get_flash_loan_fee(), 30u32);

        // Protocol admin sets it to 50 bps.
        client.set_flash_loan_fee(protocol_admin, &50u32);
        assert_eq!(client.get_flash_loan_fee(), 50u32);
    }

    #[test]
    fn test_set_flash_loan_fee_unauthorized_rejected() {
        let setup = setup();
        let Setup {
            ref env,
            ref client,
            ..
        } = setup;

        let attacker = Address::generate(env);
        let result = client.try_set_flash_loan_fee(&attacker, &50u32);
        assert!(result.is_err(), "non-admin must not set flash loan fee");
    }

    #[test]
    fn test_set_flash_loan_fee_zero_rejected() {
        let setup = setup();
        let Setup {
            ref client,
            ref protocol_admin,
            ..
        } = setup;

        let result = client.try_set_flash_loan_fee(protocol_admin, &0u32);
        assert!(result.is_err(), "zero fee must be rejected");
    }

    #[test]
    fn test_set_flash_loan_fee_above_max_rejected() {
        let setup = setup();
        let Setup {
            ref client,
            ref protocol_admin,
            ..
        } = setup;

        // 1001 bps > 10% cap
        let result = client.try_set_flash_loan_fee(protocol_admin, &1001u32);
        assert!(result.is_err(), "fee > 1000 bps must be rejected");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Boundary: custom fee correctly applied
    // ─────────────────────────────────────────────────────────────────────────

    #[test]
    fn test_flash_loan_custom_fee_applied() {
        let setup = setup();
        let Setup {
            ref env,
            ref client,
            ref token_id,
            ref protocol_admin,
            ..
        } = setup;

        // Set fee to 100 bps (1%)
        client.set_flash_loan_fee(protocol_admin, &100u32);

        let liquidity: i128 = 1_000_000_000;
        seed_contract_liquidity(&setup, liquidity);

        let borrower_id = env.register(CompliantBorrower, ());
        let borrower_client = CompliantBorrowerClient::new(env, &borrower_id);
        borrower_client.setup(&client.address, token_id);

        let loan_amount: i128 = 1_000_000_000;
        // fee = ceil(1_000_000_000 * 100 / 10_000) = 10_000_000
        let expected_fee = (loan_amount * 100 + 9_999) / 10_000;

        let sac = token::StellarAssetClient::new(env, token_id);
        sac.mint(&borrower_id, &expected_fee);

        let before = token::Client::new(env, token_id).balance(&client.address);

        let data: Vec<Val> = Vec::new(env);
        client.flash_loan(&borrower_id, &loan_amount, &data);

        let after = token::Client::new(env, token_id).balance(&client.address);
        assert_eq!(after - before, expected_fee, "1% fee must be applied");
    }
}

#[allow(clippy::module_inception)]
#[cfg(test)]
mod tests {
    use crate::{PayoutParams, PayoutRegistry, PayoutRegistryClient};
    use soroban_sdk::testutils::{Address as _, Ledger as _};
    use soroban_sdk::{contract, contractimpl, symbol_short, token, Address, Env, IntoVal, String, Symbol, Vec};

    // ── Test Helpers ─────────────────────────────────────────────────────────

    struct Setup {
        env: Env,
        client: PayoutRegistryClient<'static>,
        #[allow(dead_code)]
        protocol_admin: Address,
        #[allow(dead_code)]
        token_admin: Address,
        token: token::StellarAssetClient<'static>,
    }

    fn setup() -> Setup {
        let env = Env::default();
        env.mock_all_auths();

        let token_admin = Address::generate(&env);
        let token_contract_id = env.register_stellar_asset_contract_v2(token_admin.clone());
        let token_client = token::StellarAssetClient::new(&env, &token_contract_id.address());

        let contract_id = env.register_contract(None, PayoutRegistry);
        let client = PayoutRegistryClient::new(&env, &contract_id);

        // Native multisig policy belongs to this address, not to signer payloads.
        let protocol_admin = Address::generate(&env);
        let mut admins = Vec::new(&env);
        admins.push_back(protocol_admin.clone());

        client.init(&token_contract_id.address(), &admins, &1);

        Setup {
            env,
            client,
            protocol_admin,
            token_admin,
            token: token_client,
        }
    }

    fn register_test_org(env: &Env, client: &PayoutRegistryClient<'_>, org_sym: Symbol) -> Address {
        let admin = Address::generate(env);
        client.register_org(
            &org_sym,
            &String::from_str(env, "Test Organization"),
            &admin,
        );
        admin
    }

    // ── Existing Tests ────────────────────────────────────────────────────────

    #[test]
    fn test_init() {
        let Setup { env, client, .. } = setup();
        let additional_token = Address::generate(&env);
        let mut admins = Vec::new(&env);
        admins.push_back(Address::generate(&env));
        let result = client.try_init(&additional_token, &admins, &1);
        assert!(result.is_err());
    }

    #[test]
    fn test_init_rejects_legacy_contract_side_multisig_config() {
        let env = Env::default();
        let token_admin = Address::generate(&env);
        let token_contract_id = env.register_stellar_asset_contract_v2(token_admin.clone());

        let contract_id = env.register_contract(None, PayoutRegistry);
        let client = PayoutRegistryClient::new(&env, &contract_id);

        let mut admins = Vec::new(&env);
        admins.push_back(Address::generate(&env));
        admins.push_back(Address::generate(&env));

        let result = client.try_init(&token_contract_id.address(), &admins, &2);
        assert!(result.is_err());
    }

    #[test]
    fn test_register_and_get_org() {
        let Setup { env, client, .. } = setup();
        let org_sym = symbol_short!("myorg");
        let admin = register_test_org(&env, &client, org_sym.clone());

        let org = client.get_org(&org_sym);
        assert_eq!(org.id, org_sym);
        assert_eq!(org.admins.get(0).unwrap(), admin);
        assert_eq!(client.get_org_budget(&org_sym), 0);
    }

    #[test]
    fn test_fund_org() {
        let Setup {
            env, client, token, ..
        } = setup();
        let org_sym = symbol_short!("myorg");
        register_test_org(&env, &client, org_sym.clone());

        let donor = Address::generate(&env);
        let token_client = token::Client::new(&env, &token.address);

        token.mint(&donor, &100_000_000);
        assert_eq!(token_client.balance(&donor), 100_000_000);

        client.fund_org(&org_sym, &donor, &50_000_000);

        assert_eq!(client.get_org_budget(&org_sym), 50_000_000);
        assert_eq!(token_client.balance(&client.address), 50_000_000);
        assert_eq!(token_client.balance(&donor), 50_000_000);
    }

    #[test]
    fn test_fund_org_exceeds_limit_fails() {
        let Setup {
            env, client, token, ..
        } = setup();
        let org_sym = symbol_short!("myorg");
        register_test_org(&env, &client, org_sym.clone());

        let donor = Address::generate(&env);
        token.mint(&donor, &20_000_000_000_000_000_000);
        
        let result = client.try_fund_org(&org_sym, &donor, &10_000_000_000_000_000_001_i128);
        assert!(result.is_err());
        // also ensure negative amount is rejected
        let neg_result = client.try_fund_org(&org_sym, &donor, -10_i128);
        assert!(neg_result.is_err());
    }

    #[test]
    fn test_allocate_exceeds_limit_fails() {
        let Setup { env, client, .. } = setup();
        let org_sym = symbol_short!("myorg");
        let admin = register_test_org(&env, &client, org_sym.clone());

        let maintainer = Address::generate(&env);
        client.add_maintainer(&org_sym, &maintainer);

        let result = client.try_allocate_payout(
            &org_sym,
            &admin,
            &maintainer,
            &10_000_000_000_000_000_001_i128,
            &0_u64,
        );
        assert!(result.is_err());
    }

    #[test]
    fn test_allocate_without_budget_panics() {
        let Setup { env, client, .. } = setup();
        let org_sym = symbol_short!("myorg");
        let admin = register_test_org(&env, &client, org_sym.clone());

        let maintainer = Address::generate(&env);
        client.add_maintainer(&org_sym, &maintainer);

        let result = client.try_allocate_payout(
            &org_sym,
            &admin,
            &maintainer,
            &5_000_000_i128,
            &1234567890_u64,
        );
        assert!(result.is_err());
    }

    #[test]
    fn test_allocate_and_claim_with_tokens() {
        let Setup {
            env, client, token, ..
        } = setup();
        let org_sym = symbol_short!("myorg");
        let admin = register_test_org(&env, &client, org_sym.clone());

        let maintainer = Address::generate(&env);
        client.add_maintainer(&org_sym, &maintainer);

        let donor = Address::generate(&env);
        let token_client = token::Client::new(&env, &token.address);
        token.mint(&donor, &20_000_000);

        client.fund_org(&org_sym, &donor, &20_000_000);

        client.allocate_payout(&org_sym, &admin, &maintainer, &5_000_000_i128, &0_u64);
        assert_eq!(client.get_claimable_balance(&maintainer), 5_000_000);
        assert_eq!(client.get_org_budget(&org_sym), 15_000_000);

        assert_eq!(token_client.balance(&maintainer), 0);
        let claimed = client.claim_payout(&maintainer);
        assert_eq!(claimed, 5_000_000);

        assert_eq!(client.get_claimable_balance(&maintainer), 0);
        assert_eq!(token_client.balance(&maintainer), 5_000_000);
        assert_eq!(token_client.balance(&client.address), 15_000_000);
    }

    // ── Batch Allocate Tests ──────────────────────────────────────────────────

    #[test]
    fn test_batch_allocate_basic() {
        let Setup {
            env, client, token, ..
        } = setup();
        let org_sym = symbol_short!("batchorg");
        let admin = register_test_org(&env, &client, org_sym.clone());

        let m1 = Address::generate(&env);
        let m2 = Address::generate(&env);
        let m3 = Address::generate(&env);

        client.add_maintainer(&org_sym, &m1);
        client.add_maintainer(&org_sym, &m2);
        client.add_maintainer(&org_sym, &m3);

        let donor = Address::generate(&env);
        token.mint(&donor, &100_000_000);
        client.fund_org(&org_sym, &donor, &100_000_000);

        let mut payouts = Vec::new(&env);
        payouts.push_back(PayoutParams {
            maintainer: m1.clone(),
            amount: 10_000_000,
        });
        payouts.push_back(PayoutParams {
            maintainer: m2.clone(),
            amount: 20_000_000,
        });
        payouts.push_back(PayoutParams {
            maintainer: m3.clone(),
            amount: 30_000_000,
        });

        client.batch_allocate(&admin, &org_sym, &payouts);

        assert_eq!(client.get_claimable_balance(&m1), 10_000_000);
        assert_eq!(client.get_claimable_balance(&m2), 20_000_000);
        assert_eq!(client.get_claimable_balance(&m3), 30_000_000);
        assert_eq!(client.get_org_budget(&org_sym), 40_000_000); // 100M - 60M
    }

    #[test]
    fn test_batch_allocate_deducts_budget_atomically() {
        let Setup {
            env, client, token, ..
        } = setup();
        let org_sym = symbol_short!("atomorg");
        let admin = register_test_org(&env, &client, org_sym.clone());

        let m1 = Address::generate(&env);
        let m2 = Address::generate(&env);
        client.add_maintainer(&org_sym, &m1);
        client.add_maintainer(&org_sym, &m2);

        let donor = Address::generate(&env);
        token.mint(&donor, &50_000_000);
        client.fund_org(&org_sym, &donor, &50_000_000);

        let mut payouts = Vec::new(&env);
        payouts.push_back(PayoutParams {
            maintainer: m1.clone(),
            amount: 25_000_000,
        });
        payouts.push_back(PayoutParams {
            maintainer: m2.clone(),
            amount: 25_000_000,
        });

        client.batch_allocate(&admin, &org_sym, &payouts);

        assert_eq!(client.get_org_budget(&org_sym), 0);
        assert_eq!(client.get_claimable_balance(&m1), 25_000_000);
        assert_eq!(client.get_claimable_balance(&m2), 25_000_000);
    }

    #[test]
    fn test_batch_allocate_insufficient_budget_fails() {
        let Setup {
            env, client, token, ..
        } = setup();
        let org_sym = symbol_short!("poororg");
        let admin = register_test_org(&env, &client, org_sym.clone());

        let m1 = Address::generate(&env);
        client.add_maintainer(&org_sym, &m1);

        let donor = Address::generate(&env);
        token.mint(&donor, &5_000_000);
        client.fund_org(&org_sym, &donor, &5_000_000);

        let mut payouts = Vec::new(&env);
        payouts.push_back(PayoutParams {
            maintainer: m1.clone(),
            amount: 10_000_000,
        });

        let result = client.try_batch_allocate(&admin, &org_sym, &payouts);
        assert!(result.is_err());

        // Budget must remain untouched on failure
        assert_eq!(client.get_org_budget(&org_sym), 5_000_000);
    }

    #[test]
    fn test_batch_allocate_wrong_admin_fails() {
        let Setup {
            env, client, token, ..
        } = setup();
        let org_sym = symbol_short!("secorg");
        register_test_org(&env, &client, org_sym.clone());

        let m1 = Address::generate(&env);
        client.add_maintainer(&org_sym, &m1);

        let donor = Address::generate(&env);
        token.mint(&donor, &20_000_000);
        client.fund_org(&org_sym, &donor, &20_000_000);

        let impostor = Address::generate(&env);
        let mut payouts = Vec::new(&env);
        payouts.push_back(PayoutParams {
            maintainer: m1.clone(),
            amount: 5_000_000,
        });

        let result = client.try_batch_allocate(&impostor, &org_sym, &payouts);
        assert!(result.is_err());
    }

    #[test]
    fn test_batch_allocate_maintainer_wrong_org_fails() {
        let Setup {
            env, client, token, ..
        } = setup();
        let org_a = symbol_short!("orga");
        let org_b = symbol_short!("orgb");

        let admin_a = register_test_org(&env, &client, org_a.clone());
        register_test_org(&env, &client, org_b.clone());

        // Register maintainer under org_b
        let m1 = Address::generate(&env);
        client.add_maintainer(&org_b, &m1);

        let donor = Address::generate(&env);
        token.mint(&donor, &20_000_000);
        client.fund_org(&org_a, &donor, &20_000_000);

        // Try to batch allocate org_a funds to a maintainer from org_b
        let mut payouts = Vec::new(&env);
        payouts.push_back(PayoutParams {
            maintainer: m1.clone(),
            amount: 5_000_000,
        });

        let result = client.try_batch_allocate(&admin_a, &org_a, &payouts);
        assert!(result.is_err());
    }

    #[test]
    fn test_batch_allocate_zero_amount_fails() {
        let Setup { env, client, .. } = setup();
        let org_sym = symbol_short!("zeroorg");
        let admin = register_test_org(&env, &client, org_sym.clone());

        let m1 = Address::generate(&env);
        client.add_maintainer(&org_sym, &m1);

        let mut payouts = Vec::new(&env);
        payouts.push_back(PayoutParams {
            maintainer: m1.clone(),
            amount: 0,
        });

        let result = client.try_batch_allocate(&admin, &org_sym, &payouts);
        assert!(result.is_err());
    }

    #[test]
    fn test_batch_allocate_empty_list_fails() {
        let Setup { env, client, .. } = setup();
        let org_sym = symbol_short!("emptyorg");
        let admin = register_test_org(&env, &client, org_sym.clone());

        let payouts: Vec<PayoutParams> = Vec::new(&env);
        let result = client.try_batch_allocate(&admin, &org_sym, &payouts);
        assert!(result.is_err());
    }

    #[test]
    fn test_batch_allocate_then_claim() {
        let Setup {
            env, client, token, ..
        } = setup();
        let org_sym = symbol_short!("claimorg");
        let admin = register_test_org(&env, &client, org_sym.clone());

        let m1 = Address::generate(&env);
        client.add_maintainer(&org_sym, &m1);

        let donor = Address::generate(&env);
        let token_client = token::Client::new(&env, &token.address);
        token.mint(&donor, &30_000_000);
        client.fund_org(&org_sym, &donor, &30_000_000);

        let mut payouts = Vec::new(&env);
        payouts.push_back(PayoutParams {
            maintainer: m1.clone(),
            amount: 12_000_000,
        });
        client.batch_allocate(&admin, &org_sym, &payouts);

        assert_eq!(client.get_claimable_balance(&m1), 12_000_000);

        let claimed = client.claim_payout(&m1);
        assert_eq!(claimed, 12_000_000);
        assert_eq!(token_client.balance(&m1), 12_000_000);
        assert_eq!(client.get_claimable_balance(&m1), 0);
        assert_eq!(client.get_org_budget(&org_sym), 18_000_000);
    }

    #[test]
    fn test_add_remove_admin() {
        let Setup { env, client, .. } = setup();
        let org_sym = symbol_short!("adminorg");
        let admin1 = register_test_org(&env, &client, org_sym.clone());
        let admin2 = Address::generate(&env);

        // Add admin2
        client.add_admin(&org_sym, &admin1, &admin2);
        let org = client.get_org(&org_sym);
        assert_eq!(org.admins.len(), 2);
        assert!(org.admins.contains(&admin2));

        // Remove admin1
        client.remove_admin(&org_sym, &admin2, &admin1);
        let org = client.get_org(&org_sym);
        assert_eq!(org.admins.len(), 1);
        assert_eq!(org.admins.get(0).unwrap(), admin2);

        // Cannot remove the last admin
        let result = client.try_remove_admin(&org_sym, &admin2, &admin2);
        assert!(result.is_err());
    }

    #[test]
    fn test_max_admin_limit() {
        let Setup { env, client, .. } = setup();
        let org_sym = symbol_short!("maxorg");
        let admin = register_test_org(&env, &client, org_sym.clone());

        for _ in 0..9 {
            client.add_admin(&org_sym, &admin, &Address::generate(&env));
        }

        let result = client.try_add_admin(&org_sym, &admin, &Address::generate(&env));
        assert!(result.is_err()); // Limit is 10
    }

    // ── Native Protocol Admin Auth Tests ───────────────────────────────────────

    #[test]
    fn test_protocol_admin_native_auth_controls_state_mutations() {
        let env = Env::default();
        let token_admin = Address::generate(&env);
        let token_contract_id = env.register_stellar_asset_contract_v2(token_admin.clone());
        let _token_client = token::StellarAssetClient::new(&env, &token_contract_id.address());

        let contract_id = env.register_contract(None, PayoutRegistry);
        let client = PayoutRegistryClient::new(&env, &contract_id);

        let protocol_admin = Address::generate(&env);
        let mut admins = Vec::new(&env);
        admins.push_back(protocol_admin.clone());

        client.init(&token_contract_id.address(), &admins, &1);

        // Verify native protocol admin configuration.
        let multisig_admin = client.get_multisig_admin();
        assert_eq!(multisig_admin.admins.len(), 1);
        assert_eq!(multisig_admin.admins.get(0).unwrap(), protocol_admin);
        assert_eq!(multisig_admin.threshold, 1);

        let hash_bytes = [
            0xe3, 0xb0, 0xc4, 0x42, 0x98, 0xfc, 0x1c, 0x14, 0x9a, 0xfb, 0xf4, 0xc8, 0x99, 0x6f,
            0xb9, 0x24, 0x27, 0xae, 0x41, 0xe4, 0x64, 0x9b, 0x93, 0x4c, 0xa4, 0x95, 0x99, 0x1b,
            0x78, 0x52, 0xb8, 0x55_u8,
        ];
        let new_wasm_hash = soroban_sdk::BytesN::from_array(&env, &hash_bytes);

        // Missing native admin auth must fail before mutating protocol state.
        let result = client.try_pause_protocol();
        assert!(result.is_err());
        assert_eq!(client.get_protocol_state(), crate::ProtocolState::Active);

        let outsider = Address::generate(&env);
        env.mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &outsider,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &contract_id,
                fn_name: "pause_protocol",
                args: ().into_val(&env),
                sub_invokes: &[],
            },
        }]);

        let result = client.try_pause_protocol();
        assert!(result.is_err());
        assert_eq!(client.get_protocol_state(), crate::ProtocolState::Active);

        env.mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &protocol_admin,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &contract_id,
                fn_name: "pause_protocol",
                args: ().into_val(&env),
                sub_invokes: &[],
            },
        }]);

        let result = client.try_pause_protocol();
        assert!(result.is_ok());
        assert_eq!(client.get_protocol_state(), crate::ProtocolState::Paused);

        env.mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &protocol_admin,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &contract_id,
                fn_name: "unpause_protocol",
                args: ().into_val(&env),
                sub_invokes: &[],
            },
        }]);

        let result = client.try_unpause_protocol();
        assert!(result.is_ok());
        assert_eq!(client.get_protocol_state(), crate::ProtocolState::Active);

        let new_admin = Address::generate(&env);
        env.mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &protocol_admin,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &contract_id,
                fn_name: "propose_admin",
                args: (new_admin.clone(),).into_val(&env),
                sub_invokes: &[],
            },
        }]);

        let result = client.try_propose_admin(&new_admin);
        assert!(result.is_ok());

        env.mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &new_admin,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &contract_id,
                fn_name: "accept_admin",
                args: (new_admin.clone(),).into_val(&env),
                sub_invokes: &[],
            },
        }]);

        let result = client.try_accept_admin(&new_admin);
        assert!(result.is_ok());
        let multisig_admin = client.get_multisig_admin();
        assert_eq!(multisig_admin.admins.len(), 1);
        assert_eq!(multisig_admin.admins.get(0).unwrap(), new_admin);
        assert_eq!(multisig_admin.threshold, 1);

        env.mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &new_admin,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &contract_id,
                fn_name: "upgrade",
                args: (new_wasm_hash.clone(),).into_val(&env),
                sub_invokes: &[],
            },
        }]);

        let result = client.try_upgrade(&new_wasm_hash);
        assert!(result.is_ok());
    }

    // ── Property-based Fuzz Tests ──────────────────────────────────────────

    proptest::proptest! {
        #![proptest_config(proptest::prelude::ProptestConfig::with_cases(50))]
        
        #[test]
        fn test_fuzz_allocate_and_claim(
            org_budget in 1..1_000_000_i128,
            payout1 in -100..2_000_000_i128,
            payout2 in -100..2_000_000_i128,
            unlock1 in 0..10_000_u64,
            unlock2 in 0..10_000_u64,
            claim_time in 0..20_000_u64,
        ) {
            let env = Env::default();
            env.mock_all_auths();

            let token_admin = Address::generate(&env);
            let token_contract_id = env.register_stellar_asset_contract_v2(token_admin.clone());
            let token_client = token::StellarAssetClient::new(&env, &token_contract_id.address());

            let contract_id = env.register_contract(None, PayoutRegistry);
            let client = PayoutRegistryClient::new(&env, &contract_id);

            let admin1 = Address::generate(&env);
            let mut admins = Vec::new(&env);
            admins.push_back(admin1.clone());
            client.init(&token_contract_id.address(), &admins, &1);

            let org_sym = symbol_short!("fuzzorg");
            let org_admin = Address::generate(&env);
            client.register_org(
                &org_sym,
                &String::from_str(&env, "Fuzz Organization"),
                &org_admin,
            );

            let maintainer1 = Address::generate(&env);
            let maintainer2 = Address::generate(&env);
            client.add_maintainer(&org_sym, &maintainer1);
            client.add_maintainer(&org_sym, &maintainer2);

            let donor = Address::generate(&env);
            token_client.mint(&donor, &org_budget);
            client.fund_org(&org_sym, &donor, &org_budget);

            // Assert budget is updated correctly after funding
            assert_eq!(client.get_org_budget(&org_sym), org_budget);

            // Perform first payout allocation
            let res1 = client.try_allocate_payout(
                &org_sym,
                &org_admin,
                &maintainer1,
                &payout1,
                &unlock1,
            );

            let mut expected_budget = org_budget;
            let mut expected_m1_bal = 0;

            if payout1 <= 0 {
                assert!(res1.is_err());
            } else if payout1 > expected_budget {
                assert!(res1.is_err());
            } else {
                assert!(res1.is_ok());
                expected_budget -= payout1;
                expected_m1_bal = payout1;
                assert_eq!(client.get_org_budget(&org_sym), expected_budget);
                assert_eq!(client.get_claimable_balance(&maintainer1), expected_m1_bal);
            }

            // Perform second payout allocation
            let res2 = client.try_allocate_payout(
                &org_sym,
                &org_admin,
                &maintainer2,
                &payout2,
                &unlock2,
            );

            let mut expected_m2_bal = 0;

            if payout2 <= 0 {
                assert!(res2.is_err());
            } else if payout2 > expected_budget {
                assert!(res2.is_err());
            } else {
                assert!(res2.is_ok());
                expected_budget -= payout2;
                expected_m2_bal = payout2;
                assert_eq!(client.get_org_budget(&org_sym), expected_budget);
                assert_eq!(client.get_claimable_balance(&maintainer2), expected_m2_bal);
            }

            // Validate total remaining budget matches conservation law
            assert_eq!(client.get_org_budget(&org_sym), expected_budget);

            // Claiming tests under randomized claim_time
            env.ledger().set_timestamp(claim_time);

            let token_query = token::Client::new(&env, &token_client.address);

            // Try to claim payout 1
            if expected_m1_bal > 0 {
                let res_claim1 = client.try_claim_payout(&maintainer1);
                if claim_time < unlock1 {
                    assert!(res_claim1.is_err());
                    assert_eq!(client.get_claimable_balance(&maintainer1), expected_m1_bal);
                    assert_eq!(token_query.balance(&maintainer1), 0);
                } else {
                    assert!(res_claim1.is_ok());
                    assert_eq!(client.get_claimable_balance(&maintainer1), 0);
                    assert_eq!(token_query.balance(&maintainer1), expected_m1_bal);
                }
            }

            // Try to claim payout 2
            if expected_m2_bal > 0 {
                let res_claim2 = client.try_claim_payout(&maintainer2);
                if claim_time < unlock2 {
                    assert!(res_claim2.is_err());
                    assert_eq!(client.get_claimable_balance(&maintainer2), expected_m2_bal);
                    assert_eq!(token_query.balance(&maintainer2), 0);
                } else {
                    assert!(res_claim2.is_ok());
                    assert_eq!(client.get_claimable_balance(&maintainer2), 0);
                    assert_eq!(token_query.balance(&maintainer2), expected_m2_bal);
                }
            }
        }

        #[test]
        fn test_fuzz_batch_allocate(
            org_budget in 1..1_000_000_i128,
            payout1 in -100..2_000_000_i128,
            payout2 in -100..2_000_000_i128,
            payout3 in -100..2_000_000_i128,
        ) {
            let env = Env::default();
            env.mock_all_auths();

            let token_admin = Address::generate(&env);
            let token_contract_id = env.register_stellar_asset_contract_v2(token_admin.clone());
            let token_client = token::StellarAssetClient::new(&env, &token_contract_id.address());

            let contract_id = env.register_contract(None, PayoutRegistry);
            let client = PayoutRegistryClient::new(&env, &contract_id);

            let admin1 = Address::generate(&env);
            let mut admins = Vec::new(&env);
            admins.push_back(admin1.clone());
            client.init(&token_contract_id.address(), &admins, &1);

            let org_sym = symbol_short!("batchorg");
            let org_admin = Address::generate(&env);
            client.register_org(
                &org_sym,
                &String::from_str(&env, "Batch Fuzz Org"),
                &org_admin,
            );

            let m1 = Address::generate(&env);
            let m2 = Address::generate(&env);
            let m3 = Address::generate(&env);

            client.add_maintainer(&org_sym, &m1);
            client.add_maintainer(&org_sym, &m2);
            client.add_maintainer(&org_sym, &m3);

            let donor = Address::generate(&env);
            token_client.mint(&donor, &org_budget);
            client.fund_org(&org_sym, &donor, &org_budget);

            let mut payouts = Vec::new(&env);
            payouts.push_back(PayoutParams {
                maintainer: m1.clone(),
                amount: payout1,
            });
            payouts.push_back(PayoutParams {
                maintainer: m2.clone(),
                amount: payout2,
            });
            payouts.push_back(PayoutParams {
                maintainer: m3.clone(),
                amount: payout3,
            });

            let res = client.try_batch_allocate(&org_admin, &org_sym, &payouts);

            let total_payout = payout1.checked_add(payout2).and_then(|sum| sum.checked_add(payout3));
            let has_invalid_amount = payout1 <= 0 || payout2 <= 0 || payout3 <= 0;

            match total_payout {
                None => {
                    // Overflow in sum calculation -> should error
                    assert!(res.is_err());
                    assert_eq!(client.get_org_budget(&org_sym), org_budget);
                }
                Some(total) => {
                    if has_invalid_amount {
                        assert!(res.is_err());
                        // Budget remains untouched
                        assert_eq!(client.get_org_budget(&org_sym), org_budget);
                    } else if total > org_budget {
                        assert!(res.is_err());
                        // Budget remains untouched (atomicity)
                        assert_eq!(client.get_org_budget(&org_sym), org_budget);
                    } else {
                        assert!(res.is_ok());
                        assert_eq!(client.get_org_budget(&org_sym), org_budget - total);
                        assert_eq!(client.get_claimable_balance(&m1), payout1);
                        assert_eq!(client.get_claimable_balance(&m2), payout2);
                        assert_eq!(client.get_claimable_balance(&m3), payout3);
                    }
                }
            }
        }
    }

    #[test]
    fn test_get_token() {
        let Setup { client, token, .. } = setup();
        assert_eq!(client.get_token(), token.address);
    }

    #[test]
    fn test_update_org_metadata() {
        let Setup { env, client, .. } = setup();
        let org_sym = symbol_short!("metaorg");
        let admin = register_test_org(&env, &client, org_sym.clone());

        let metadata_cid = String::from_str(&env, "QmXoypizjW3WknFixtNsQHCgL72vedxjQkDDP1mXWo6uco");
        client.update_org_metadata(&org_sym, &admin, &metadata_cid);

        let org = client.get_org(&org_sym);
        assert_eq!(org.metadata_cid, Some(metadata_cid));
    }

    #[test]
    fn test_update_org_metadata_unauthorized_fails() {
        let Setup { env, client, .. } = setup();
        let org_sym = symbol_short!("metaorg");
        register_test_org(&env, &client, org_sym.clone());

        let impostor = Address::generate(&env);
        let metadata_cid = String::from_str(&env, "QmXoypizjW3WknFixtNsQHCgL72vedxjQkDDP1mXWo6uco");
        let result = client.try_update_org_metadata(&org_sym, &impostor, &metadata_cid);
        assert!(result.is_err());
    }

    #[test]
    fn test_get_maintainer_and_get_maintainers() {
        let Setup { env, client, .. } = setup();
        let org_sym = symbol_short!("maintorg");
        register_test_org(&env, &client, org_sym.clone());

        let m1 = Address::generate(&env);
        let m2 = Address::generate(&env);

        client.add_maintainer(&org_sym, &m1);
        client.add_maintainer(&org_sym, &m2);

        let maintainer_info = client.get_maintainer(&m1);
        assert_eq!(maintainer_info.address, m1);
        assert_eq!(maintainer_info.org_id, org_sym);

        let maintainers = client.get_maintainers(&org_sym);
        assert_eq!(maintainers.len(), 2);
        assert!(maintainers.contains(&m1));
        assert!(maintainers.contains(&m2));
    }

    // ── Reentrancy Attack Simulation ───────────────────────────────────────────
    //
    // A deliberately malicious token contract used to prove the reentrancy guard
    // works. On `transfer` to the configured target (the claiming maintainer)
    // it re-invokes the registry's `claim_payout`, simulating a contract that
    // re-enters the registry on token receipt.

    #[contract]
    pub struct MaliciousToken;

    #[contractimpl]
    impl MaliciousToken {
        /// Records the registry address and the "re-enter" target the registry
        /// will be re-invoked against when this token delivers tokens to it.
        pub fn init(env: Env, registry: Address, reenter_target: Address) {
            env.storage()
                .instance()
                .set(&Symbol::new(&env, "reg"), &registry);
            env.storage()
                .instance()
                .set(&Symbol::new(&env, "tgt"), &reenter_target);
        }

        pub fn mint(env: Env, to: Address, amount: i128) {
            to.require_auth();
            let key = to.clone();
            let bal: i128 = env.storage().instance().get(&key).unwrap_or(0);
            env.storage()
                .instance()
                .set(&key, &(bal.checked_add(amount).unwrap()));
        }

        pub fn balance(env: Env, id: Address) -> i128 {
            env.storage().instance().get(&id).unwrap_or(0)
        }

        pub fn transfer(env: Env, from: Address, to: Address, amount: i128) {
            from.require_auth();

            let from_key = from.clone();
            let fb: i128 = env.storage().instance().get(&from_key).unwrap_or(0);
            env.storage()
                .instance()
                .set(&from_key, &(fb.checked_sub(amount).unwrap()));

            let to_key = to.clone();
            let tb: i128 = env.storage().instance().get(&to_key).unwrap_or(0);
            env.storage()
                .instance()
                .set(&to_key, &(tb.checked_add(amount).unwrap()));

            // Re-enter the registry when delivering tokens to the target.
            let target: Option<Address> = env.storage().instance().get(&Symbol::new(&env, "tgt"));
            let registry: Option<Address> = env.storage().instance().get(&Symbol::new(&env, "reg"));
            if let (Some(target), Some(registry)) = (target, registry) {
                if to == target {
                    let client = crate::PayoutRegistryClient::new(&env, &registry);
                    client.claim_payout(&target);
                }
            }
        }
    }

    #[test]
    fn test_reentrancy_guard_blocks_reentrant_claim() {
        let env = Env::default();
        env.mock_all_auths();

        // Register the malicious token and configure it to re-enter the
        // registry whenever it delivers tokens to the claiming maintainer.
        let token_id = env.register_contract(None, MaliciousToken);
        let token_client = MaliciousTokenClient::new(&env, &token_id);

        let contract_id = env.register_contract(None, PayoutRegistry);
        let client = PayoutRegistryClient::new(&env, &contract_id);

        let admin1 = Address::generate(&env);
        let mut admins = Vec::new(&env);
        admins.push_back(admin1.clone());
        client.init(&token_id, &admins, &1);

        let maintainer = Address::generate(&env);
        token_client.init(&contract_id, &maintainer);

        let org_sym = symbol_short!("reorg");
        client.register_org(&org_sym, &String::from_str(&env, "Re Org"), &admin1);
        client.add_maintainer(&org_sym, &maintainer);

        let donor = Address::generate(&env);
        token_client.mint(&donor, &20_000_000);
        client.fund_org(&org_sym, &donor, &20_000_000);
        client.allocate_payout(&org_sym, &admin1, &maintainer, &5_000_000_i128, &0_u64);

        assert_eq!(client.get_claimable_balance(&maintainer), 5_000_000);
        assert_eq!(token_client.balance(&maintainer), 0);

        // Claiming transfers tokens through the malicious token, which re-enters
        // `claim_payout`. The reentrancy guard must reject the re-entrant call
        // and abort the whole transaction.
        let result = client.try_claim_payout(&maintainer);
        assert!(result.is_err());

        // The aborted transaction leaves state untouched.
        assert_eq!(client.get_claimable_balance(&maintainer), 5_000_000);
        assert_eq!(token_client.balance(&maintainer), 0);
    }

    #[test]
    fn test_reentrancy_guard_allows_sequential_calls() {
        // Guards are released at the end of every call, so unrelated
        // state-mutating operations must not falsely block each other.
        let Setup {
            env, client, token, ..
        } = setup();
        let org_sym = symbol_short!("seqorg");
        let admin = register_test_org(&env, &client, org_sym.clone());

        let m1 = Address::generate(&env);
        let m2 = Address::generate(&env);
        client.add_maintainer(&org_sym, &m1);
        client.add_maintainer(&org_sym, &m2);

        let donor = Address::generate(&env);
        let token_client = token::Client::new(&env, &token.address);
        token.mint(&donor, &40_000_000);

        // Fund, allocate, and claim for m1 — then do the same for m2. Every
        // guarded call must succeed because the guard is released each time.
        client.fund_org(&org_sym, &donor, &40_000_000);

        client.allocate_payout(&org_sym, &admin, &m1, &10_000_000_i128, &0_u64);
        let claimed1 = client.claim_payout(&m1);
        assert_eq!(claimed1, 10_000_000);
        assert_eq!(token_client.balance(&m1), 10_000_000);

        client.allocate_payout(&org_sym, &admin, &m2, &10_000_000_i128, &0_u64);
        let claimed2 = client.claim_payout(&m2);
        assert_eq!(claimed2, 10_000_000);
        assert_eq!(token_client.balance(&m2), 10_000_000);

        // Each claim reset the claimable balance to 0.
        assert_eq!(client.get_claimable_balance(&m1), 0);
        assert_eq!(client.get_claimable_balance(&m2), 0);
    }
}

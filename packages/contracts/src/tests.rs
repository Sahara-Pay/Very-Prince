#[allow(clippy::module_inception)]
#[cfg(test)]
mod tests {
    use crate::{PayoutParams, PayoutRegistry, PayoutRegistryClient};
    use soroban_sdk::testutils::Address as _;
    use soroban_sdk::{symbol_short, token, Address, Env, IntoVal, String, Symbol, Vec};

    // ── Test Helpers ─────────────────────────────────────────────────────────

    struct Setup {
        env: Env,
        client: PayoutRegistryClient<'static>,
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

        // Create 3 protocol admins with threshold of 2 for multisig
        let admin1 = Address::generate(&env);
        let admin2 = Address::generate(&env);
        let admin3 = Address::generate(&env);
        let mut admins = Vec::new(&env);
        admins.push_back(admin1.clone());
        admins.push_back(admin2.clone());
        admins.push_back(admin3.clone());

        client.init(&token_contract_id.address(), &admins, &2);

        Setup {
            env,
            client,
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

    // ── Multisig Protocol Admin Tests ───────────────────────────────────────────

    #[test]
    fn test_multisig_upgrade_with_three_keypairs() {
        let env = Env::default();
        let token_admin = Address::generate(&env);
        let token_contract_id = env.register_stellar_asset_contract_v2(token_admin.clone());
        let _token_client = token::StellarAssetClient::new(&env, &token_contract_id.address());

        let contract_id = env.register_contract(None, PayoutRegistry);
        let client = PayoutRegistryClient::new(&env, &contract_id);

        // Create 3 unique protocol admin keypairs
        let admin1 = Address::generate(&env);
        let admin2 = Address::generate(&env);
        let admin3 = Address::generate(&env);

        let mut admins = Vec::new(&env);
        admins.push_back(admin1.clone());
        admins.push_back(admin2.clone());
        admins.push_back(admin3.clone());

        // Initialize with threshold of 2 (requires 2-of-3 signatures)
        client.init(&token_contract_id.address(), &admins, &2);

        // Verify multisig configuration
        let multisig_admin = client.get_multisig_admin();
        assert_eq!(multisig_admin.admins.len(), 3);
        assert_eq!(multisig_admin.threshold, 2);

        let hash_bytes = [
            0xe3, 0xb0, 0xc4, 0x42, 0x98, 0xfc, 0x1c, 0x14, 0x9a, 0xfb, 0xf4, 0xc8, 0x99, 0x6f,
            0xb9, 0x24, 0x27, 0xae, 0x41, 0xe4, 0x64, 0x9b, 0x93, 0x4c, 0xa4, 0x95, 0x99, 0x1b,
            0x78, 0x52, 0xb8, 0x55_u8,
        ];
        let new_wasm_hash = soroban_sdk::BytesN::from_array(&env, &hash_bytes);

        // Test 1: Upgrade with only 1 signature should fail
        let mut signers1 = Vec::new(&env);
        signers1.push_back(admin1.clone());

        env.mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &admin1,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &contract_id,
                fn_name: "upgrade",
                args: (signers1.clone(), new_wasm_hash.clone()).into_val(&env),
                sub_invokes: &[],
            },
        }]);

        let result = client.try_upgrade(&signers1, &new_wasm_hash);
        assert!(result.is_err());

        // Test 2: Upgrade with 2 signatures should succeed
        let mut signers2 = Vec::new(&env);
        signers2.push_back(admin1.clone());
        signers2.push_back(admin2.clone());

        env.mock_auths(&[
            soroban_sdk::testutils::MockAuth {
                address: &admin1,
                invoke: &soroban_sdk::testutils::MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "upgrade",
                    args: (signers2.clone(), new_wasm_hash.clone()).into_val(&env),
                    sub_invokes: &[],
                },
            },
            soroban_sdk::testutils::MockAuth {
                address: &admin2,
                invoke: &soroban_sdk::testutils::MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "upgrade",
                    args: (signers2.clone(), new_wasm_hash.clone()).into_val(&env),
                    sub_invokes: &[],
                },
            },
        ]);

        let result = client.try_upgrade(&signers2, &new_wasm_hash);
        assert!(result.is_ok());

        // Test 3: Pause with 2 signatures should succeed
        let mut signers_pause = Vec::new(&env);
        signers_pause.push_back(admin2.clone());
        signers_pause.push_back(admin3.clone());

        env.mock_auths(&[
            soroban_sdk::testutils::MockAuth {
                address: &admin2,
                invoke: &soroban_sdk::testutils::MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "pause_protocol",
                    args: (signers_pause.clone(),).into_val(&env),
                    sub_invokes: &[],
                },
            },
            soroban_sdk::testutils::MockAuth {
                address: &admin3,
                invoke: &soroban_sdk::testutils::MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "pause_protocol",
                    args: (signers_pause.clone(),).into_val(&env),
                    sub_invokes: &[],
                },
            },
        ]);

        let result = client.try_pause_protocol(&signers_pause);
        assert!(result.is_ok());
        assert_eq!(client.get_protocol_state(), crate::ProtocolState::Paused);

        // Test 4: Unpause with only 1 signature should fail
        let mut signers_unpause1 = Vec::new(&env);
        signers_unpause1.push_back(admin1.clone());

        env.mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &admin1,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &contract_id,
                fn_name: "unpause_protocol",
                args: (signers_unpause1.clone(),).into_val(&env),
                sub_invokes: &[],
            },
        }]);

        let result = client.try_unpause_protocol(&signers_unpause1);
        assert!(result.is_err());

        // Test 5: Unpause with 2 signatures should succeed
        let mut signers_unpause2 = Vec::new(&env);
        signers_unpause2.push_back(admin1.clone());
        signers_unpause2.push_back(admin3.clone());

        env.mock_auths(&[
            soroban_sdk::testutils::MockAuth {
                address: &admin1,
                invoke: &soroban_sdk::testutils::MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "unpause_protocol",
                    args: (signers_unpause2.clone(),).into_val(&env),
                    sub_invokes: &[],
                },
            },
            soroban_sdk::testutils::MockAuth {
                address: &admin3,
                invoke: &soroban_sdk::testutils::MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "unpause_protocol",
                    args: (signers_unpause2.clone(),).into_val(&env),
                    sub_invokes: &[],
                },
            },
        ]);

        let result = client.try_unpause_protocol(&signers_unpause2);
        assert!(result.is_ok());
        assert_eq!(client.get_protocol_state(), crate::ProtocolState::Active);
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
}

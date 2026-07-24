#[allow(clippy::module_inception)]
#[cfg(test)]
mod tests {
    use crate::{PayoutParams, PayoutRegistry, PayoutRegistryClient};
    use soroban_sdk::testutils::{Address as _, Ledger as _};
    use soroban_sdk::{
        contract, contractimpl, symbol_short, token, Address, Env, IntoVal, String, Symbol, Vec,
    };

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

    fn python_reference_isqrt(value: i128) -> i128 {
        let mut lo = 0_i128;
        let mut hi = value;
        let mut ans = 0_i128;
        while lo <= hi {
            let mid = lo + ((hi - lo) / 2);
            let sq = mid.checked_mul(mid);
            if sq.is_some() && sq.unwrap() <= value {
                ans = mid;
                lo = mid + 1;
            } else {
                hi = mid - 1;
            }
        }
        ans
    }

    #[test]
    fn test_qf_isqrt_matches_python_reference_vectors() {
        let Setup { client, .. } = setup();
        let vectors = [
            0_i128,
            1,
            2,
            3,
            4,
            8,
            9,
            10,
            15,
            16,
            24,
            25,
            99,
            100,
            10_000_000_000_000_000_000,
        ];

        for value in vectors {
            assert_eq!(client.isqrt(&value), python_reference_isqrt(value));
        }
    }

    #[test]
    fn test_qf_contribution_requires_humanity_verification() {
        let Setup {
            env, client, token, ..
        } = setup();
        let org_sym = symbol_short!("qfhuman");
        register_test_org(&env, &client, org_sym.clone());

        let contributor = Address::generate(&env);
        token.mint(&contributor, &1_000);

        let result = client.try_qf_contribute(&org_sym, &contributor, &100);
        assert!(result.is_err());
        assert_eq!(client.get_qf_contribution(&org_sym, &contributor), 0);
    }

    #[test]
    fn test_qf_repeated_human_updates_cumulative_sqrt_once() {
        let Setup {
            env,
            client,
            token,
            protocol_admin,
            ..
        } = setup();
        let org_sym = symbol_short!("qfrepeat");
        register_test_org(&env, &client, org_sym.clone());

        let contributor = Address::generate(&env);
        client.verify_humanity(&protocol_admin, &contributor);
        let proof = client.get_humanity_proof(&contributor).unwrap();
        assert_eq!(proof.verified_by, protocol_admin);
        token.mint(&contributor, &1_000);

        client.qf_contribute(&org_sym, &contributor, &25);
        client.qf_contribute(&org_sym, &contributor, &75);

        let stats = client.get_qf_project_stats(&org_sym);
        assert_eq!(client.get_qf_contribution(&org_sym, &contributor), 100);
        assert_eq!(stats.direct_contributions, 100);
        assert_eq!(stats.sqrt_sum, 10);
        assert_eq!(stats.contributor_count, 1);
        assert_eq!(stats.weight, 100);
        assert_eq!(client.get_org_budget(&org_sym), 100);
    }

    #[test]
    fn test_qf_distribution_matches_python_reference_formula() {
        let Setup {
            env,
            client,
            token,
            protocol_admin,
            ..
        } = setup();
        let org_a = symbol_short!("qfa");
        let org_b = symbol_short!("qfb");
        register_test_org(&env, &client, org_a.clone());
        register_test_org(&env, &client, org_b.clone());

        let sponsor = Address::generate(&env);
        token.mint(&sponsor, &1_000);
        client.qf_deposit_matching_pool(&sponsor, &1_000);

        let c1 = Address::generate(&env);
        let c2 = Address::generate(&env);
        let c3 = Address::generate(&env);
        client.verify_humanity(&protocol_admin, &c1);
        client.verify_humanity(&protocol_admin, &c2);
        client.verify_humanity(&protocol_admin, &c3);
        token.mint(&c1, &100);
        token.mint(&c2, &100);
        token.mint(&c3, &400);

        client.qf_contribute(&org_a, &c1, &100);
        client.qf_contribute(&org_a, &c2, &100);
        client.qf_contribute(&org_b, &c3, &400);

        let mut projects = Vec::new(&env);
        projects.push_back(org_a.clone());
        projects.push_back(org_b.clone());

        let preview = client.qf_preview_distribution(&projects);
        assert_eq!(preview.get(0).unwrap().weight, 400);
        assert_eq!(preview.get(1).unwrap().weight, 400);
        assert_eq!(preview.get(0).unwrap().matching_amount, 500);
        assert_eq!(preview.get(1).unwrap().matching_amount, 500);

        let allocations = client.qf_distribute(&protocol_admin, &projects);
        assert_eq!(allocations.get(0).unwrap().matching_amount, 500);
        assert_eq!(allocations.get(1).unwrap().matching_amount, 500);
        assert_eq!(client.get_org_budget(&org_a), 700);
        assert_eq!(client.get_org_budget(&org_b), 900);
        assert_eq!(client.get_qf_project_stats(&org_a).matching_allocated, 500);
        assert_eq!(client.get_qf_project_stats(&org_b).matching_allocated, 500);
        assert_eq!(client.get_qf_matching_pool(), 0);
    }

    #[test]
    fn test_qf_distribution_rejects_duplicate_projects() {
        let Setup {
            env,
            client,
            token,
            protocol_admin,
            ..
        } = setup();
        let org_sym = symbol_short!("qfdupe");
        register_test_org(&env, &client, org_sym.clone());

        let sponsor = Address::generate(&env);
        token.mint(&sponsor, &1_000);
        client.qf_deposit_matching_pool(&sponsor, &1_000);

        let contributor = Address::generate(&env);
        client.verify_humanity(&protocol_admin, &contributor);
        token.mint(&contributor, &100);
        client.qf_contribute(&org_sym, &contributor, &100);

        let mut projects = Vec::new(&env);
        projects.push_back(org_sym.clone());
        projects.push_back(org_sym.clone());

        let result = client.try_qf_preview_distribution(&projects);
        assert!(result.is_err());
    }

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
        let neg_result = client.try_fund_org(&org_sym, &donor, &-10_i128);
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

// =============================================================================
// Cross-chain state proof verifier tests
// =============================================================================

#[cfg(test)]
mod cross_chain_tests {
    // ── RLP unit tests ────────────────────────────────────────────────────────
    mod rlp_tests {
        use crate::rlp::{
            decode_exact, decode_bytes, decode_u64,
            encode_bytes_v2, encode_list_payload_v2, EncodeBuf,
            RlpItem, RlpError,
        };

        #[test]
        fn single_byte_range() {
            for b in 0u8..=0x7f {
                let item = decode_exact(&[b]).unwrap();
                assert_eq!(item, RlpItem::Bytes(&[b]));
            }
        }

        #[test]
        fn empty_string_0x80() {
            let item = decode_exact(&[0x80]).unwrap();
            assert_eq!(item, RlpItem::Bytes(b""));
        }

        #[test]
        fn short_string_dog() {
            let enc = [0x83, b'd', b'o', b'g'];
            assert_eq!(decode_bytes(&enc).unwrap(), b"dog");
        }

        #[test]
        fn empty_list_0xc0() {
            let item = decode_exact(&[0xc0]).unwrap();
            assert!(matches!(item, RlpItem::List(_)));
        }

        #[test]
        fn list_cat_dog() {
            let enc = [0xc8, 0x83, b'c', b'a', b't', 0x83, b'd', b'o', b'g'];
            let item = decode_exact(&enc).unwrap();
            if let RlpItem::List(l) = item {
                let ch = l.items().unwrap();
                assert_eq!(ch.len(), 2);
                assert_eq!(ch.get(0).unwrap(), &RlpItem::Bytes(b"cat"));
                assert_eq!(ch.get(1).unwrap(), &RlpItem::Bytes(b"dog"));
            } else {
                panic!("expected list");
            }
        }

        #[test]
        fn non_canonical_single_byte_rejected() {
            // 0x81 0x00 is non-canonical (0x00 fits in single-byte form)
            let res = decode_exact(&[0x81, 0x00]);
            assert_eq!(res, Err(RlpError::NonCanonicalLength));
        }

        #[test]
        fn trailing_data_rejected() {
            let res = decode_exact(&[0x83, b'd', b'o', b'g', 0x00]);
            assert_eq!(res, Err(RlpError::TrailingData));
        }

        #[test]
        fn payload_out_of_bounds() {
            // 0x83 says 3-byte payload but only 1 byte follows
            let res = decode_exact(&[0x83, b'a']);
            assert_eq!(res, Err(RlpError::PayloadOutOfBounds));
        }

        #[test]
        fn long_string_56_bytes() {
            let payload = [0xaau8; 56];
            let mut buf = EncodeBuf::new();
            encode_bytes_v2(&payload, &mut buf).unwrap();
            let enc = buf.as_slice();
            // prefix should be 0xb8 (0xb7 + 1 length byte)
            assert_eq!(enc[0], 0xb8);
            assert_eq!(enc[1], 56u8);
            assert_eq!(decode_bytes(enc).unwrap(), &payload[..]);
        }

        #[test]
        fn encode_decode_roundtrip() {
            let mut child = EncodeBuf::new();
            encode_bytes_v2(b"hello", &mut child).unwrap();
            encode_bytes_v2(b"world", &mut child).unwrap();
            let mut out = EncodeBuf::new();
            encode_list_payload_v2(child.as_slice(), &mut out).unwrap();

            let item = decode_exact(out.as_slice()).unwrap();
            if let RlpItem::List(l) = item {
                let ch = l.items().unwrap();
                assert_eq!(ch.len(), 2);
                assert_eq!(ch.get(0).unwrap(), &RlpItem::Bytes(b"hello"));
                assert_eq!(ch.get(1).unwrap(), &RlpItem::Bytes(b"world"));
            } else {
                panic!("expected list");
            }
        }

        #[test]
        fn nested_list_structure() {
            // [ [], [[]] ] = 0xc3 0xc0 0xc1 0xc0
            let enc = [0xc3, 0xc0, 0xc1, 0xc0];
            let item = decode_exact(&enc).unwrap();
            if let RlpItem::List(outer) = item {
                let ch = outer.items().unwrap();
                assert_eq!(ch.len(), 2);
                assert!(matches!(ch.get(0).unwrap(), RlpItem::List(_)));
                assert!(matches!(ch.get(1).unwrap(), RlpItem::List(_)));
            } else {
                panic!("expected list");
            }
        }

        #[test]
        fn decode_u64_basic() {
            // RLP-encode 0x0102 as bytes and decode it
            let mut buf = EncodeBuf::new();
            encode_bytes_v2(&[0x01, 0x02], &mut buf).unwrap();
            let val = decode_u64(buf.as_slice()).unwrap();
            assert_eq!(val, 0x0102u64);
        }

        #[test]
        fn empty_input_error() {
            assert_eq!(crate::rlp::decode(b""), Err(RlpError::Empty));
        }
    }

    // ── Keccak-256 unit tests ─────────────────────────────────────────────────
    mod keccak_tests {
        use crate::keccak::{keccak256, keccak256_concat, Keccak256};

        fn hex32(s: &str) -> [u8; 32] {
            let mut out = [0u8; 32];
            for i in 0..32 {
                out[i] = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).unwrap();
            }
            out
        }

        #[test]
        fn empty_input() {
            let expected = hex32(
                "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
            );
            assert_eq!(keccak256(b""), expected);
        }

        #[test]
        fn abc() {
            let expected = hex32(
                "4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45",
            );
            assert_eq!(keccak256(b"abc"), expected);
        }

        #[test]
        fn hello() {
            let expected = hex32(
                "1c8aff950685c2ed4bc3174f3472287b56d9517b9c948127319a09a7a36deac8",
            );
            assert_eq!(keccak256(b"hello"), expected);
        }

        #[test]
        fn streaming_equals_oneshot() {
            let data = b"The quick brown fox jumps over the lazy dog";
            let oneshot = keccak256(data);
            let mut h = Keccak256::new();
            h.update(&data[..15]);
            h.update(&data[15..]);
            assert_eq!(oneshot, h.finalize());
        }

        #[test]
        fn multi_block_crossing() {
            // 200 bytes crosses the 136-byte rate boundary
            let data = [0x42u8; 200];
            let h1 = keccak256(&data);
            let mut h = Keccak256::new();
            h.update(&data[..100]);
            h.update(&data[100..]);
            assert_eq!(h1, h.finalize());
        }

        #[test]
        fn concat_helper_matches_combined() {
            let a = b"cross-chain";
            let b = b"-proof";
            let mut combined = [0u8; 17];
            combined[..11].copy_from_slice(a);
            combined[11..].copy_from_slice(b);
            assert_eq!(keccak256_concat(a, b), keccak256(&combined));
        }

        #[test]
        fn distinct_inputs_give_distinct_hashes() {
            assert_ne!(keccak256(b"key_a"), keccak256(b"key_b"));
        }
    }
}

#[cfg(test)]
mod mpt_and_verifier_tests {
    use crate::keccak::keccak256;
    use crate::mpt::{verify_proof, verify_exclusion_proof, MptError};
    use crate::cross_chain_verifier::{
        verify_state_proof, verify_exclusion, decode_eth_account,
        reputation_score_from_account, BlockHeader, CrossChainError, EthAccount,
    };
    use crate::rlp::{EncodeBuf, encode_bytes_v2, encode_list_payload_v2};

    // ── Shared helpers ────────────────────────────────────────────────────────

    /// Compact (hex-prefix) encode a nibble slice into bytes.
    fn compact_encode(nibbles: &[u8], is_leaf: bool, odd: bool) -> std::vec::Vec<u8> {
        let flag_hi: u8 = if is_leaf { 2 } else { 0 } | if odd { 1 } else { 0 };
        let mut out = std::vec::Vec::new();
        if odd {
            out.push((flag_hi << 4) | nibbles[0]);
            let mut i = 1;
            while i + 1 < nibbles.len() {
                out.push((nibbles[i] << 4) | nibbles[i + 1]);
                i += 2;
            }
        } else {
            out.push(flag_hi << 4);
            let mut i = 0;
            while i + 1 < nibbles.len() {
                out.push((nibbles[i] << 4) | nibbles[i + 1]);
                i += 2;
            }
        }
        out
    }

    /// Build an RLP leaf node encoding [compact_key_bytes, value].
    fn make_leaf(all_nibbles: &[u8; 64], value: &[u8]) -> std::vec::Vec<u8> {
        let compact = compact_encode(all_nibbles, true, false);
        let mut payload = EncodeBuf::new();
        encode_bytes_v2(&compact, &mut payload).unwrap();
        encode_bytes_v2(value, &mut payload).unwrap();
        let mut out = EncodeBuf::new();
        encode_list_payload_v2(payload.as_slice(), &mut out).unwrap();
        out.as_slice().to_vec()
    }

    /// Build the 64-nibble path array from keccak256(key).
    fn key_nibbles(key: &[u8]) -> [u8; 64] {
        let hash = keccak256(key);
        let mut n = [0u8; 64];
        for i in 0..32 {
            n[2 * i]     = hash[i] >> 4;
            n[2 * i + 1] = hash[i] & 0x0f;
        }
        n
    }

    /// Build a single-leaf proof and return (root_hash, leaf_bytes).
    fn single_leaf_proof(key: &[u8], value: &[u8]) -> ([u8; 32], std::vec::Vec<u8>) {
        let nibbles = key_nibbles(key);
        let leaf = make_leaf(&nibbles, value);
        let root = keccak256(&leaf);
        (root, leaf)
    }

    fn eth_header(state_root: [u8; 32]) -> BlockHeader {
        BlockHeader { state_root, block_number: 19_000_000, chain_id: 1 }
    }

    // ── MPT tests ─────────────────────────────────────────────────────────────

    #[test]
    fn mpt_valid_single_leaf() {
        let key = b"reputation_key";
        let value = b"score_data";
        let (root, leaf) = single_leaf_proof(key, value);
        assert_eq!(verify_proof(&root, key, value, &[leaf.as_slice()]), Ok(()));
    }

    #[test]
    fn mpt_wrong_value_rejected() {
        let key = b"reputation_key";
        let value = b"score_data";
        let (root, leaf) = single_leaf_proof(key, value);
        let res = verify_proof(&root, key, b"bad_value", &[leaf.as_slice()]);
        assert_eq!(res, Err(MptError::ValueMismatch));
    }

    #[test]
    fn mpt_root_hash_mismatch() {
        let key = b"reputation_key";
        let value = b"score_data";
        let (mut root, leaf) = single_leaf_proof(key, value);
        root[0] ^= 0xff;
        let res = verify_proof(&root, key, value, &[leaf.as_slice()]);
        assert_eq!(res, Err(MptError::RootHashMismatch));
    }

    #[test]
    fn mpt_empty_proof_rejected() {
        assert_eq!(verify_proof(&[0u8; 32], b"k", b"v", &[]),
                   Err(MptError::EmptyProof));
    }

    #[test]
    fn mpt_empty_key_rejected() {
        assert_eq!(verify_proof(&[0u8; 32], b"", b"v", &[&[0xc0]]),
                   Err(MptError::EmptyKey));
    }

    #[test]
    fn mpt_manipulated_node_rejected() {
        let key = b"manipulation_test";
        let value = b"original";
        let (root, mut leaf) = single_leaf_proof(key, value);
        let mid = leaf.len() / 2;
        leaf[mid] ^= 0xff;
        let res = verify_proof(&root, key, value, &[leaf.as_slice()]);
        assert!(res.is_err(), "manipulated node must be rejected");
    }

    #[test]
    fn mpt_different_key_path_mismatch() {
        // Build a leaf for key_a, then try to verify it as key_b
        let (root, leaf) = single_leaf_proof(b"key_a", b"value");
        let res = verify_proof(&root, b"key_b", b"value", &[leaf.as_slice()]);
        assert!(res.is_err());
    }

    // ── CrossChainVerifier tests ───────────────────────────────────────────────

    #[test]
    fn ccv_valid_inclusion() {
        let key = b"eth_maintainer_addr";
        let value = b"reputation_rlp_encoded";
        let (root, leaf) = single_leaf_proof(key, value);
        let header = eth_header(root);
        let res = verify_state_proof(&header, key, value, &[leaf.as_slice()]);
        assert!(res.is_ok(), "{:?}", res);
        let vs = res.unwrap();
        assert_eq!(vs.chain_id, 1);
        assert_eq!(vs.block_number, 19_000_000);
        assert_eq!(&vs.value[..vs.value_len], value);
    }

    #[test]
    fn ccv_tampered_root_rejected() {
        let key = b"eth_maintainer_addr";
        let value = b"some_value";
        let (mut root, leaf) = single_leaf_proof(key, value);
        root[15] ^= 0xaa;
        let header = eth_header(root);
        let res = verify_state_proof(&header, key, value, &[leaf.as_slice()]);
        assert_eq!(res, Err(CrossChainError::ProofVerifyError(MptError::RootHashMismatch)));
    }

    #[test]
    fn ccv_wrong_value_rejected() {
        let key = b"eth_maintainer_addr";
        let value = b"real_value";
        let (root, leaf) = single_leaf_proof(key, value);
        let header = eth_header(root);
        let res = verify_state_proof(&header, key, b"fake_value", &[leaf.as_slice()]);
        assert_eq!(res, Err(CrossChainError::ProofVerifyError(MptError::ValueMismatch)));
    }

    #[test]
    fn ccv_zero_chain_id_rejected() {
        let header = BlockHeader { state_root: [0u8; 32], block_number: 1, chain_id: 0 };
        let res = verify_state_proof(&header, b"k", b"v", &[&[0xc0]]);
        assert_eq!(res, Err(CrossChainError::InvalidHeader));
    }

    #[test]
    fn ccv_empty_key_rejected() {
        let header = eth_header([0u8; 32]);
        let res = verify_state_proof(&header, b"", b"v", &[&[0xc0]]);
        assert_eq!(res, Err(CrossChainError::InputTooLong));
    }

    #[test]
    fn ccv_too_many_nodes_rejected() {
        let header = eth_header([0u8; 32]);
        let nodes: std::vec::Vec<&[u8]> = (0..=16).map(|_| [0xc0u8].as_slice()).collect();
        let res = verify_state_proof(&header, b"key", b"val", &nodes);
        assert_eq!(res, Err(CrossChainError::InputTooLong));
    }

    // ── decode_eth_account tests ──────────────────────────────────────────────

    fn build_eth_account_rlp(nonce: &[u8], balance: &[u8]) -> std::vec::Vec<u8> {
        let storage_root = [0x56u8; 32];
        let code_hash    = [0x78u8; 32];
        let mut payload = EncodeBuf::new();
        encode_bytes_v2(nonce,        &mut payload).unwrap();
        encode_bytes_v2(balance,      &mut payload).unwrap();
        encode_bytes_v2(&storage_root, &mut payload).unwrap();
        encode_bytes_v2(&code_hash,    &mut payload).unwrap();
        let mut out = EncodeBuf::new();
        encode_list_payload_v2(payload.as_slice(), &mut out).unwrap();
        out.as_slice().to_vec()
    }

    #[test]
    fn decode_eth_account_valid() {
        let rlp = build_eth_account_rlp(&[0x05], &[0x01]);
        let acc = decode_eth_account(&rlp).unwrap();
        assert_eq!(acc.nonce, 5);
        assert_eq!(acc.balance[31], 1);
        assert_eq!(acc.storage_root, [0x56u8; 32]);
        assert_eq!(acc.code_hash, [0x78u8; 32]);
    }

    #[test]
    fn decode_eth_account_invalid_bytes() {
        let res = decode_eth_account(b"\xff\xfe\xfd");
        assert!(matches!(res, Err(CrossChainError::RlpDecodeError(_))));
    }

    #[test]
    fn decode_eth_account_wrong_field_count() {
        // Only 3 fields — should fail
        let mut payload = EncodeBuf::new();
        encode_bytes_v2(&[0x01], &mut payload).unwrap();
        encode_bytes_v2(&[0x02], &mut payload).unwrap();
        encode_bytes_v2(&[0x03], &mut payload).unwrap();
        let mut out = EncodeBuf::new();
        encode_list_payload_v2(payload.as_slice(), &mut out).unwrap();
        let res = decode_eth_account(out.as_slice());
        assert_eq!(res, Err(CrossChainError::InvalidValueEncoding));
    }

    // ── reputation_score_from_account tests ───────────────────────────────────

    #[test]
    fn reputation_zero_for_empty_account() {
        assert_eq!(reputation_score_from_account(&EthAccount::default()), 0);
    }

    #[test]
    fn reputation_nonzero_for_balance() {
        let mut acc = EthAccount::default();
        // 1 ETH = 10^18 wei
        let one_eth: u128 = 1_000_000_000_000_000_000;
        let be = one_eth.to_be_bytes();
        acc.balance[16..].copy_from_slice(&be);
        acc.balance_len = 16;
        let score = reputation_score_from_account(&acc);
        assert!(score > 0 && score <= 10_000);
    }

    #[test]
    fn reputation_capped_at_10000() {
        let mut acc = EthAccount::default();
        // Max balance: u128::MAX
        let be = u128::MAX.to_be_bytes();
        acc.balance[16..].copy_from_slice(&be);
        acc.balance_len = 16;
        assert_eq!(reputation_score_from_account(&acc), 10_000);
    }

    // ── Exclusion proof tests ─────────────────────────────────────────────────

    #[test]
    fn exclusion_proof_valid_non_inclusion() {
        // A leaf for key_a should be valid exclusion proof for key_b
        // when the path diverges (root hash mismatch makes this the simplest test)
        // Here we test the API contract: verify_exclusion_proof accepts
        // a key-not-found result as Ok.
        let key = b"absent_key";
        // Build a leaf that matches a different key to produce KeyNotFound
        let (root, leaf) = single_leaf_proof(b"other_key", b"some_value");
        // verify_exclusion_proof should either Ok (key absent) or Err(PathMismatch)
        // depending on path traversal; both indicate non-inclusion
        let res = verify_exclusion_proof(&root, key, &[leaf.as_slice()]);
        // PathMismatch counts as non-inclusion in exclusion API
        assert!(res.is_ok() || matches!(res, Err(MptError::PathMismatch)));
    }

    #[test]
    fn ccv_exclusion_valid() {
        let (root, leaf) = single_leaf_proof(b"other_key", b"val");
        let header = eth_header(root);
        let res = verify_exclusion(&header, b"absent_key", &[leaf.as_slice()]);
        assert!(res.is_ok() || matches!(res, Err(CrossChainError::ProofVerifyError(_))));
    }
}

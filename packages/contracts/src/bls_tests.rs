#[cfg(test)]
mod bls_tests {
    use crate::{PayoutRegistry, PayoutRegistryClient};
    use bls12_381_plus::{G1Affine, G2Affine, G1Projective, G2Projective, Scalar, ExpandMsgXmd, group::Group, group::ff::Field};
    use soroban_sdk::{testutils::Address as _, Address, Env, Symbol, Bytes};
    use rand::SeedableRng;
    use rand_chacha::ChaCha20Rng;

    fn setup() -> (Env, PayoutRegistryClient<'static>) {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(PayoutRegistry, ());
        let client = PayoutRegistryClient::new(&env, &contract_id);
        
        let admin = Address::generate(&env);
        let token = Address::generate(&env);
        let mut admins = soroban_sdk::Vec::new(&env);
        admins.push_back(admin.clone());
        client.init(&token, &admins, &1);
        
        (env, client)
    }

    #[test]
    fn test_bls_aggregation_and_verification() {
        let (env, client) = setup();
        let dao_id = Symbol::new(&env, "DAO1");
        
        // Register the DAO org
        let admin = Address::generate(&env);
        client.register_org(&dao_id, &soroban_sdk::String::from_str(&env, "DAO One"), &admin);

        // Use a deterministic RNG for tests
        let mut rng = ChaCha20Rng::seed_from_u64(42);
        
        // Generate 3 signers
        let sks = [
            Scalar::random(&mut rng),
            Scalar::random(&mut rng),
            Scalar::random(&mut rng),
        ];
        
        let pks = sks.iter().map(|sk| (G2Affine::generator() * sk).to_affine()).collect::<std::vec::Vec<_>>();
        
        // Register each signer with PoP
        for (i, pk) in pks.iter().enumerate() {
            let pk_bytes = pk.to_compressed();
            let h_pk = G1Projective::hash_to_curve::<ExpandMsgXmd<sha2::Sha256>>(&pk_bytes, b"BLS_POP_BLS12381G1_XMD:SHA-256_SSWU_RO_POP_").to_affine();
            let pop = (h_pk * sks[i]).to_affine();
            let pop_bytes = pop.to_compressed();
            
            client.register_bls_signer(&dao_id, &Bytes::from_slice(&env, &pk_bytes), &Bytes::from_slice(&env, &pop_bytes));
        }

        // Aggregate signatures off-chain
        let payout_id = 123u64;
        let msg = payout_id.to_be_bytes();
        let h_m = G1Projective::hash_to_curve::<ExpandMsgXmd<sha2::Sha256>>(&msg, b"BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_").to_affine();
        
        let mut agg_sig = G1Projective::identity();
        for sk in sks {
            agg_sig += h_m * sk;
        }
        let agg_sig_affine = agg_sig.to_affine();
        let agg_sig_bytes = agg_sig_affine.to_compressed();

        // Verify on-chain
        let verified = client.verify_dao_payout_approval(&dao_id, &payout_id, &Bytes::from_slice(&env, &agg_sig_bytes));
        assert!(verified);
    }

    #[test]
    #[should_panic]
    fn test_rogue_key_attack_mitigation() {
        let (env, client) = setup();
        let dao_id = Symbol::new(&env, "DAO2");
        
        let admin = Address::generate(&env);
        client.register_org(&dao_id, &soroban_sdk::String::from_str(&env, "DAO Two"), &admin);

        let mut rng = ChaCha20Rng::seed_from_u64(42);
        let pk = (G2Affine::generator() * Scalar::random(&mut rng)).to_affine();
        let pk_bytes = pk.to_compressed();
        
        // Provide an invalid PoP (just random bytes)
        let invalid_pop = [0u8; 48];
        
        client.register_bls_signer(&dao_id, &Bytes::from_slice(&env, &pk_bytes), &Bytes::from_slice(&env, &invalid_pop));
    }
}

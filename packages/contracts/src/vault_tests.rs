#[cfg(test)]
mod vault_tests {
    use crate::{PayoutRegistry, PayoutRegistryClient, PrinceError};
    use soroban_sdk::testutils::{Address as _, Ledger as _};
    use soroban_sdk::{token, Address, Env, Vec};

    struct Setup {
        env: Env,
        client: PayoutRegistryClient<'static>,
        token: token::StellarAssetClient<'static>,
        token_id: Address,
    }

    fn setup() -> Setup {
        let env = Env::default();
        env.mock_all_auths();

        let token_admin = Address::generate(&env);
        let token_id = env.register_stellar_asset_contract_v2(token_admin.clone());
        let token_client = token::StellarAssetClient::new(&env, &token_id.address());

        let contract_id = env.register(PayoutRegistry, ());
        let client = PayoutRegistryClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let mut admins = Vec::new(&env);
        admins.push_back(admin);
        client.init(&token_id.address(), &admins, &1);

        Setup {
            env,
            client,
            token: token_client,
            token_id: token_id.address(),
        }
    }

    #[test]
    fn test_vault_lock_and_claim() {
        let Setup { env, client, token, token_id } = setup();
        let user = Address::generate(&env);
        let amount = 1000_i128;
        
        // Mint some tokens to the user
        token.mint(&user, &amount);
        
        // Maturity date: 1 hour from now
        let now = 10_000u64;
        env.ledger().set_timestamp(now);
        let maturity = now + 3600;

        // Create vault
        client.create_vault(&user, &user, &amount, &maturity);
        
        // Check contract balance
        let token_contract = token::Client::new(&env, &token_id);
        assert_eq!(token_contract.balance(&env.current_contract_address()), amount);

        // Try to claim before maturity (at now + 1800)
        env.ledger().set_timestamp(now + 1800);
        let result = client.try_claim_vault(&user, &maturity);
        assert!(result.is_err());
        // Error code 24 is PayoutLocked
        // assert_eq!(result.unwrap_err(), PrinceError::PayoutLocked.into());

        // Boundary test: Exactly at maturity
        env.ledger().set_timestamp(maturity);
        client.claim_vault(&user, &maturity);
        
        // User should have their tokens back
        assert_eq!(token_contract.balance(&user), amount);
        assert_eq!(token_contract.balance(&env.current_contract_address()), 0);
    }

    #[test]
    fn test_long_term_64bit_date() {
        let Setup { env, client, token, .. } = setup();
        let user = Address::generate(&env);
        let amount = 500_i128;
        
        token.mint(&user, &amount);
        
        // Far future date (year 2100+)
        let far_future = 4102444800u64; 
        env.ledger().set_timestamp(1000);

        client.create_vault(&user, &user, &amount, &far_future);
        
        // Still locked in 2050
        env.ledger().set_timestamp(2524608000u64);
        assert!(client.try_claim_vault(&user, &far_future).is_err());
        
        // Unlock in 2100
        env.ledger().set_timestamp(far_future);
        client.claim_vault(&user, &far_future);
    }
}

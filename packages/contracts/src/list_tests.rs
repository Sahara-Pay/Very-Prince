#[cfg(test)]
mod list_tests {
    use crate::{PayoutRegistry, PayoutRegistryClient, linked_list::ListNode};
    use soroban_sdk::{testutils::Address as _, Address, Env, Symbol, Vec};

    fn setup() -> (Env, PayoutRegistryClient<'static>) {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(PayoutRegistry, ());
        let client = PayoutRegistryClient::new(&env, &contract_id);
        
        let admin = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token_contract = env.register_stellar_asset_contract_v2(token_admin);
        let mut admins = Vec::new(&env);
        admins.push_back(admin.clone());
        client.init(&token_contract.address(), &admins, &1);
        
        (env, client)
    }

    #[test]
    fn test_list_insertion_and_removal() {
        let (env, client) = setup();
        let list_id = Symbol::new(&env, "Queue1");
        let user1 = Address::generate(&env);
        let user2 = Address::generate(&env);
        let user3 = Address::generate(&env);

        // Insert first node (head/tail)
        let id1 = client.list_insert(&list_id, &user1, &100, &None, &None);
        
        // Insert at tail (priority 50 < 100)
        let id2 = client.list_insert(&list_id, &user2, &50, &Some(id1), &None);
        
        // Insert in middle (priority 75)
        let id3 = client.list_insert(&list_id, &user3, &75, &Some(id1), &Some(id2));

        let page = client.list_get_page(&list_id, &None, &10);
        assert_eq!(page.len(), 3);
        assert_eq!(page.get(0).unwrap().id, id1);
        assert_eq!(page.get(1).unwrap().id, id3);
        assert_eq!(page.get(2).unwrap().id, id2);

        // Remove middle node
        client.list_remove(&list_id, &id3);
        let page2 = client.list_get_page(&list_id, &None, &10);
        assert_eq!(page2.len(), 2);
        assert_eq!(page2.get(0).unwrap().id, id1);
        assert_eq!(page2.get(1).unwrap().id, id2);
    }

    #[test]
    #[should_panic] // InvalidListInsertionPoint
    fn test_invalid_insertion_priority() {
        let (env, client) = setup();
        let list_id = Symbol::new(&env, "Queue2");
        let user = Address::generate(&env);

        let id1 = client.list_insert(&list_id, &user, &100, &None, &None);
        
        // Try to insert with higher priority (150) AFTER id1 (100) - should fail
        client.list_insert(&list_id, &user, &150, &Some(id1), &None);
    }

    #[test]
    #[should_panic] // ListTraversalLimitExceeded
    fn test_traversal_limit() {
        let (env, client) = setup();
        let list_id = Symbol::new(&env, "Queue3");
        let user = Address::generate(&env);

        let mut prev = None;
        for i in 0..51 {
            let id = client.list_insert(&list_id, &user, &(1000 - (i as i128)), &prev, &None);
            prev = Some(id);
        }

        // Try to get more than 50 nodes
        client.list_get_page(&list_id, &None, &60);
    }
}

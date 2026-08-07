//! # Doubly Linked List for On-Chain Priority Queues
//!
//! Provides O(1) insertion and deletion by utilizing persistent storage keys
//! as pointers. Sorting is maintained by requiring callers to provide the
//! correct insertion point, which is then verified on-chain.

use soroban_sdk::{contracttype, Address, Env, Symbol, panic_with_error};
use crate::{DataKey, PrinceError, PERSISTENT_BUMP_AMOUNT, PERSISTENT_LIFETIME_THRESHOLD};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ListNode {
    pub id: u64,
    pub priority: i128,
    pub value: Address,
    pub prev: Option<u64>,
    pub next: Option<u64>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ListMetadata {
    pub head: Option<u64>,
    pub tail: Option<u64>,
    pub size: u32,
}

/// Maximum number of nodes to traverse in a single call to prevent CPU limit exhaustion.
const MAX_TRAVERSAL_DEPTH: u32 = 50;

pub struct SortedList;

impl SortedList {
    /// Internal helper to get list metadata.
    fn get_metadata(env: &Env, list_id: &Symbol) -> ListMetadata {
        env.storage()
            .persistent()
            .get(&DataKey::ListMetadata(list_id.clone()))
            .unwrap_or(ListMetadata {
                head: None,
                tail: None,
                size: 0,
            })
    }

    /// Internal helper to set list metadata and bump TTL.
    fn set_metadata(env: &Env, list_id: &Symbol, metadata: &ListMetadata) {
        let key = DataKey::ListMetadata(list_id.clone());
        env.storage().persistent().set(&key, metadata);
        env.storage()
            .persistent()
            .extend_ttl(&key, PERSISTENT_LIFETIME_THRESHOLD, PERSISTENT_BUMP_AMOUNT);
    }

    /// Internal helper to get a node.
    fn get_node(env: &Env, list_id: &Symbol, node_id: u64) -> Option<ListNode> {
        let key = DataKey::ListNode(list_id.clone(), node_id);
        let node: Option<ListNode> = env.storage().persistent().get(&key);
        if node.is_some() {
            env.storage()
                .persistent()
                .extend_ttl(&key, PERSISTENT_LIFETIME_THRESHOLD, PERSISTENT_BUMP_AMOUNT);
        }
        node
    }

    /// Internal helper to set a node.
    fn set_node(env: &Env, list_id: &Symbol, node: &ListNode) {
        let key = DataKey::ListNode(list_id.clone(), node.id);
        env.storage().persistent().set(&key, node);
        env.storage()
            .persistent()
            .extend_ttl(&key, PERSISTENT_LIFETIME_THRESHOLD, PERSISTENT_BUMP_AMOUNT);
    }

    /// Get the next available node ID.
    fn next_id(env: &Env, list_id: &Symbol) -> u64 {
        let key = DataKey::ListNextId(list_id.clone());
        let id: u64 = env.storage().persistent().get(&key).unwrap_or(1);
        env.storage().persistent().set(&key, &(id + 1));
        id
    }

    /// Insert a node into the sorted list at a specific position (O(1)).
    ///
    /// The caller must provide `prev_id` and `next_id`. The contract verifies
    /// that:
    /// 1. `prev_id`'s priority >= `priority`
    /// 2. `next_id`'s priority <= `priority`
    /// 3. `prev_id` and `next_id` are actually adjacent.
    pub fn insert(
        env: &Env,
        list_id: Symbol,
        value: Address,
        priority: i128,
        prev_id: Option<u64>,
        next_id: Option<u64>,
    ) -> u64 {
        let mut metadata = Self::get_metadata(env, &list_id);
        
        // Verify insertion point
        if let Some(p_id) = prev_id {
            let prev_node = Self::get_node(env, &list_id, p_id)
                .unwrap_or_else(|| panic_with_error!(env, PrinceError::ListNodeNotFound));
            if prev_node.priority < priority || prev_node.next != next_id {
                panic_with_error!(env, PrinceError::InvalidListInsertionPoint);
            }
        } else if metadata.head != next_id {
            // If inserting at head, next_id must be the current head
            panic_with_error!(env, PrinceError::InvalidListInsertionPoint);
        }

        if let Some(n_id) = next_id {
            let next_node = Self::get_node(env, &list_id, n_id)
                .unwrap_or_else(|| panic_with_error!(env, PrinceError::ListNodeNotFound));
            if next_node.priority > priority || next_node.prev != prev_id {
                panic_with_error!(env, PrinceError::InvalidListInsertionPoint);
            }
        } else if metadata.tail != prev_id {
            // If inserting at tail, prev_id must be the current tail
            panic_with_error!(env, PrinceError::InvalidListInsertionPoint);
        }

        let node_id = Self::next_id(env, &list_id);
        let new_node = ListNode {
            id: node_id,
            priority,
            value,
            prev: prev_id,
            next: next_id,
        };

        // Update neighbors
        if let Some(p_id) = prev_id {
            let mut prev_node = Self::get_node(env, &list_id, p_id).unwrap();
            prev_node.next = Some(node_id);
            Self::set_node(env, &list_id, &prev_node);
        } else {
            metadata.head = Some(node_id);
        }

        if let Some(n_id) = next_id {
            let mut next_node = Self::get_node(env, &list_id, n_id).unwrap();
            next_node.prev = Some(node_id);
            Self::set_node(env, &list_id, &next_node);
        } else {
            metadata.tail = Some(node_id);
        }

        metadata.size += 1;
        Self::set_node(env, &list_id, &new_node);
        Self::set_metadata(env, &list_id, &metadata);

        node_id
    }

    /// Remove a node from the list (O(1)).
    pub fn remove(env: &Env, list_id: Symbol, node_id: u64) {
        let node = Self::get_node(env, &list_id, node_id)
            .unwrap_or_else(|| panic_with_error!(env, PrinceError::ListNodeNotFound));

        let mut metadata = Self::get_metadata(env, &list_id);

        if let Some(p_id) = node.prev {
            let mut prev_node = Self::get_node(env, &list_id, p_id).unwrap();
            prev_node.next = node.next;
            Self::set_node(env, &list_id, &prev_node);
        } else {
            metadata.head = node.next;
        }

        if let Some(n_id) = node.next {
            let mut next_node = Self::get_node(env, &list_id, n_id).unwrap();
            next_node.prev = node.prev;
            Self::set_node(env, &list_id, &next_node);
        } else {
            metadata.tail = node.prev;
        }

        metadata.size -= 1;
        env.storage().persistent().remove(&DataKey::ListNode(list_id.clone(), node_id));
        Self::set_metadata(env, &list_id, &metadata);
    }

    /// Traverse the list to fetch a page of nodes (O(limit)).
    /// Includes a safety depth limit to prevent CPU exhaustion.
    pub fn get_page(
        env: &Env,
        list_id: Symbol,
        start_id: Option<u64>,
        limit: u32,
    ) -> soroban_sdk::Vec<ListNode> {
        let mut result = soroban_sdk::Vec::new(env);
        let mut current_id = start_id.or_else(|| Self::get_metadata(env, &list_id).head);
        let mut count = 0;

        while let Some(id) = current_id {
            if count >= limit || count >= MAX_TRAVERSAL_DEPTH {
                break;
            }

            let node = Self::get_node(env, &list_id, id).unwrap();
            result.push_back(node.clone());
            current_id = node.next;
            count += 1;
        }

        if count >= MAX_TRAVERSAL_DEPTH && current_id.is_some() {
            panic_with_error!(env, PrinceError::ListTraversalLimitExceeded);
        }

        result
    }
}

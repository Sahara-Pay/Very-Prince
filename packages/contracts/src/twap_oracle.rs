#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, panic_with_error, Address, Env, Symbol,
};

/// Errors specific to TWAP Oracle operations.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum TwapError {
    AlreadyInitialized = 100,
    NotInitialized = 101,
    NotAuthorized = 102,
    InvalidCapacity = 103,
    InvalidPrice = 104,
    InvalidTimeDelta = 105,
    StalePriceData = 106,
    PriceDeviationExceeded = 107,
    CircuitBroken = 108,
    InsufficientObservations = 109,
    WindowTooLarge = 110,
    AssetNotFound = 111,
    InvalidWindow = 112,
}

/// Historical price observation saved in the ring buffer.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PriceObservation {
    /// Timestamp of ledger (in seconds).
    pub timestamp: u64,
    /// Instantaneous spot price tick recorded at this timestamp.
    pub price: i128,
    /// Cumulative price sum: sum(price_i * delta_t_i).
    pub cumulative_price: i128,
}

/// Configuration parameters for an asset's TWAP oracle.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OracleConfig {
    /// Authorized oracle admin who can push updates and control circuit breakers.
    pub admin: Address,
    /// Maximum capacity of the ring buffer (e.g., 12 to 48 slots).
    pub capacity: u32,
    /// Maximum staleness allowed (in seconds) before circuit breaker halts pricing.
    pub max_staleness_seconds: u64,
    /// Maximum single-update price deviation allowed in Basis Points (BPS). 1 BPS = 0.01%. 5000 = 50%.
    pub max_price_deviation_bps: u32,
    /// Minimum time interval (in seconds) required between successive price updates.
    pub min_update_interval: u64,
}

/// Ring buffer metadata tracking write head and active observation count.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RingBufferState {
    /// Next index in storage to overwrite (0 <= head < capacity).
    pub head: u32,
    /// Current number of valid observations stored (0 <= count <= capacity).
    pub count: u32,
}

/// Status of an oracle feed.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum OracleStatus {
    Active,
    CircuitBroken,
}

/// Data keys for storage.
#[contracttype]
pub enum TwapDataKey {
    Config(Symbol),
    RingBufferState(Symbol),
    Observation(Symbol, u32),
    Status(Symbol),
}

#[contract]
pub struct TwapOracle;

#[contractimpl]
impl TwapOracle {
    /// Initializes a new TWAP oracle price feed for a specified asset.
    pub fn initialize_asset(
        env: Env,
        asset: Symbol,
        admin: Address,
        capacity: u32,
        max_staleness_seconds: u64,
        max_price_deviation_bps: u32,
        min_update_interval: u64,
    ) {
        let config_key = TwapDataKey::Config(asset.clone());
        if env.storage().instance().has(&config_key) {
            panic_with_error!(env, TwapError::AlreadyInitialized);
        }

        if capacity == 0 || capacity > 100 {
            panic_with_error!(env, TwapError::InvalidCapacity);
        }

        admin.require_auth();

        let config = OracleConfig {
            admin,
            capacity,
            max_staleness_seconds,
            max_price_deviation_bps,
            min_update_interval,
        };

        let state = RingBufferState { head: 0, count: 0 };

        env.storage().instance().set(&config_key, &config);
        env.storage()
            .instance()
            .set(&TwapDataKey::RingBufferState(asset.clone()), &state);
        env.storage()
            .instance()
            .set(&TwapDataKey::Status(asset.clone()), &OracleStatus::Active);
    }

    /// Records a new spot price observation for the asset feed into the ring buffer.
    pub fn update_price(env: Env, asset: Symbol, price: i128) {
        let config_key = TwapDataKey::Config(asset.clone());
        let config: OracleConfig = match env.storage().instance().get(&config_key) {
            Some(cfg) => cfg,
            None => panic_with_error!(env, TwapError::NotInitialized),
        };

        config.admin.require_auth();

        if price <= 0 {
            panic_with_error!(env, TwapError::InvalidPrice);
        }

        // Check if circuit breaker is active
        let status_key = TwapDataKey::Status(asset.clone());
        let status: OracleStatus = env
            .storage()
            .instance()
            .get(&status_key)
            .unwrap_or(OracleStatus::CircuitBroken);

        if status == OracleStatus::CircuitBroken {
            panic_with_error!(env, TwapError::CircuitBroken);
        }

        let state_key = TwapDataKey::RingBufferState(asset.clone());
        let mut state: RingBufferState = env
            .storage()
            .instance()
            .get(&state_key)
            .unwrap_or_else(|| panic_with_error!(env, TwapError::NotInitialized));

        let current_time = env.ledger().timestamp();

        let mut cumulative_price: i128 = 0;

        if state.count > 0 {
            // Find the most recent observation index
            let last_idx = if state.head == 0 {
                config.capacity - 1
            } else {
                state.head - 1
            };

            let last_obs_key = TwapDataKey::Observation(asset.clone(), last_idx);
            let last_obs: PriceObservation = env
                .storage()
                .instance()
                .get(&last_obs_key)
                .unwrap_or_else(|| panic_with_error!(env, TwapError::NotInitialized));

            if current_time <= last_obs.timestamp {
                panic_with_error!(env, TwapError::InvalidTimeDelta);
            }

            let time_delta = current_time - last_obs.timestamp;

            if time_delta < config.min_update_interval {
                panic_with_error!(env, TwapError::InvalidTimeDelta);
            }

            // Check single-update price deviation limit (flash loan manipulation protection)
            if config.max_price_deviation_bps > 0 {
                let diff = if price > last_obs.price {
                    price - last_obs.price
                } else {
                    last_obs.price - price
                };

                let deviation_bps = diff
                    .checked_mul(10000)
                    .unwrap_or_else(|| panic_with_error!(env, TwapError::PriceDeviationExceeded))
                    / last_obs.price;

                if deviation_bps > config.max_price_deviation_bps as i128 {
                    // Trip circuit breaker
                    env.storage()
                        .instance()
                        .set(&status_key, &OracleStatus::CircuitBroken);
                    panic_with_error!(env, TwapError::PriceDeviationExceeded);
                }
            }

            // Cumulative price tick = C_last + (P_last * time_delta)
            let tick_inc = (last_obs.price)
                .checked_mul(time_delta as i128)
                .unwrap_or_else(|| panic_with_error!(env, TwapError::InvalidPrice));

            cumulative_price = last_obs
                .cumulative_price
                .checked_add(tick_inc)
                .unwrap_or_else(|| panic_with_error!(env, TwapError::InvalidPrice));
        }

        // Store observation at state.head
        let new_obs = PriceObservation {
            timestamp: current_time,
            price,
            cumulative_price,
        };

        let obs_key = TwapDataKey::Observation(asset.clone(), state.head);
        env.storage().instance().set(&obs_key, &new_obs);

        // Advance ring buffer head & count
        state.head = (state.head + 1) % config.capacity;
        if state.count < config.capacity {
            state.count += 1;
        }

        env.storage().instance().set(&state_key, &state);
    }

    /// Computes the Time-Weighted Average Price (TWAP) over the specified window (in seconds).
    pub fn get_twap(env: Env, asset: Symbol, window_seconds: u64) -> i128 {
        if window_seconds == 0 {
            panic_with_error!(env, TwapError::InvalidWindow);
        }

        let config_key = TwapDataKey::Config(asset.clone());
        let config: OracleConfig = match env.storage().instance().get(&config_key) {
            Some(cfg) => cfg,
            None => panic_with_error!(env, TwapError::NotInitialized),
        };

        // Check circuit breaker status
        let status_key = TwapDataKey::Status(asset.clone());
        let status: OracleStatus = env
            .storage()
            .instance()
            .get(&status_key)
            .unwrap_or(OracleStatus::CircuitBroken);

        if status == OracleStatus::CircuitBroken {
            panic_with_error!(env, TwapError::CircuitBroken);
        }

        let state_key = TwapDataKey::RingBufferState(asset.clone());
        let state: RingBufferState = env
            .storage()
            .instance()
            .get(&state_key)
            .unwrap_or_else(|| panic_with_error!(env, TwapError::NotInitialized));

        if state.count < 2 {
            panic_with_error!(env, TwapError::InsufficientObservations);
        }

        let current_time = env.ledger().timestamp();

        // Get the latest observation index
        let newest_idx = if state.head == 0 {
            config.capacity - 1
        } else {
            state.head - 1
        };

        let newest_obs: PriceObservation = env
            .storage()
            .instance()
            .get(&TwapDataKey::Observation(asset.clone(), newest_idx))
            .unwrap_or_else(|| panic_with_error!(env, TwapError::NotInitialized));

        // Check staleness circuit breaker
        if current_time.saturating_sub(newest_obs.timestamp) > config.max_staleness_seconds {
            // Trip circuit breaker on stale feed
            env.storage()
                .instance()
                .set(&status_key, &OracleStatus::CircuitBroken);
            panic_with_error!(env, TwapError::StalePriceData);
        }

        // Find the observation closest to or at least window_seconds ago.
        let target_timestamp = newest_obs.timestamp.saturating_sub(window_seconds);

        let mut oldest_obs = newest_obs.clone();

        for i in 0..state.count {
            let idx = (newest_idx + config.capacity - i) % config.capacity;
            let obs: PriceObservation = env
                .storage()
                .instance()
                .get(&TwapDataKey::Observation(asset.clone(), idx))
                .unwrap_or_else(|| panic_with_error!(env, TwapError::NotInitialized));

            oldest_obs = obs.clone();
            if obs.timestamp <= target_timestamp {
                break;
            }
        }

        let elapsed_since_last = current_time - newest_obs.timestamp;
        let current_cumulative_price = newest_obs.cumulative_price + (newest_obs.price * elapsed_since_last as i128);
        let total_elapsed = current_time - oldest_obs.timestamp;

        if total_elapsed == 0 {
            panic_with_error!(env, TwapError::InvalidTimeDelta);
        }

        let delta_cumulative = current_cumulative_price - oldest_obs.cumulative_price;
        delta_cumulative / (total_elapsed as i128)
    }

    /// Returns the most recent spot price observation for the asset.
    pub fn get_spot_price(env: Env, asset: Symbol) -> PriceObservation {
        let config_key = TwapDataKey::Config(asset.clone());
        let config: OracleConfig = match env.storage().instance().get(&config_key) {
            Some(cfg) => cfg,
            None => panic_with_error!(env, TwapError::NotInitialized),
        };

        let state_key = TwapDataKey::RingBufferState(asset.clone());
        let state: RingBufferState = env
            .storage()
            .instance()
            .get(&state_key)
            .unwrap_or_else(|| panic_with_error!(env, TwapError::NotInitialized));

        if state.count == 0 {
            panic_with_error!(env, TwapError::InsufficientObservations);
        }

        let newest_idx = if state.head == 0 {
            config.capacity - 1
        } else {
            state.head - 1
        };

        env.storage()
            .instance()
            .get(&TwapDataKey::Observation(asset, newest_idx))
            .unwrap_or_else(|| panic_with_error!(env, TwapError::NotInitialized))
    }

    /// Trips the circuit breaker manually (Admin only).
    pub fn trip_circuit_breaker(env: Env, asset: Symbol) {
        let config_key = TwapDataKey::Config(asset.clone());
        let config: OracleConfig = match env.storage().instance().get(&config_key) {
            Some(cfg) => cfg,
            None => panic_with_error!(env, TwapError::NotInitialized),
        };

        config.admin.require_auth();

        env.storage()
            .instance()
            .set(&TwapDataKey::Status(asset), &OracleStatus::CircuitBroken);
    }

    /// Resets the circuit breaker back to Active (Admin only).
    pub fn reset_circuit_breaker(env: Env, asset: Symbol) {
        let config_key = TwapDataKey::Config(asset.clone());
        let config: OracleConfig = match env.storage().instance().get(&config_key) {
            Some(cfg) => cfg,
            None => panic_with_error!(env, TwapError::NotInitialized),
        };

        config.admin.require_auth();

        env.storage()
            .instance()
            .set(&TwapDataKey::Status(asset), &OracleStatus::Active);
    }

    /// Returns current OracleStatus for asset.
    pub fn get_oracle_status(env: Env, asset: Symbol) -> OracleStatus {
        let status_key = TwapDataKey::Status(asset);
        env.storage()
            .instance()
            .get(&status_key)
            .unwrap_or(OracleStatus::CircuitBroken)
    }

    /// Returns current RingBufferState for asset.
    pub fn get_ring_buffer_state(env: Env, asset: Symbol) -> RingBufferState {
        let state_key = TwapDataKey::RingBufferState(asset);
        env.storage()
            .instance()
            .get(&state_key)
            .unwrap_or_else(|| panic_with_error!(env, TwapError::NotInitialized))
    }

    /// Returns current OracleConfig for asset.
    pub fn get_config(env: Env, asset: Symbol) -> OracleConfig {
        let config_key = TwapDataKey::Config(asset);
        env.storage()
            .instance()
            .get(&config_key)
            .unwrap_or_else(|| panic_with_error!(env, TwapError::NotInitialized))
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::{Address as _, Ledger as _};
    use soroban_sdk::{symbol_short, Address, Env};

    struct TestSetup {
        env: Env,
        admin: Address,
        client: TwapOracleClient<'static>,
        asset: Symbol,
    }

    fn setup() -> TestSetup {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let contract_id = env.register(TwapOracle, ());
        let client = TwapOracleClient::new(&env, &contract_id);
        let asset = symbol_short!("XLM");

        env.ledger().set_timestamp(1000);

        TestSetup {
            env,
            admin,
            client,
            asset,
        }
    }

    #[test]
    fn test_initialize_asset_and_config() {
        let s = setup();
        s.client.initialize_asset(
            &s.asset,
            &s.admin,
            &12,   // capacity
            &3600, // max staleness
            &5000, // max 50% single update deviation (5000 bps)
            &10,   // min 10s update interval
        );

        let config = s.client.get_config(&s.asset);
        assert_eq!(config.admin, s.admin);
        assert_eq!(config.capacity, 12);
        assert_eq!(config.max_staleness_seconds, 3600);
        assert_eq!(config.max_price_deviation_bps, 5000);
        assert_eq!(config.min_update_interval, 10);

        let state = s.client.get_ring_buffer_state(&s.asset);
        assert_eq!(state.head, 0);
        assert_eq!(state.count, 0);

        let status = s.client.get_oracle_status(&s.asset);
        assert_eq!(status, OracleStatus::Active);
    }

    #[test]
    fn test_update_price_and_ring_buffer_rollover() {
        let s = setup();
        s.client.initialize_asset(
            &s.asset,
            &s.admin,
            &5,    // capacity 5
            &3600,
            &5000,
            &10,
        );

        // Push 7 price updates, testing ring buffer rollover
        for i in 0..7 {
            s.env.ledger().set_timestamp(1000 + (i as u64 + 1) * 20);
            s.client.update_price(&s.asset, &(100 + i as i128 * 2));
        }

        let state = s.client.get_ring_buffer_state(&s.asset);
        assert_eq!(state.count, 5); // Capped at capacity 5
        assert_eq!(state.head, 2);  // 7 % 5 = 2

        let spot = s.client.get_spot_price(&s.asset);
        assert_eq!(spot.price, 112);
        assert_eq!(spot.timestamp, 1140);
    }

    #[test]
    fn test_twap_calculation_accuracy() {
        let s = setup();
        s.client.initialize_asset(
            &s.asset,
            &s.admin,
            &10,
            &3600,
            &0, // disable deviation check for test
            &10,
        );

        // T=1000: P=100
        s.env.ledger().set_timestamp(1000);
        s.client.update_price(&s.asset, &100);

        // T=1100: P=120 (delta_t = 100s, accum = 100 * 100 = 10_000)
        s.env.ledger().set_timestamp(1100);
        s.client.update_price(&s.asset, &120);

        // T=1200: P=140 (delta_t = 100s, accum = 10_000 + 120 * 100 = 22_000)
        s.env.ledger().set_timestamp(1200);
        s.client.update_price(&s.asset, &120);

        // Query TWAP at T=1200 over 200s window (from T=1000 to T=1200)
        // delta_C = 22_000, delta_T = 200 => TWAP = 110
        let twap = s.client.get_twap(&s.asset, &200);
        assert_eq!(twap, 110);
    }

    #[test]
    fn test_single_block_flash_loan_manipulation_resistance() {
        let s = setup();
        s.client.initialize_asset(
            &s.asset,
            &s.admin,
            &10,
            &3600,
            &0, // bypass deviation check to measure raw TWAP resistance
            &0,
        );

        // T=1000: P=100
        s.env.ledger().set_timestamp(1000);
        s.client.update_price(&s.asset, &100);

        // T=1600 (600s steady market): P=100. Accum = 100 * 600 = 60,000
        s.env.ledger().set_timestamp(1600);
        s.client.update_price(&s.asset, &100);

        // T=1601 (Flash loan manipulation spike to 10,000 for 1 second)
        s.env.ledger().set_timestamp(1601);
        s.client.update_price(&s.asset, &10_000);

        // Compute TWAP over 600s window
        // Total accum = 60,000 + 10,000 * 1 = 70,000 over 601s => TWAP ≈ 116
        // Compare spot price 10,000 (100x spike) vs TWAP 116 (smooth, resistant)
        let twap = s.client.get_twap(&s.asset, &600);
        assert!(twap < 120);
        assert!(twap >= 110);
    }

    #[test]
    #[should_panic(expected = "HostError: Error(Contract, #107)")]
    fn test_price_deviation_circuit_breaker() {
        let s = setup();
        s.client.initialize_asset(
            &s.asset,
            &s.admin,
            &10,
            &3600,
            &2000, // Max 20% deviation limit (2000 BPS)
            &10,
        );

        s.env.ledger().set_timestamp(1000);
        s.client.update_price(&s.asset, &100);

        s.env.ledger().set_timestamp(1020);
        // 100 -> 150 is a 50% jump (> 20% max allowed deviation). Should trip circuit breaker!
        s.client.update_price(&s.asset, &150);
    }

    #[test]
    #[should_panic(expected = "HostError: Error(Contract, #106)")]
    fn test_staleness_circuit_breaker() {
        let s = setup();
        s.client.initialize_asset(
            &s.asset,
            &s.admin,
            &10,
            &300, // Max staleness 300 seconds (5 minutes)
            &5000,
            &10,
        );

        s.env.ledger().set_timestamp(1000);
        s.client.update_price(&s.asset, &100);

        s.env.ledger().set_timestamp(1020);
        s.client.update_price(&s.asset, &105);

        // Fast forward 400 seconds (greater than 300s staleness limit)
        s.env.ledger().set_timestamp(1420);

        // Should trip circuit breaker on stale feed
        s.client.get_twap(&s.asset, &100);
    }

    #[test]
    fn test_admin_trip_and_reset_circuit_breaker() {
        let s = setup();
        s.client.initialize_asset(
            &s.asset,
            &s.admin,
            &10,
            &3600,
            &5000,
            &10,
        );

        assert_eq!(s.client.get_oracle_status(&s.asset), OracleStatus::Active);

        // Admin trips breaker
        s.client.trip_circuit_breaker(&s.asset);
        assert_eq!(s.client.get_oracle_status(&s.asset), OracleStatus::CircuitBroken);

        // Admin resets breaker
        s.client.reset_circuit_breaker(&s.asset);
        assert_eq!(s.client.get_oracle_status(&s.asset), OracleStatus::Active);
    }
}


//! Time-Weighted Average Price (TWAP) oracle with flash-volatility circuit breakers.
//!
//! Addresses issue #322:
//! - Historical price ticks in a dynamic ring buffer (config/state in instance storage,
//!   rolling observations in temporary storage with TTL bumps to minimise rent).
//! - Freezes conversions when price moves more than 15% within a 10-ledger window.
//! - TWAP over multi-ledger history for XLM ↔ stable conversion fairness.

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, panic_with_error, Address, Env, Symbol,
};

/// Default flash-volatility threshold: 15% = 1500 basis points.
pub const DEFAULT_FLASH_DEVIATION_BPS: u32 = 1_500;
/// Default ledger window for the flash-volatility circuit breaker.
pub const DEFAULT_FLASH_LEDGER_WINDOW: u32 = 10;

/// Temporary-entry TTL: extend when remaining lifetime drops below this many ledgers.
const TEMP_LIFETIME_THRESHOLD: u32 = 50;
/// Temporary-entry TTL: bump rolling observations out to this many ledgers (~cheap rent).
const TEMP_BUMP_AMOUNT: u32 = 200;
/// Instance TTL: extend when remaining lifetime drops below this many ledgers (~1 day).
const INSTANCE_LIFETIME_THRESHOLD: u32 = 17_280;
/// Instance TTL: bump config/state out to ~7 days.
const INSTANCE_BUMP_AMOUNT: u32 = 120_960;

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
    /// Price swung more than the flash threshold inside the ledger window.
    FlashVolatility = 113,
    /// Conversions / payouts are frozen while the circuit breaker is open.
    ConversionsFrozen = 114,
    InvalidCircuitParams = 115,
}

/// Historical price observation saved in the ring buffer.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PriceObservation {
    /// Timestamp of ledger (in seconds).
    pub timestamp: u64,
    /// Ledger sequence when the tick was recorded (for multi-ledger windows).
    pub ledger: u32,
    /// Instantaneous spot price tick recorded at this ledger.
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
    /// Maximum capacity of the ring buffer (dynamic overwrite when full).
    pub capacity: u32,
    /// Maximum staleness allowed (in seconds) before circuit breaker halts pricing.
    pub max_staleness_seconds: u64,
    /// Maximum single-update price deviation allowed in basis points (BPS).
    pub max_price_deviation_bps: u32,
    /// Minimum time interval (in seconds) required between successive price updates.
    pub min_update_interval: u64,
    /// Flash-volatility threshold in BPS (issue #322 default: 1500 = 15%).
    pub flash_deviation_bps: u32,
    /// Flash-volatility ledger window (issue #322 default: 10 ledgers).
    pub flash_ledger_window: u32,
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
    ///
    /// Defaults flash circuit breaker to 15% / 10 ledgers when callers pass
    /// `flash_deviation_bps == 0` or `flash_ledger_window == 0`.
    pub fn initialize_asset(
        env: Env,
        asset: Symbol,
        admin: Address,
        capacity: u32,
        max_staleness_seconds: u64,
        max_price_deviation_bps: u32,
        min_update_interval: u64,
        flash_deviation_bps: u32,
        flash_ledger_window: u32,
    ) {
        let config_key = TwapDataKey::Config(asset.clone());
        if env.storage().instance().has(&config_key) {
            panic_with_error!(env, TwapError::AlreadyInitialized);
        }

        if capacity == 0 || capacity > 100 {
            panic_with_error!(env, TwapError::InvalidCapacity);
        }

        admin.require_auth();

        let flash_bps = if flash_deviation_bps == 0 {
            DEFAULT_FLASH_DEVIATION_BPS
        } else {
            flash_deviation_bps
        };
        let flash_window = if flash_ledger_window == 0 {
            DEFAULT_FLASH_LEDGER_WINDOW
        } else {
            flash_ledger_window
        };

        if flash_bps > 10_000 || flash_window == 0 {
            panic_with_error!(env, TwapError::InvalidCircuitParams);
        }

        let config = OracleConfig {
            admin,
            capacity,
            max_staleness_seconds,
            max_price_deviation_bps,
            min_update_interval,
            flash_deviation_bps: flash_bps,
            flash_ledger_window: flash_window,
        };

        let state = RingBufferState { head: 0, count: 0 };

        env.storage().instance().set(&config_key, &config);
        env.storage()
            .instance()
            .set(&TwapDataKey::RingBufferState(asset.clone()), &state);
        env.storage()
            .instance()
            .set(&TwapDataKey::Status(asset.clone()), &OracleStatus::Active);

        Self::bump_instance_ttl(&env);
    }

    /// Records a new spot price observation into the dynamic ring buffer.
    ///
    /// Rolling ticks live in temporary storage with short TTL extensions so
    /// rent stays low as older slots are overwritten.
    pub fn update_price(env: Env, asset: Symbol, price: i128) {
        let config = Self::load_config(&env, &asset);
        config.admin.require_auth();

        if price <= 0 {
            panic_with_error!(env, TwapError::InvalidPrice);
        }

        let status = Self::load_status(&env, &asset);
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
        let current_ledger = env.ledger().sequence();

        let mut cumulative_price: i128 = 0;

        if state.count > 0 {
            let last_idx = Self::newest_index(&state, config.capacity);
            let last_obs = Self::load_observation(&env, &asset, last_idx);

            if current_time <= last_obs.timestamp {
                panic_with_error!(env, TwapError::InvalidTimeDelta);
            }

            let time_delta = current_time - last_obs.timestamp;
            if time_delta < config.min_update_interval {
                panic_with_error!(env, TwapError::InvalidTimeDelta);
            }

            // Single-update deviation guard (legacy / configurable).
            if config.max_price_deviation_bps > 0 {
                let deviation_bps = Self::deviation_bps(price, last_obs.price);
                if deviation_bps > config.max_price_deviation_bps as i128 {
                    Self::trip(&env, &asset);
                    panic_with_error!(env, TwapError::PriceDeviationExceeded);
                }
            }

            // Issue #322: freeze if price changes exceed flash threshold inside N ledgers.
            if Self::flash_volatility_triggered(
                &env,
                &asset,
                &state,
                config.capacity,
                current_ledger,
                price,
                config.flash_deviation_bps,
                config.flash_ledger_window,
            ) {
                Self::trip(&env, &asset);
                panic_with_error!(env, TwapError::FlashVolatility);
            }

            let tick_inc = last_obs
                .price
                .checked_mul(time_delta as i128)
                .unwrap_or_else(|| panic_with_error!(env, TwapError::InvalidPrice));

            cumulative_price = last_obs
                .cumulative_price
                .checked_add(tick_inc)
                .unwrap_or_else(|| panic_with_error!(env, TwapError::InvalidPrice));
        }

        let new_obs = PriceObservation {
            timestamp: current_time,
            ledger: current_ledger,
            price,
            cumulative_price,
        };

        Self::store_observation(&env, &asset, state.head, &new_obs);

        state.head = (state.head + 1) % config.capacity;
        if state.count < config.capacity {
            state.count += 1;
        }

        env.storage().instance().set(&state_key, &state);
        Self::bump_instance_ttl(&env);
    }

    /// Computes TWAP over `window_seconds` of multi-ledger price history.
    /// Halts (freezes conversions) while the circuit breaker is open.
    pub fn get_twap(env: Env, asset: Symbol, window_seconds: u64) -> i128 {
        if window_seconds == 0 {
            panic_with_error!(env, TwapError::InvalidWindow);
        }

        let config = Self::load_config(&env, &asset);
        Self::assert_conversions_live(&env, &asset);

        let state = Self::load_state(&env, &asset);
        if state.count < 2 {
            panic_with_error!(env, TwapError::InsufficientObservations);
        }

        let current_time = env.ledger().timestamp();
        let newest_idx = Self::newest_index(&state, config.capacity);
        let newest_obs = Self::load_observation(&env, &asset, newest_idx);

        if current_time.saturating_sub(newest_obs.timestamp) > config.max_staleness_seconds {
            Self::trip(&env, &asset);
            panic_with_error!(env, TwapError::StalePriceData);
        }

        let target_timestamp = newest_obs.timestamp.saturating_sub(window_seconds);
        let mut oldest_obs = newest_obs.clone();

        for i in 0..state.count {
            let idx = (newest_idx + config.capacity - i) % config.capacity;
            let obs = Self::load_observation(&env, &asset, idx);
            oldest_obs = obs.clone();
            if obs.timestamp <= target_timestamp {
                break;
            }
        }

        let elapsed_since_last = current_time - newest_obs.timestamp;
        let current_cumulative_price =
            newest_obs.cumulative_price + (newest_obs.price * elapsed_since_last as i128);
        let total_elapsed = current_time - oldest_obs.timestamp;

        if total_elapsed == 0 {
            panic_with_error!(env, TwapError::InvalidTimeDelta);
        }

        let delta_cumulative = current_cumulative_price - oldest_obs.cumulative_price;
        Self::bump_instance_ttl(&env);
        delta_cumulative / (total_elapsed as i128)
    }

    /// Returns whether XLM/stable conversions (payouts) may proceed.
    pub fn conversions_allowed(env: Env, asset: Symbol) -> bool {
        if !env
            .storage()
            .instance()
            .has(&TwapDataKey::Config(asset.clone()))
        {
            return false;
        }
        Self::load_status(&env, &asset) == OracleStatus::Active
    }

    /// Explicit conversion gate — panics with `ConversionsFrozen` when tripped.
    pub fn assert_conversion_allowed(env: Env, asset: Symbol) {
        Self::assert_conversions_live(&env, &asset);
    }

    /// Returns the most recent spot price observation for the asset.
    pub fn get_spot_price(env: Env, asset: Symbol) -> PriceObservation {
        let config = Self::load_config(&env, &asset);
        let state = Self::load_state(&env, &asset);

        if state.count == 0 {
            panic_with_error!(env, TwapError::InsufficientObservations);
        }

        let newest_idx = Self::newest_index(&state, config.capacity);
        Self::load_observation(&env, &asset, newest_idx)
    }

    /// Trips the circuit breaker manually (Admin only) — freezes conversions.
    pub fn trip_circuit_breaker(env: Env, asset: Symbol) {
        let config = Self::load_config(&env, &asset);
        config.admin.require_auth();
        Self::trip(&env, &asset);
    }

    /// Resets the circuit breaker back to Active (Admin only).
    pub fn reset_circuit_breaker(env: Env, asset: Symbol) {
        let config = Self::load_config(&env, &asset);
        config.admin.require_auth();

        env.storage()
            .instance()
            .set(&TwapDataKey::Status(asset), &OracleStatus::Active);
        Self::bump_instance_ttl(&env);
    }

    /// Returns current OracleStatus for asset.
    pub fn get_oracle_status(env: Env, asset: Symbol) -> OracleStatus {
        Self::load_status(&env, &asset)
    }

    /// Returns current RingBufferState for asset.
    pub fn get_ring_buffer_state(env: Env, asset: Symbol) -> RingBufferState {
        Self::load_state(&env, &asset)
    }

    /// Returns current OracleConfig for asset.
    pub fn get_config(env: Env, asset: Symbol) -> OracleConfig {
        Self::load_config(&env, &asset)
    }
}

impl TwapOracle {
    fn bump_instance_ttl(env: &Env) {
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
    }

    fn bump_observation_ttl(env: &Env, key: &TwapDataKey) {
        // Temporary entries are cheap; bump only while the rolling slot is live.
        if env.storage().temporary().has(key) {
            env.storage().temporary().extend_ttl(
                key,
                TEMP_LIFETIME_THRESHOLD,
                TEMP_BUMP_AMOUNT,
            );
        }
    }

    fn store_observation(env: &Env, asset: &Symbol, index: u32, obs: &PriceObservation) {
        let key = TwapDataKey::Observation(asset.clone(), index);
        // Rolling ticks in temporary storage → lower rent than persistent.
        env.storage().temporary().set(&key, obs);
        env.storage()
            .temporary()
            .extend_ttl(&key, TEMP_LIFETIME_THRESHOLD, TEMP_BUMP_AMOUNT);
    }

    fn load_observation(env: &Env, asset: &Symbol, index: u32) -> PriceObservation {
        let key = TwapDataKey::Observation(asset.clone(), index);
        let obs: PriceObservation = env
            .storage()
            .temporary()
            .get(&key)
            .unwrap_or_else(|| panic_with_error!(env, TwapError::InsufficientObservations));
        Self::bump_observation_ttl(env, &key);
        obs
    }

    fn load_config(env: &Env, asset: &Symbol) -> OracleConfig {
        env.storage()
            .instance()
            .get(&TwapDataKey::Config(asset.clone()))
            .unwrap_or_else(|| panic_with_error!(env, TwapError::NotInitialized))
    }

    fn load_state(env: &Env, asset: &Symbol) -> RingBufferState {
        env.storage()
            .instance()
            .get(&TwapDataKey::RingBufferState(asset.clone()))
            .unwrap_or_else(|| panic_with_error!(env, TwapError::NotInitialized))
    }

    fn load_status(env: &Env, asset: &Symbol) -> OracleStatus {
        env.storage()
            .instance()
            .get(&TwapDataKey::Status(asset.clone()))
            .unwrap_or(OracleStatus::CircuitBroken)
    }

    fn trip(env: &Env, asset: &Symbol) {
        env.storage()
            .instance()
            .set(&TwapDataKey::Status(asset.clone()), &OracleStatus::CircuitBroken);
        Self::bump_instance_ttl(env);
    }

    fn assert_conversions_live(env: &Env, asset: &Symbol) {
        if Self::load_status(env, asset) != OracleStatus::Active {
            panic_with_error!(env, TwapError::ConversionsFrozen);
        }
    }

    fn newest_index(state: &RingBufferState, capacity: u32) -> u32 {
        if state.head == 0 {
            capacity - 1
        } else {
            state.head - 1
        }
    }

    fn deviation_bps(new_price: i128, old_price: i128) -> i128 {
        if old_price <= 0 {
            return i128::MAX;
        }
        let diff = if new_price > old_price {
            new_price - old_price
        } else {
            old_price - new_price
        };
        diff.saturating_mul(10_000) / old_price
    }

    /// Returns true when `price` diverges more than `flash_deviation_bps` from any
    /// observation recorded inside the last `flash_ledger_window` ledgers.
    fn flash_volatility_triggered(
        env: &Env,
        asset: &Symbol,
        state: &RingBufferState,
        capacity: u32,
        current_ledger: u32,
        price: i128,
        flash_deviation_bps: u32,
        flash_ledger_window: u32,
    ) -> bool {
        if flash_deviation_bps == 0 || state.count == 0 {
            return false;
        }

        let newest_idx = Self::newest_index(state, capacity);
        let window_start = current_ledger.saturating_sub(flash_ledger_window);

        for i in 0..state.count {
            let idx = (newest_idx + capacity - i) % capacity;
            let obs = Self::load_observation(env, asset, idx);

            // Observations older than the ledger window are ignored.
            if obs.ledger < window_start {
                break;
            }

            if Self::deviation_bps(price, obs.price) > flash_deviation_bps as i128 {
                return true;
            }
        }

        false
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

        env.ledger().set_timestamp(1_000);
        env.ledger().set_sequence_number(1_000);

        TestSetup {
            env,
            admin,
            client,
            asset,
        }
    }

    fn init_default(s: &TestSetup) {
        // flash params 0,0 → defaults to 15% / 10 ledgers
        s.client.initialize_asset(
            &s.asset,
            &s.admin,
            &12,
            &3_600,
            &0, // disable single-update BPS so flash window is the focus
            &1,
            &0,
            &0,
        );
    }

    #[test]
    fn test_initialize_defaults_to_15pct_over_10_ledgers() {
        let s = setup();
        init_default(&s);

        let config = s.client.get_config(&s.asset);
        assert_eq!(config.flash_deviation_bps, DEFAULT_FLASH_DEVIATION_BPS);
        assert_eq!(config.flash_ledger_window, DEFAULT_FLASH_LEDGER_WINDOW);
        assert_eq!(config.capacity, 12);
        assert_eq!(s.client.get_oracle_status(&s.asset), OracleStatus::Active);
        assert!(s.client.conversions_allowed(&s.asset));
    }

    #[test]
    fn test_update_price_and_ring_buffer_rollover() {
        let s = setup();
        s.client.initialize_asset(
            &s.asset,
            &s.admin,
            &5,
            &3_600,
            &10_000,
            &1,
            &10_000,
            &10,
        );

        for i in 0..7u32 {
            s.env.ledger().set_timestamp(1_000 + (i as u64 + 1) * 20);
            s.env.ledger().set_sequence_number(1_000 + i + 1);
            // Keep moves tiny so flash breaker does not trip during rollover test.
            s.client
                .update_price(&s.asset, &(100 + i as i128));
        }

        let state = s.client.get_ring_buffer_state(&s.asset);
        assert_eq!(state.count, 5);
        assert_eq!(state.head, 2);

        let spot = s.client.get_spot_price(&s.asset);
        assert_eq!(spot.price, 106);
        assert_eq!(spot.ledger, 1_007);
    }

    #[test]
    fn test_twap_reflects_multi_ledger_history() {
        let s = setup();
        s.client.initialize_asset(
            &s.asset,
            &s.admin,
            &10,
            &3_600,
            &0,
            &1,
            &10_000,
            &50,
        );

        s.env.ledger().set_timestamp(1_000);
        s.env.ledger().set_sequence_number(1_000);
        s.client.update_price(&s.asset, &100);

        s.env.ledger().set_timestamp(1_100);
        s.env.ledger().set_sequence_number(1_020);
        s.client.update_price(&s.asset, &120);

        s.env.ledger().set_timestamp(1_200);
        s.env.ledger().set_sequence_number(1_040);
        s.client.update_price(&s.asset, &120);

        // Window covers T=1000→1200: (100*100 + 120*100) / 200 = 110
        let twap = s.client.get_twap(&s.asset, &200);
        assert_eq!(twap, 110);
    }

    #[test]
    #[should_panic(expected = "HostError: Error(Contract, #113)")]
    fn test_circuit_breaker_trips_on_15pct_within_10_ledgers() {
        let s = setup();
        init_default(&s);

        s.env.ledger().set_timestamp(1_000);
        s.env.ledger().set_sequence_number(1_000);
        s.client.update_price(&s.asset, &100);

        // +5 ledgers, +16% move (>15%) → FlashVolatility (#113)
        s.env.ledger().set_timestamp(1_025);
        s.env.ledger().set_sequence_number(1_005);
        s.client.update_price(&s.asset, &116);
    }

    #[test]
    fn test_flash_volatility_allows_move_outside_10_ledger_window() {
        let s = setup();
        init_default(&s);

        s.env.ledger().set_timestamp(1_000);
        s.env.ledger().set_sequence_number(1_000);
        s.client.update_price(&s.asset, &100);

        // 11 ledgers later — outside the 10-ledger flash window; large move OK.
        s.env.ledger().set_timestamp(1_055);
        s.env.ledger().set_sequence_number(1_011);
        s.client.update_price(&s.asset, &130);

        assert_eq!(s.client.get_oracle_status(&s.asset), OracleStatus::Active);
        assert!(s.client.conversions_allowed(&s.asset));
    }

    #[test]
    #[should_panic(expected = "HostError: Error(Contract, #113)")]
    fn test_simulated_flash_loan_trips_breaker() {
        let s = setup();
        init_default(&s);

        s.env.ledger().set_timestamp(1_000);
        s.env.ledger().set_sequence_number(1_000);
        s.client.update_price(&s.asset, &100);

        s.env.ledger().set_timestamp(1_010);
        s.env.ledger().set_sequence_number(1_002);
        s.client.update_price(&s.asset, &101);

        // Simulated flash spike (+~98%) inside the 10-ledger window.
        s.env.ledger().set_timestamp(1_015);
        s.env.ledger().set_sequence_number(1_004);
        s.client.update_price(&s.asset, &200);
    }

    #[test]
    fn test_conversions_frozen_after_manual_trip() {
        let s = setup();
        init_default(&s);

        s.env.ledger().set_timestamp(1_000);
        s.env.ledger().set_sequence_number(1_000);
        s.client.update_price(&s.asset, &100);

        s.client.trip_circuit_breaker(&s.asset);
        assert_eq!(
            s.client.get_oracle_status(&s.asset),
            OracleStatus::CircuitBroken
        );
        assert!(!s.client.conversions_allowed(&s.asset));
    }

    #[test]
    #[should_panic(expected = "HostError: Error(Contract, #114)")]
    fn test_get_twap_freezes_while_circuit_broken() {
        let s = setup();
        s.client.initialize_asset(
            &s.asset,
            &s.admin,
            &10,
            &3_600,
            &0,
            &1,
            &10_000,
            &50,
        );

        s.env.ledger().set_timestamp(1_000);
        s.env.ledger().set_sequence_number(1_000);
        s.client.update_price(&s.asset, &100);

        s.env.ledger().set_timestamp(1_100);
        s.env.ledger().set_sequence_number(1_020);
        s.client.update_price(&s.asset, &110);

        s.client.trip_circuit_breaker(&s.asset);
        // ConversionsFrozen (#114)
        let _ = s.client.get_twap(&s.asset, &100);
    }

    #[test]
    #[should_panic(expected = "HostError: Error(Contract, #107)")]
    fn test_single_update_price_deviation_circuit_breaker() {
        let s = setup();
        s.client.initialize_asset(
            &s.asset,
            &s.admin,
            &10,
            &3_600,
            &2_000, // 20% single-update cap
            &1,
            &10_000,
            &50,
        );

        s.env.ledger().set_timestamp(1_000);
        s.env.ledger().set_sequence_number(1_000);
        s.client.update_price(&s.asset, &100);

        s.env.ledger().set_timestamp(1_020);
        s.env.ledger().set_sequence_number(1_050); // outside flash window
        s.client.update_price(&s.asset, &150); // 50% > 20%
    }

    #[test]
    #[should_panic(expected = "HostError: Error(Contract, #106)")]
    fn test_staleness_circuit_breaker() {
        let s = setup();
        s.client.initialize_asset(
            &s.asset,
            &s.admin,
            &10,
            &300,
            &0,
            &1,
            &10_000,
            &50,
        );

        s.env.ledger().set_timestamp(1_000);
        s.env.ledger().set_sequence_number(1_000);
        s.client.update_price(&s.asset, &100);

        s.env.ledger().set_timestamp(1_020);
        s.env.ledger().set_sequence_number(1_004);
        s.client.update_price(&s.asset, &105);

        s.env.ledger().set_timestamp(1_420);
        s.env.ledger().set_sequence_number(1_100);
        let _ = s.client.get_twap(&s.asset, &100);
    }

    #[test]
    fn test_admin_trip_and_reset_circuit_breaker() {
        let s = setup();
        init_default(&s);

        assert_eq!(s.client.get_oracle_status(&s.asset), OracleStatus::Active);

        s.client.trip_circuit_breaker(&s.asset);
        assert_eq!(
            s.client.get_oracle_status(&s.asset),
            OracleStatus::CircuitBroken
        );
        assert!(!s.client.conversions_allowed(&s.asset));

        s.client.reset_circuit_breaker(&s.asset);
        assert_eq!(s.client.get_oracle_status(&s.asset), OracleStatus::Active);
        assert!(s.client.conversions_allowed(&s.asset));
    }

    #[test]
    fn test_temporary_ttl_keeps_rolling_observations_readable() {
        let s = setup();
        init_default(&s);

        s.env.ledger().set_timestamp(1_000);
        s.env.ledger().set_sequence_number(1_000);
        s.client.update_price(&s.asset, &100);

        s.env.ledger().set_timestamp(1_020);
        s.env.ledger().set_sequence_number(1_002);
        s.client.update_price(&s.asset, &102);

        // Spot / TWAP still readable after TTL bumps on temporary keys.
        let spot = s.client.get_spot_price(&s.asset);
        assert_eq!(spot.price, 102);
        let twap = s.client.get_twap(&s.asset, &20);
        assert!(twap > 0);
    }
}

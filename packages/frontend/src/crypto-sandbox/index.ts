/**
 * @file index.ts
 * @description Public surface of the off-main-thread crypto-signing sandbox.
 *
 * Consumers (e.g. features that need ephemeral or offline signing) should
 * import from here. The existing Freighter integration in `WalletContext`
 * continues to own user-facing signing — this module is the opt-in
 * alternative used when the key material lives in the sandbox rather than
 * in a browser extension.
 */

export {
  type CryptoSandboxOptions,
  type SandboxKey,
  CryptoSandboxClient,
  getCryptoSandbox,
  hasCryptoSandbox,
} from './crypto-sandbox-client';

export {
  SAB_SIZE,
  MESSAGE_MAX_BYTES,
  PUBLIC_KEY_BYTES,
  SIGNATURE_BYTES,
  PRIVATE_KEY_BYTES,
  STATUS_IDLE,
  STATUS_REQUEST,
  STATUS_PROCESSING,
  STATUS_DONE,
  STATUS_ERROR,
  ERROR_UNKNOWN_HANDLE,
  ERROR_INVALID_MSG_LEN,
  ERROR_SIGNING_FAILED,
  ERROR_WASM_INIT_FAILED,
} from './protocol';

export { CRYPTO_WASM_BYTES, wasmFingerprint } from './wasm-primitives';

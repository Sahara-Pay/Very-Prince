/**
 * @file signing-worker.test.ts
 * @description Integration-style tests for the signing worker's message handler.
 *
 * We import the worker module directly (not via Worker constructor) and exercise
 * the `self.onmessage` handler against the protocol types.
 *
 * Because the worker module calls `self.postMessage` we stub `self` globally.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  SLOT_STATE,
  SLOT_STATUS,
  STATE_SIGN_DONE,
  STATUS_OK,
  STATUS_ERROR,
  CTRL_SAB_BYTES,
  DATA_SAB_BYTES,
  type WorkerOutboundMessage,
} from './signerProtocol';

// ─── Stubs for the worker global scope ───────────────────────────────────────

const postedMessages: WorkerOutboundMessage[] = [];

vi.stubGlobal('self', {
  onmessage: null as ((event: MessageEvent) => void) | null,
  postMessage: (msg: unknown) => {
    postedMessages.push(msg as WorkerOutboundMessage);
  },
});

// Stub Atomics so it works outside a SAB-enabled environment.
vi.stubGlobal('Atomics', {
  store: vi.fn(),
  notify: vi.fn(),
  waitAsync: vi.fn(() => ({ value: Promise.resolve('ok') })),
});

// Stub tweetnacl inside the worker module context.
vi.mock('tweetnacl', () => {
  const fakeSign = (msg: Uint8Array, _sk: Uint8Array) => {
    const sig = new Uint8Array(64);
    sig[0] = msg[0] ?? 0; // Deterministic fake
    return sig;
  };
  fakeSign.detached = fakeSign;
  fakeSign.secretKeyLength = 64;
  fakeSign.publicKeyLength = 32;
  fakeSign.seedLength = 32;
  fakeSign.signatureLength = 64;
  fakeSign.keyPair = { fromSeed: (_s: Uint8Array) => ({ publicKey: new Uint8Array(32), secretKey: new Uint8Array(64) }) };
  return { default: { sign: fakeSign }, __esModule: true };
});

// ─── Load worker module ───────────────────────────────────────────────────────

// Dynamically import AFTER stubs are in place.
async function loadWorker() {
  // Reset module cache to get a fresh instance each time.
  vi.resetModules();
  await import('./signing-worker');
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function dispatch(data: unknown) {
  const event = new MessageEvent('message', { data });
  (self as unknown as { onmessage: (e: MessageEvent) => void }).onmessage(event);
}

function makeSharedBuffers() {
  // In jsdom SharedArrayBuffer might not be available; use ArrayBuffer as fallback.
  const controlBuf =
    typeof SharedArrayBuffer !== 'undefined'
      ? new SharedArrayBuffer(CTRL_SAB_BYTES)
      : new ArrayBuffer(CTRL_SAB_BYTES);
  const dataBuf =
    typeof SharedArrayBuffer !== 'undefined'
      ? new SharedArrayBuffer(DATA_SAB_BYTES)
      : new ArrayBuffer(DATA_SAB_BYTES);
  return { controlBuf, dataBuf };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('signing-worker message handler', () => {
  beforeEach(async () => {
    postedMessages.length = 0;
    await loadWorker();
  });

  it('posts initial ready message on load', () => {
    const readyMsg = postedMessages.find((m) => m.type === 'ready' && m.id === '');
    expect(readyMsg).toBeDefined();
  });

  it('responds to init with ready', async () => {
    const { controlBuf, dataBuf } = makeSharedBuffers();

    dispatch({
      id: 'test-init-1',
      type: 'init',
      controlSab: controlBuf,
      dataSab: dataBuf,
    });

    // Wait a tick for async handling if needed.
    await Promise.resolve();

    const readyMsg = postedMessages.find(
      (m) => m.id === 'test-init-1' && m.type === 'ready',
    );
    expect(readyMsg).toBeDefined();
  });

  it('responds to sign with signed message after init', async () => {
    const { controlBuf, dataBuf } = makeSharedBuffers();
    const dataView = new Uint8Array(dataBuf);
    const message = new Uint8Array([42, 43, 44]);
    dataView.set(message, 0);

    // Init first
    dispatch({
      id: 'test-init-2',
      type: 'init',
      controlSab: controlBuf,
      dataSab: dataBuf,
    });

    await Promise.resolve();

    // Secret key: 64 hex-encoded bytes (all 0x01)
    const secretKeyHex = '01'.repeat(64);

    dispatch({
      id: 'test-sign-1',
      type: 'sign',
      messageLength: message.length,
      secretKeyHex,
    });

    await Promise.resolve();

    const signedMsg = postedMessages.find(
      (m) => m.id === 'test-sign-1' && m.type === 'signed',
    ) as (WorkerOutboundMessage & { type: 'signed' }) | undefined;

    expect(signedMsg).toBeDefined();
    expect(signedMsg?.signatureLength).toBe(64);
  });

  it('posts error message if sign is called before init', async () => {
    dispatch({
      id: 'test-sign-no-init',
      type: 'sign',
      messageLength: 3,
      secretKeyHex: '01'.repeat(64),
    });

    await Promise.resolve();

    const errMsg = postedMessages.find(
      (m) => m.id === 'test-sign-no-init' && m.type === 'error',
    );
    expect(errMsg).toBeDefined();
  });

  it('posts error when messageLength exceeds data buffer', async () => {
    const { controlBuf, dataBuf } = makeSharedBuffers();

    dispatch({ id: 'init-x', type: 'init', controlSab: controlBuf, dataSab: dataBuf });
    await Promise.resolve();

    dispatch({
      id: 'test-big-msg',
      type: 'sign',
      messageLength: DATA_SAB_BYTES + 1,
      secretKeyHex: '01'.repeat(64),
    });

    await Promise.resolve();

    const errMsg = postedMessages.find(
      (m) => m.id === 'test-big-msg' && m.type === 'error',
    );
    expect(errMsg).toBeDefined();
  });

  it('posts error when secretKeyHex has odd length (malformed)', async () => {
    const { controlBuf, dataBuf } = makeSharedBuffers();
    const dataView = new Uint8Array(dataBuf);
    dataView[0] = 0x01;

    dispatch({ id: 'init-y', type: 'init', controlSab: controlBuf, dataSab: dataBuf });
    await Promise.resolve();

    dispatch({
      id: 'test-bad-key',
      type: 'sign',
      messageLength: 1,
      secretKeyHex: 'abc', // Odd length — invalid hex
    });

    await Promise.resolve();

    const errMsg = postedMessages.find(
      (m) => m.id === 'test-bad-key' && m.type === 'error',
    );
    expect(errMsg).toBeDefined();
  });

  it('responds to destroy with ready', async () => {
    dispatch({ id: 'test-destroy-1', type: 'destroy' });
    await Promise.resolve();

    const readyMsg = postedMessages.find(
      (m) => m.id === 'test-destroy-1' && m.type === 'ready',
    );
    expect(readyMsg).toBeDefined();
  });

  it('stores STATUS_OK in control buffer on success', async () => {
    const { controlBuf, dataBuf } = makeSharedBuffers();
    const dataView = new Uint8Array(dataBuf);
    dataView[0] = 99;

    dispatch({ id: 'init-z', type: 'init', controlSab: controlBuf, dataSab: dataBuf });
    await Promise.resolve();

    dispatch({
      id: 'test-status-ok',
      type: 'sign',
      messageLength: 1,
      secretKeyHex: '01'.repeat(64),
    });
    await Promise.resolve();

    const storeCall = (Atomics.store as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[1] === SLOT_STATUS && c[2] === STATUS_OK,
    );
    expect(storeCall).toBeDefined();
  });

  it('stores STATE_SIGN_DONE in control buffer on success', async () => {
    const { controlBuf, dataBuf } = makeSharedBuffers();
    const dataView = new Uint8Array(dataBuf);
    dataView[0] = 1;

    dispatch({ id: 'init-w', type: 'init', controlSab: controlBuf, dataSab: dataBuf });
    await Promise.resolve();

    dispatch({
      id: 'test-state-done',
      type: 'sign',
      messageLength: 1,
      secretKeyHex: '01'.repeat(64),
    });
    await Promise.resolve();

    const storeCall = (Atomics.store as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[1] === SLOT_STATE && c[2] === STATE_SIGN_DONE,
    );
    expect(storeCall).toBeDefined();
  });

  it('stores STATUS_ERROR when signing throws', async () => {
    // Make nacl.sign throw for this test.
    vi.doMock('tweetnacl', () => {
      const badSign = () => { throw new Error('sign exploded'); };
      badSign.detached = badSign;
      badSign.secretKeyLength = 64;
      return { default: { sign: badSign }, __esModule: true };
    });

    const { controlBuf, dataBuf } = makeSharedBuffers();
    const dataView = new Uint8Array(dataBuf);
    dataView[0] = 1;

    dispatch({ id: 'init-err', type: 'init', controlSab: controlBuf, dataSab: dataBuf });
    await Promise.resolve();

    // Valid hex key but tweetnacl is mocked to throw.
    dispatch({
      id: 'test-error-path',
      type: 'sign',
      messageLength: 1,
      secretKeyHex: '01'.repeat(64),
    });
    await Promise.resolve();

    // In the error path the worker posts STATUS_ERROR or 'error' message.
    const statusErrorCall = (Atomics.store as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[1] === SLOT_STATUS && c[2] === STATUS_ERROR,
    );
    const errorMsg = postedMessages.find((m) => m.type === 'error');

    // At least one of these should be set.
    expect(statusErrorCall !== undefined || errorMsg !== undefined).toBe(true);
  });
});

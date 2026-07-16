import { describe, it, expect } from 'vitest';
import trpcClient from '../client';

describe('trpc client', () => {
  it('imports and exposes a client object', () => {
    expect(trpcClient).toBeTruthy();
    expect(typeof trpcClient).toBe('object');
  });
});

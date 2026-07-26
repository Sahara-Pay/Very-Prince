import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { configureTRPC } from '../trpc/server.js';
import { deterministicStringify } from '../trpc/diff.js';

// 1. Mock cache service
const cacheStore: Record<string, string> = {};
vi.mock('../services/cache.js', () => ({
  safeGet: vi.fn(async (key: string) => cacheStore[key] || null),
  safeSet: vi.fn(async (key: string, value: string) => {
    cacheStore[key] = value;
  }),
}));

// 2. Mock stellar service
vi.mock('../services/stellarService.js', () => ({
  stellarService: {
    readOrganizationDetails: vi.fn(),
  },
}));

import { stellarService } from '../services/stellarService.js';
const mockReadOrgDetails = vi.mocked(stellarService.readOrganizationDetails);

describe('tRPC Server Differential Sync Integration', () => {
  let server: any;

  beforeEach(async () => {
    // Clear mock cache store
    for (const key in cacheStore) {
      delete cacheStore[key];
    }
    mockReadOrgDetails.mockReset();
    
    // Create new Fastify server
    server = Fastify();
    await configureTRPC(server);
  });

  it('should return the full payload on the first request and cache the state', async () => {
    const mockOrg = { id: 'org_abc', name: 'ABC Corp', admins: ['addr_1'] };
    mockReadOrgDetails.mockResolvedValueOnce(mockOrg);

    const response = await server.inject({
      method: 'POST',
      url: '/trpc/organization.get',
      payload: { id: 'org_abc' },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload);
    expect(body.status).toBe('full');
    expect(body.data).toEqual(mockOrg);
    expect(body.hash).toBeDefined();

    // Verify state was cached in Redis in deterministic format
    expect(cacheStore[`state_hash:${body.hash}`]).toBe(deterministicStringify(mockOrg));
  });

  it('should return no_change if client provides the matching state hash', async () => {
    const mockOrg = { id: 'org_abc', name: 'ABC Corp', admins: ['addr_1'] };
    mockReadOrgDetails.mockResolvedValueOnce(mockOrg);

    // Compute expected hash of the mockOrg state
    const firstResponse = await server.inject({
      method: 'POST',
      url: '/trpc/organization.get',
      payload: { id: 'org_abc' },
    });
    const firstBody = JSON.parse(firstResponse.payload);
    const stateHash = firstBody.hash;

    // Call it again with matching hash
    mockReadOrgDetails.mockResolvedValueOnce(mockOrg);
    const secondResponse = await server.inject({
      method: 'POST',
      url: '/trpc/organization.get',
      headers: {
        'x-state-hash': stateHash,
      },
      payload: { id: 'org_abc' },
    });

    expect(secondResponse.statusCode).toBe(200);
    const secondBody = JSON.parse(secondResponse.payload);
    expect(secondBody.status).toBe('no_change');
    expect(secondBody.hash).toBe(stateHash);
  });

  it('should return a diff patch if the state has changed and client sends previous hash', async () => {
    const orgV1 = { id: 'org_abc', name: 'ABC Corp', admins: ['addr_1'] };
    mockReadOrgDetails.mockResolvedValueOnce(orgV1);

    // Initial request to get V1 hash and cache it
    const v1Response = await server.inject({
      method: 'POST',
      url: '/trpc/organization.get',
      payload: { id: 'org_abc' },
    });
    const v1Body = JSON.parse(v1Response.payload);
    const v1Hash = v1Body.hash;

    // Mock V2 of organization state
    const orgV2 = { id: 'org_abc', name: 'New ABC Corp', admins: ['addr_1', 'addr_2'] };
    mockReadOrgDetails.mockResolvedValueOnce(orgV2);
    
    // Clear organization caching key in Redis to bypass internal cache
    delete cacheStore['org_details:org_abc'];

    // Request V2 but provide V1 hash in headers
    const v2Response = await server.inject({
      method: 'POST',
      url: '/trpc/organization.get',
      headers: {
        'x-state-hash': v1Hash,
      },
      payload: { id: 'org_abc' },
    });

    expect(v2Response.statusCode).toBe(200);
    const v2Body = JSON.parse(v2Response.payload);
    expect(v2Body.status).toBe('diff');
    expect(v2Body.hash).not.toBe(v1Hash);
    expect(v2Body.patch).toEqual([
      { op: 'replace', path: '/name', value: 'New ABC Corp' },
      { op: 'add', path: '/admins/1', value: 'addr_2' },
    ]);
  });
});

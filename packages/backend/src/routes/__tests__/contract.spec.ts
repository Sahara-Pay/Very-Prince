import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fastify from 'fastify';

type ContractControllerMock = {
  getOrganizations: ReturnType<typeof vi.fn>;
};

vi.mock('../controllers/contractController.ts', () => {
  return {
    contractController: {
      getOrganizations: vi.fn().mockResolvedValue({
        data: [],
        meta: { totalPages: 0, currentPage: 1, totalCount: 0 },
      }),
    },
  };
});

let app: ReturnType<typeof fastify>;
let contractController: ContractControllerMock;

beforeAll(async () => {
  const controllerModule = await import('../controllers/contractController.js');
  contractController = controllerModule.contractController;

  const routeModule = await import('../contract.ts');
  app = fastify();
  app.register(routeModule.contractRoutes, { prefix: '/api/v1/contract' });
  await app.ready();
});

afterAll(async () => {
  if (app) {
    await app.close();
  }
});

describe('GET /api/v1/contract/orgs', () => {
  it('sanitizes control characters from the search query before passing to the controller', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/contract/orgs?search=%00%01bad',
    });

    expect(response.statusCode).toBe(200);
    expect(contractController.getOrganizations).toHaveBeenCalledWith(1, 10, 'bad');
    expect(response.json()).toMatchObject({
      data: [],
      meta: { currentPage: 1, totalCount: 0, totalPages: 0 },
    });
  });

  it('trims whitespace from the search query before passing to the controller', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/contract/orgs?page=1&limit=10&search=%20hello%20world%20',
    });

    expect(response.statusCode).toBe(200);
    expect(contractController.getOrganizations).toHaveBeenCalledWith(1, 10, 'hello world');
    expect(response.json()).toMatchObject({
      data: [],
      meta: { currentPage: 1, totalCount: 0, totalPages: 0 },
    });
  });

  it('treats blank whitespace-only search input as no search term', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/contract/orgs?search=%20%20%20',
    });

    expect(response.statusCode).toBe(200);
    expect(contractController.getOrganizations).toHaveBeenCalledWith(1, 10, undefined);
  });
});

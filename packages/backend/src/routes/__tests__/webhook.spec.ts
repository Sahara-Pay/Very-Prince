import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fastify from 'fastify';

const mockStellarService = {
  readOrganization: vi.fn(),
};

const mockWebhookService = {
  getConfig: vi.fn(),
  updateConfig: vi.fn(),
  sendTestWebhook: vi.fn(),
};

vi.mock('../../services/stellarService.js', () => ({
  stellarService: mockStellarService,
}));

vi.mock('../../services/webhookService.js', () => ({
  webhookService: mockWebhookService,
}));

// A minimal pino-compatible logger stub so we can assert on structured error logging
// without depending on pino's real transport/formatting.
function createLoggerStub(): import('fastify').FastifyBaseLogger {
  const stub: Record<string, unknown> = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    silent: vi.fn(),
    level: 'info',
  };
  stub['child'] = vi.fn(() => stub);
  return stub as unknown as import('fastify').FastifyBaseLogger;
}

let app: ReturnType<typeof fastify>;
let loggerStub: ReturnType<typeof createLoggerStub>;

beforeAll(async () => {
  const routeModule = await import('../webhook.js');
  loggerStub = createLoggerStub();
  app = fastify({ loggerInstance: loggerStub });
  app.register(routeModule.webhookRoutes, { prefix: '/api/org/:orgId/webhook' });
  await app.ready();
});

afterAll(async () => {
  if (app) {
    await app.close();
  }
});

beforeEach(() => {
  vi.clearAllMocks();
});

const authHeaders = { authorization: 'Bearer GADMIN...' };

describe('webhookRoutes error logging', () => {
  it('logs a structured error with orgId when fetching the webhook config fails', async () => {
    mockStellarService.readOrganization.mockRejectedValueOnce(new Error('Soroban RPC unavailable'));

    const response = await app.inject({
      method: 'GET',
      url: '/api/org/org-1/webhook',
      headers: authHeaders,
    });

    expect(response.statusCode).toBe(500);
    expect(loggerStub.error).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 'org-1', err: expect.any(Error) }),
      'Failed to fetch webhook config'
    );
  });

  it('logs a structured error with orgId when updating the webhook config fails', async () => {
    mockStellarService.readOrganization.mockRejectedValueOnce(new Error('Soroban RPC unavailable'));

    const response = await app.inject({
      method: 'POST',
      url: '/api/org/org-1/webhook',
      headers: authHeaders,
      payload: { url: 'https://example.com/hook' },
    });

    expect(response.statusCode).toBe(500);
    expect(loggerStub.error).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 'org-1', err: expect.any(Error) }),
      'Failed to update webhook config'
    );
  });

  it('logs a structured error with orgId when the test webhook dispatch fails', async () => {
    mockStellarService.readOrganization.mockResolvedValueOnce({ admins: ['GADMIN...'] });
    mockWebhookService.sendTestWebhook.mockRejectedValueOnce(new Error('Queue unavailable'));

    const response = await app.inject({
      method: 'POST',
      url: '/api/org/org-1/webhook/test',
      headers: authHeaders,
    });

    expect(response.statusCode).toBe(500);
    expect(loggerStub.error).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 'org-1', err: expect.any(Error) }),
      'Test webhook failed'
    );
  });

  it('does not log an error on the successful path', async () => {
    mockStellarService.readOrganization.mockResolvedValueOnce({ admins: ['GADMIN...'] });
    mockWebhookService.getConfig.mockResolvedValueOnce(null);

    const response = await app.inject({
      method: 'GET',
      url: '/api/org/org-1/webhook',
      headers: authHeaders,
    });

    expect(response.statusCode).toBe(200);
    expect(loggerStub.error).not.toHaveBeenCalled();
  });
});

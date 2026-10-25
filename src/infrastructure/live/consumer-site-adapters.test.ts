import { describe, expect, it } from 'vitest';
import { createConsumerSiteAdapter, createConsumerSiteAdapters } from './consumer-site-adapters';

const target = { provider: 'chatgpt' as const, tabId: 1, conversationId: 'c', pageInstanceId: 'p' };
const options = { signal: new AbortController().signal };

describe('consumer-site adapters', () => {
  it('declare the route not authorized and every operation unavailable', async () => {
    for (const adapter of Object.values(createConsumerSiteAdapters())) {
      expect(adapter.authorization.kind).toBe('not-authorized');
      const capabilities = await adapter.capabilities({ ...target, provider: adapter.provider });
      expect(capabilities.submission.status).toBe('unavailable');
      expect(capabilities.responseAcquisition.status).toBe('unavailable');
    }
  });

  it('refuse to submit or read anything, and say that nothing was performed', async () => {
    const adapter = createConsumerSiteAdapter('claude');
    const submitted = await adapter.submit(target, { operationId: 'op', text: 'Hello' }, options);
    expect(submitted).toMatchObject({ ok: false, failure: { kind: 'not-authorized', outcome: 'not-performed' } });
    const response = await adapter.awaitResponse(
      target,
      { operationId: 'op', conversationId: 'c', pageInstanceId: 'p', submissionId: 's' },
      options,
    );
    expect(response).toMatchObject({ ok: false, failure: { outcome: 'not-performed' } });
  });

  it('explain the reason in provider-specific terms', () => {
    expect(createConsumerSiteAdapter('chatgpt').authorization).toMatchObject({
      reason: expect.stringContaining('chatgpt.com') as unknown,
    });
    expect(createConsumerSiteAdapter('claude').route.label).toContain('claude.ai');
  });
});

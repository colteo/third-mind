import { describe, expect, it } from 'vitest';
import type { LiveConversationTarget } from '../../ports';
import { createConsumerSiteAdapter, createConsumerSiteAdapters } from './consumer-site-adapters';

const target: LiveConversationTarget = { kind: 'conversation', provider: 'chatgpt', tabId: 1, conversationId: 'c', pageInstanceId: 'p' };
const newChat: LiveConversationTarget = { kind: 'new-chat', provider: 'claude', tabId: 2, origin: 'https://claude.ai', pageInstanceId: 'p' };
const options = { signal: new AbortController().signal };

describe('consumer-site adapters', () => {
  it('declare the route not authorized and every operation unavailable, for saved conversations and new chats', async () => {
    for (const adapter of Object.values(createConsumerSiteAdapters())) {
      expect(adapter.authorization.kind).toBe('not-authorized');
      for (const candidate of [target, newChat]) {
        const capabilities = await adapter.capabilities({ ...candidate, provider: adapter.provider });
        expect(capabilities.submission.status).toBe('unavailable');
        expect(capabilities.responseAcquisition.status).toBe('unavailable');
      }
    }
  });

  it('refuse to submit or read anything, and say that nothing was performed', async () => {
    const adapter = createConsumerSiteAdapter('claude');
    const submitted = await adapter.submit(target, { operationId: 'op', text: 'Hello' }, options);
    expect(submitted).toMatchObject({ ok: false, failure: { kind: 'not-authorized', outcome: 'not-performed' } });
    const response = await adapter.awaitResponse(
      target,
      { kind: 'conversation', operationId: 'op', conversationId: 'c', pageInstanceId: 'p', submissionId: 's' },
      options,
    );
    expect(response).toMatchObject({ ok: false, failure: { outcome: 'not-performed' } });
  });

  it('refuse to send a first message to a new chat', async () => {
    const adapter = createConsumerSiteAdapter('claude');
    const submitted = await adapter.submit(newChat, { operationId: 'op', text: 'Hello' }, options);
    expect(submitted).toMatchObject({ ok: false, failure: { kind: 'not-authorized', outcome: 'not-performed' } });
    const response = await adapter.awaitResponse(
      newChat,
      { kind: 'new-chat', operationId: 'op', pageInstanceId: 'p', submissionId: 's' },
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

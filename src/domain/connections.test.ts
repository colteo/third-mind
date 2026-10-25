import { describe, expect, it } from 'vitest';
import {
  EMPTY_CONNECTION_REGISTRY,
  disconnectConversation,
  linkConversation,
  observeLink,
  parseConnectionRegistry,
  reconcileRegistry,
  reconnectConversation,
  type ConnectionRegistry,
  type ConversationLink,
  type ConversationProviderId,
  type ObservedTab,
  type TabClassification,
} from './connections';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function conversation(conversationId: string, provider: ConversationProviderId = 'chatgpt'): TabClassification {
  const path = provider === 'chatgpt' ? 'https://chatgpt.com/c/' : 'https://claude.ai/chat/';
  return { kind: 'conversation', conversation: { provider, conversationId, canonicalUrl: `${path}${conversationId}` } };
}

function tab(tabId: number, classification: TabClassification, title: string | null = 'Title'): ObservedTab {
  return { tabId, title, classification };
}

function linkedRegistry(tabId = 7, conversationId = A): ConnectionRegistry {
  const result = linkConversation(
    EMPTY_CONNECTION_REGISTRY,
    { provider: 'chatgpt', expectedRevision: 0, conversationId, tabId },
    tab(tabId, conversation(conversationId)),
  );
  if (!result.ok) throw new Error(result.reason);
  return result.registry;
}

function chatgptLink(registry: ConnectionRegistry): ConversationLink {
  const { link } = registry.chatgpt;
  if (link === null) throw new Error('Not linked');
  return link;
}

describe('explicit conversation selection', () => {
  it('links exactly the selected conversation and advances the revision', () => {
    const registry = linkedRegistry();
    expect(registry.chatgpt).toEqual({
      revision: 1,
      link: {
        provider: 'chatgpt',
        tabId: 7,
        conversationId: A,
        canonicalUrl: `https://chatgpt.com/c/${A}`,
        state: { kind: 'linked' },
      },
    });
    expect(registry.claude).toBe(EMPTY_CONNECTION_REGISTRY.claude);
  });

  it('refuses a tab that no longer shows the selected conversation', () => {
    const result = linkConversation(
      EMPTY_CONNECTION_REGISTRY,
      { provider: 'chatgpt', expectedRevision: 0, conversationId: A, tabId: 7 },
      tab(7, conversation(B)),
    );
    expect(result.ok).toBe(false);
  });

  it.each<[string, ObservedTab | null]>([
    ['a closed tab', null],
    ['a provider home page', tab(7, { kind: 'provider-page', provider: 'chatgpt' })],
    ['an unsupported page', tab(7, { kind: 'unsupported' })],
    ['an unreadable tab', tab(7, { kind: 'unavailable' })],
    ['a conversation of the other provider', tab(7, conversation(A, 'claude'))],
    ['an observation of another tab', tab(8, conversation(A))],
  ])('never turns %s into a linked conversation', (_label, observed) => {
    const result = linkConversation(
      EMPTY_CONNECTION_REGISTRY,
      { provider: 'chatgpt', expectedRevision: 0, conversationId: A, tabId: 7 },
      observed,
    );
    expect(result.ok).toBe(false);
  });

  it('rejects a command based on an outdated revision', () => {
    const registry = linkedRegistry();
    const result = linkConversation(
      registry,
      { provider: 'chatgpt', expectedRevision: 0, conversationId: B, tabId: 9 },
      tab(9, conversation(B)),
    );
    expect(result).toMatchObject({ ok: false });
  });

  it('treats linking the same healthy link again as a no-op', () => {
    const registry = linkedRegistry();
    const result = linkConversation(
      registry,
      { provider: 'chatgpt', expectedRevision: 1, conversationId: A, tabId: 7 },
      tab(7, conversation(A)),
    );
    expect(result).toEqual({ ok: true, registry });
  });
});

describe('link lifecycle', () => {
  it('disconnects when the tab is confirmed closed', () => {
    const link = observeLink(chatgptLink(linkedRegistry()), { kind: 'missing' });
    expect(link.state).toEqual({ kind: 'disconnected', reason: 'tab-closed' });
  });

  it('becomes stale when the tab navigates to another conversation', () => {
    const link = observeLink(chatgptLink(linkedRegistry()), { kind: 'present', tab: tab(7, conversation(B)) });
    expect(link.state).toEqual({ kind: 'stale', reason: 'different-conversation' });
  });

  it('becomes stale when the tab leaves the conversation', () => {
    const home = observeLink(chatgptLink(linkedRegistry()), {
      kind: 'present',
      tab: tab(7, { kind: 'provider-page', provider: 'chatgpt' }),
    });
    const elsewhere = observeLink(chatgptLink(linkedRegistry()), {
      kind: 'present',
      tab: tab(7, { kind: 'unsupported' }),
    });
    expect(home.state).toEqual({ kind: 'stale', reason: 'left-conversation' });
    expect(elsewhere.state).toEqual({ kind: 'stale', reason: 'left-conversation' });
  });

  it('distinguishes temporary unavailability and recovers from it', () => {
    const original = chatgptLink(linkedRegistry());
    const unreadable = observeLink(original, { kind: 'present', tab: tab(7, { kind: 'unavailable' }) });
    expect(unreadable.state).toEqual({ kind: 'unavailable', reason: 'tab-unreadable' });
    const queryFailed = observeLink(original, { kind: 'unknown' });
    expect(queryFailed.state).toEqual({ kind: 'unavailable', reason: 'tab-query-failed' });

    expect(observeLink(unreadable, { kind: 'present', tab: tab(7, conversation(A)) }).state).toEqual({
      kind: 'linked',
    });
    expect(observeLink(queryFailed, { kind: 'present', tab: tab(7, conversation(A)) }).state).toEqual({
      kind: 'linked',
    });
  });

  it('never restores a stale or disconnected link on its own, even if the same tab shows the conversation again', () => {
    const stale = observeLink(chatgptLink(linkedRegistry()), { kind: 'present', tab: tab(7, conversation(B)) });
    expect(observeLink(stale, { kind: 'present', tab: tab(7, conversation(A)) })).toBe(stale);
    const closed = observeLink(chatgptLink(linkedRegistry()), { kind: 'missing' });
    expect(observeLink(closed, { kind: 'present', tab: tab(7, conversation(A)) })).toBe(closed);
  });

  it('ignores a matching title or tab id when the conversation identifier differs', () => {
    const link = observeLink(chatgptLink(linkedRegistry()), {
      kind: 'present',
      tab: tab(7, conversation(B), 'Title'),
    });
    expect(link.state.kind).toBe('stale');
  });
});

describe('reconciliation', () => {
  it('returns the same registry when nothing changed, so duplicate observations are idempotent', () => {
    const registry = linkedRegistry();
    const same = reconcileRegistry(registry, () => ({ kind: 'present', tab: tab(7, conversation(A)) }));
    expect(same).toBe(registry);
    const unknown = reconcileRegistry(registry, () => undefined);
    expect(unknown).toBe(registry);
  });

  it('advances the revision once per actual change', () => {
    const closed = reconcileRegistry(linkedRegistry(), () => ({ kind: 'missing' }));
    expect(closed.chatgpt.revision).toBe(2);
    expect(reconcileRegistry(closed, () => ({ kind: 'missing' }))).toBe(closed);
  });
});

describe('explicit reconnection', () => {
  const closed = reconcileRegistry(linkedRegistry(), () => ({ kind: 'missing' }));

  it('restores the link to another tab that shows the same conversation', () => {
    const result = reconnectConversation(closed, { provider: 'chatgpt', expectedRevision: 2, tabId: 12 }, tab(12, conversation(A)));
    if (!result.ok) throw new Error(result.reason);
    expect(result.registry.chatgpt.link).toMatchObject({ tabId: 12, conversationId: A, state: { kind: 'linked' } });
    expect(result.registry.chatgpt.revision).toBe(3);
  });

  it('refuses a tab that shows a different conversation', () => {
    const result = reconnectConversation(closed, { provider: 'chatgpt', expectedRevision: 2, tabId: 12 }, tab(12, conversation(B)));
    expect(result.ok).toBe(false);
  });

  it('refuses the same tab id when it shows another conversation', () => {
    const stale = reconcileRegistry(linkedRegistry(), () => ({ kind: 'present', tab: tab(7, conversation(B)) }));
    const result = reconnectConversation(stale, { provider: 'chatgpt', expectedRevision: 2, tabId: 7 }, tab(7, conversation(B)));
    expect(result.ok).toBe(false);
  });

  it('refuses when there is nothing to reconnect or the view is outdated', () => {
    expect(
      reconnectConversation(EMPTY_CONNECTION_REGISTRY, { provider: 'chatgpt', expectedRevision: 0, tabId: 7 }, tab(7, conversation(A))).ok,
    ).toBe(false);
    expect(reconnectConversation(closed, { provider: 'chatgpt', expectedRevision: 1, tabId: 12 }, tab(12, conversation(A))).ok).toBe(
      false,
    );
  });
});

describe('disconnection', () => {
  it('removes the link and is idempotent', () => {
    const result = disconnectConversation(linkedRegistry(), { provider: 'chatgpt', expectedRevision: 1 });
    if (!result.ok) throw new Error(result.reason);
    expect(result.registry.chatgpt).toEqual({ revision: 2, link: null });
    expect(disconnectConversation(result.registry, { provider: 'chatgpt', expectedRevision: 1 })).toEqual({
      ok: true,
      registry: result.registry,
    });
  });

  it('rejects a stale client', () => {
    const changed = reconcileRegistry(linkedRegistry(), () => ({ kind: 'missing' }));
    expect(disconnectConversation(changed, { provider: 'chatgpt', expectedRevision: 1 }).ok).toBe(false);
  });
});

describe('stored registry validation', () => {
  it('round-trips a valid registry through JSON', () => {
    const registry = linkedRegistry();
    expect(parseConnectionRegistry(JSON.parse(JSON.stringify(registry)))).toEqual(registry);
  });

  it('drops unknown fields', () => {
    const registry = linkedRegistry();
    const withExtra = { ...registry, chatgpt: { ...registry.chatgpt, link: { ...chatgptLink(registry), title: 'x' } } };
    expect(parseConnectionRegistry(withExtra)).toEqual(registry);
  });

  it.each<[unknown]>([
    [null],
    [[]],
    [{}],
    [{ chatgpt: { revision: 0, link: null } }],
    [{ chatgpt: { revision: -1, link: null }, claude: { revision: 0, link: null } }],
    [{ chatgpt: { revision: 0, link: { provider: 'claude' } }, claude: { revision: 0, link: null } }],
    [
      {
        chatgpt: {
          revision: 1,
          link: { provider: 'chatgpt', tabId: 1, conversationId: A, canonicalUrl: 'x', state: { kind: 'linked-ish' } },
        },
        claude: { revision: 0, link: null },
      },
    ],
  ])('rejects %j', (value) => {
    expect(parseConnectionRegistry(value)).toBeNull();
  });
});

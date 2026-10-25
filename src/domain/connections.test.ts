import { describe, expect, it } from 'vitest';
import {
  EMPTY_CONNECTION_REGISTRY,
  confirmConversationIdentity,
  disconnectConversation,
  linkConversation,
  linkNewChat,
  linkStatus,
  migrateConnectionRegistryV1,
  observeLink,
  parseConnectionRegistry,
  reconcileRegistry,
  reconnectConversation,
  type ConfirmIdentityRequest,
  type ConnectionRegistry,
  type ConversationLink,
  type ConversationProviderId,
  type ObservedTab,
  type ReconciliationContext,
  type TabClassification,
  type UrlClassification,
} from './connections';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const ORIGINS = { chatgpt: 'https://chatgpt.com', claude: 'https://claude.ai' } as const;

function conversation(conversationId: string, provider: ConversationProviderId = 'chatgpt'): TabClassification {
  const path = provider === 'chatgpt' ? 'https://chatgpt.com/c/' : 'https://claude.ai/chat/';
  return {
    kind: 'conversation',
    conversation: { provider, origin: ORIGINS[provider], conversationId, canonicalUrl: `${path}${conversationId}` },
  };
}

function newChat(provider: ConversationProviderId = 'chatgpt'): TabClassification {
  return { kind: 'new-chat', provider, origin: ORIGINS[provider] };
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

function pendingRegistry(tabId = 7, provider: ConversationProviderId = 'chatgpt'): ConnectionRegistry {
  const result = linkNewChat(
    EMPTY_CONNECTION_REGISTRY,
    { provider, expectedRevision: 0, tabId },
    tab(tabId, newChat(provider)),
  );
  if (!result.ok) throw new Error(result.reason);
  return result.registry;
}

function chatgptLink(registry: ConnectionRegistry): ConversationLink {
  const { link } = registry.chatgpt;
  if (link === null) throw new Error('Not linked');
  return link;
}

function claudeLink(registry: ConnectionRegistry): ConversationLink {
  const { link } = registry.claude;
  if (link === null) throw new Error('Not linked');
  return link;
}

/** First observation after a start-up, or after a failed scan: no continuity. */
const NO_HISTORY: ReconciliationContext = { previousTabs: null, currentTabs: [] };

/** The previous successful scan saw `previous`; the current one sees `current`. */
function history(previous: ObservedTab[], current: ObservedTab[]): ReconciliationContext {
  return { previousTabs: previous, currentTabs: current };
}

describe('explicit conversation selection', () => {
  it('links exactly the selected conversation and advances the revision', () => {
    const registry = linkedRegistry();
    expect(registry.chatgpt).toEqual({
      revision: 1,
      link: {
        provider: 'chatgpt',
        origin: 'https://chatgpt.com',
        tabId: 7,
        identity: { kind: 'saved', conversationId: A, canonicalUrl: `https://chatgpt.com/c/${A}`, source: 'selected' },
        state: { kind: 'linked' },
      },
    });
    expect(registry.claude).toBe(EMPTY_CONNECTION_REGISTRY.claude);
    expect(linkStatus(chatgptLink(registry))).toEqual({ kind: 'linked' });
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
    ['a new chat', tab(7, newChat())],
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
    for (const classification of [
      { kind: 'provider-page', provider: 'chatgpt' } as const,
      { kind: 'unsupported' } as const,
      newChat(),
    ]) {
      const link = observeLink(chatgptLink(linkedRegistry()), { kind: 'present', tab: tab(7, classification) });
      expect(link.state).toEqual({ kind: 'stale', reason: 'left-conversation' });
    }
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
    expect(result.registry.chatgpt.link).toMatchObject({
      tabId: 12,
      identity: { kind: 'saved', conversationId: A },
      state: { kind: 'linked' },
    });
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

  it('disconnects a pending new chat', () => {
    const result = disconnectConversation(pendingRegistry(), { provider: 'chatgpt', expectedRevision: 1 });
    expect(result).toMatchObject({ ok: true, registry: { chatgpt: { revision: 2, link: null } } });
  });
});

// ---------------------------------------------------------------------------
// New chats with a pending identity (Phase 2.2A)
// ---------------------------------------------------------------------------

describe('explicit new chat linking', () => {
  it('links a new chat with a pending identity and no invented identifier or URL', () => {
    const registry = pendingRegistry();
    expect(registry.chatgpt).toEqual({
      revision: 1,
      link: {
        provider: 'chatgpt',
        origin: 'https://chatgpt.com',
        tabId: 7,
        identity: { kind: 'pending' },
        state: { kind: 'linked' },
      },
    });
    expect(JSON.stringify(registry)).not.toContain('conversationId');
    expect(JSON.stringify(registry)).not.toContain('canonicalUrl');
    expect(linkStatus(chatgptLink(registry))).toEqual({ kind: 'awaiting-identity' });
  });

  it('links a Claude new chat', () => {
    expect(claudeLink(pendingRegistry(3, 'claude'))).toMatchObject({
      tabId: 3,
      origin: 'https://claude.ai',
      identity: { kind: 'pending' },
    });
  });

  it.each<[string, ObservedTab | null, string]>([
    ['a closed tab', null, 'no longer open'],
    ['an observation of another tab', tab(8, newChat()), 'no longer open'],
    ['a tab that already shows a saved conversation', tab(7, conversation(A)), 'saved conversation'],
    ['a provider page', tab(7, { kind: 'provider-page', provider: 'chatgpt' }), 'no longer shows a new chat'],
    ['an unsupported page', tab(7, { kind: 'unsupported' }), 'no longer shows a new chat'],
    ['an unreadable tab', tab(7, { kind: 'unavailable' }), 'no longer shows a new chat'],
    ['a new chat of the other provider', tab(7, newChat('claude')), 'different provider'],
  ])('refuses %s', (_label, observed, reason) => {
    const result = linkNewChat(EMPTY_CONNECTION_REGISTRY, { provider: 'chatgpt', expectedRevision: 0, tabId: 7 }, observed);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain(reason);
  });

  it('rejects an outdated revision and treats relinking the same new chat as a no-op', () => {
    const registry = pendingRegistry();
    expect(linkNewChat(registry, { provider: 'chatgpt', expectedRevision: 0, tabId: 7 }, tab(7, newChat())).ok).toBe(false);
    expect(linkNewChat(registry, { provider: 'chatgpt', expectedRevision: 1, tabId: 7 }, tab(7, newChat()))).toEqual({
      ok: true,
      registry,
    });
  });

  it('replaces a saved conversation link with a new chat only on explicit request', () => {
    const result = linkNewChat(linkedRegistry(), { provider: 'chatgpt', expectedRevision: 1, tabId: 9 }, tab(9, newChat()));
    if (!result.ok) throw new Error(result.reason);
    expect(result.registry.chatgpt.link).toMatchObject({ tabId: 9, identity: { kind: 'pending' } });
    expect(result.registry.chatgpt.revision).toBe(2);
  });
});

describe('identity reconciliation of a pending new chat', () => {
  const onNewChat = tab(7, newChat());
  const onC = tab(7, conversation(C));

  it('adopts the conversation when the same tab moves directly from the new chat to it', () => {
    const registry = reconcileRegistry(pendingRegistry(), () => ({ kind: 'present', tab: onC }), history([onNewChat], [onC]));
    expect(registry.chatgpt).toEqual({
      revision: 2,
      link: {
        provider: 'chatgpt',
        origin: 'https://chatgpt.com',
        tabId: 7,
        identity: { kind: 'saved', conversationId: C, canonicalUrl: `https://chatgpt.com/c/${C}`, source: 'new-chat' },
        state: { kind: 'linked' },
      },
    });
    expect(linkStatus(chatgptLink(registry))).toEqual({ kind: 'linked' });
  });

  it('adopts a Claude conversation the same way', () => {
    const before = tab(3, newChat('claude'));
    const after = tab(3, conversation(C, 'claude'));
    const registry = reconcileRegistry(pendingRegistry(3, 'claude'), () => ({ kind: 'present', tab: after }), history([before], [after]));
    expect(claudeLink(registry).identity).toMatchObject({ kind: 'saved', conversationId: C, source: 'new-chat' });
  });

  it('keeps the pending identity while the tab still shows a new chat', () => {
    const link = chatgptLink(pendingRegistry());
    expect(observeLink(link, { kind: 'present', tab: onNewChat }, history([onNewChat], [onNewChat]))).toBe(link);
    expect(observeLink(link, { kind: 'present', tab: onNewChat }, NO_HISTORY)).toBe(link);
  });

  it('is idempotent: observing the resolved conversation again changes nothing', () => {
    const resolved = reconcileRegistry(pendingRegistry(), () => ({ kind: 'present', tab: onC }), history([onNewChat], [onC]));
    expect(reconcileRegistry(resolved, () => ({ kind: 'present', tab: onC }), history([onC], [onC]))).toBe(resolved);
  });

  it('requires confirmation after a gap in observation (service worker restart)', () => {
    const link = observeLink(chatgptLink(pendingRegistry()), { kind: 'present', tab: onC }, NO_HISTORY);
    expect(link.identity).toEqual({
      kind: 'unconfirmed',
      conversationId: C,
      canonicalUrl: `https://chatgpt.com/c/${C}`,
      reason: 'observation-gap',
    });
    expect(link.state).toEqual({ kind: 'linked' });
    expect(linkStatus(link)).toEqual({ kind: 'confirmation-required', reason: 'observation-gap' });
  });

  it('requires confirmation when the tab was unreadable or the query failed before the conversation appeared', () => {
    for (const gap of [{ kind: 'unknown' } as const, { kind: 'present', tab: tab(7, { kind: 'unavailable' }) } as const]) {
      const unavailable = observeLink(chatgptLink(pendingRegistry()), gap);
      expect(unavailable.state.kind).toBe('unavailable');
      const after = observeLink(unavailable, { kind: 'present', tab: onC }, history([onNewChat], [onC]));
      expect(after.identity).toMatchObject({ kind: 'unconfirmed', reason: 'observation-gap' });
    }
  });

  it('recovers from temporary unavailability while the tab still shows the new chat', () => {
    const unavailable = observeLink(chatgptLink(pendingRegistry()), { kind: 'unknown' });
    const recovered = observeLink(unavailable, { kind: 'present', tab: onNewChat }, NO_HISTORY);
    expect(recovered).toMatchObject({ identity: { kind: 'pending' }, state: { kind: 'linked' } });
  });

  it('requires confirmation when the conversation newly appears in another tab as well', () => {
    const duplicate = tab(8, conversation(C));
    const link = observeLink(chatgptLink(pendingRegistry()), { kind: 'present', tab: onC }, history([onNewChat], [onC, duplicate]));
    expect(link.identity).toMatchObject({ kind: 'unconfirmed', reason: 'open-in-another-tab' });
  });

  it('never adopts a conversation that was already open in another tab before the transition', () => {
    const existing = tab(8, conversation(B));
    const onB = tab(7, conversation(B));
    const link = observeLink(
      chatgptLink(pendingRegistry()),
      { kind: 'present', tab: onB },
      history([onNewChat, existing], [onB, existing]),
    );
    expect(link.identity).toEqual({ kind: 'pending' });
    expect(link.state).toEqual({ kind: 'stale', reason: 'different-conversation' });
  });

  it('requires confirmation when the previous scan did not show this tab on the new chat (tab id reuse)', () => {
    const link = observeLink(chatgptLink(pendingRegistry()), { kind: 'present', tab: onC }, history([], [onC]));
    expect(link.identity).toMatchObject({ kind: 'unconfirmed', reason: 'observation-gap' });
  });

  it.each<[string, TabClassification, string]>([
    ['a provider page that is not a new chat', { kind: 'provider-page', provider: 'chatgpt' }, 'left-conversation'],
    ['an external site', { kind: 'unsupported' }, 'left-conversation'],
    ['a new chat of the other provider', newChat('claude'), 'left-conversation'],
    ['a conversation of the other provider', conversation(C, 'claude'), 'different-conversation'],
    [
      'a conversation on another origin',
      {
        kind: 'conversation',
        conversation: { provider: 'chatgpt', origin: 'https://chatgpt.example', conversationId: C, canonicalUrl: 'x' },
      },
      'different-conversation',
    ],
  ])('becomes stale, without adopting anything, when the tab moves to %s', (_label, classification, reason) => {
    const now = tab(7, classification);
    const link = observeLink(chatgptLink(pendingRegistry()), { kind: 'present', tab: now }, history([onNewChat], [now]));
    expect(link.identity).toEqual({ kind: 'pending' });
    expect(link.state).toEqual({ kind: 'stale', reason });
  });

  it('disconnects when the pending tab is closed, and stays disconnected', () => {
    const closed = observeLink(chatgptLink(pendingRegistry()), { kind: 'missing' });
    expect(closed).toMatchObject({ identity: { kind: 'pending' }, state: { kind: 'disconnected', reason: 'tab-closed' } });
    expect(observeLink(closed, { kind: 'present', tab: onC }, history([onNewChat], [onC]))).toBe(closed);
  });

  it('never replaces an established identity, however it was learned', () => {
    const onB = tab(7, conversation(B));
    const resolved = observeLink(chatgptLink(pendingRegistry()), { kind: 'present', tab: onC }, history([onNewChat], [onC]));
    const moved = observeLink(resolved, { kind: 'present', tab: onB }, history([onC], [onB]));
    expect(moved.identity).toMatchObject({ kind: 'saved', conversationId: C });
    expect(moved.state).toEqual({ kind: 'stale', reason: 'different-conversation' });

    const unconfirmed = observeLink(chatgptLink(pendingRegistry()), { kind: 'present', tab: onC }, NO_HISTORY);
    const movedAgain = observeLink(unconfirmed, { kind: 'present', tab: onB }, history([onC], [onB]));
    expect(movedAgain.identity).toMatchObject({ kind: 'unconfirmed', conversationId: C });
    expect(movedAgain.state).toEqual({ kind: 'stale', reason: 'different-conversation' });
  });

  it('becomes stale when a resolved link returns to a new chat', () => {
    const resolved = observeLink(chatgptLink(pendingRegistry()), { kind: 'present', tab: onC }, history([onNewChat], [onC]));
    expect(observeLink(resolved, { kind: 'present', tab: onNewChat }).state).toEqual({
      kind: 'stale',
      reason: 'left-conversation',
    });
  });

  it('leaves the other provider untouched', () => {
    const registry = pendingRegistry();
    const next = reconcileRegistry(registry, () => ({ kind: 'present', tab: onC }), history([onNewChat], [onC]));
    expect(next.claude).toBe(registry.claude);
  });
});

describe('explicit identity confirmation', () => {
  const onC = tab(7, conversation(C));
  const unconfirmed = reconcileRegistry(pendingRegistry(), () => ({ kind: 'present', tab: onC }), NO_HISTORY);
  const request: ConfirmIdentityRequest = { provider: 'chatgpt', expectedRevision: 2, tabId: 7, conversationId: C };

  it('saves the confirmed identity on the original tab', () => {
    const result = confirmConversationIdentity(unconfirmed, request, onC);
    if (!result.ok) throw new Error(result.reason);
    expect(result.registry.chatgpt).toEqual({
      revision: 3,
      link: {
        provider: 'chatgpt',
        origin: 'https://chatgpt.com',
        tabId: 7,
        identity: { kind: 'saved', conversationId: C, canonicalUrl: `https://chatgpt.com/c/${C}`, source: 'confirmed' },
        state: { kind: 'linked' },
      },
    });
  });

  it.each<[string, ConfirmIdentityRequest, ObservedTab | null]>([
    ['an outdated revision', { ...request, expectedRevision: 1 }, onC],
    ['another tab showing the same conversation', { ...request, tabId: 8 }, tab(8, conversation(C))],
    ['a different conversation id than the one shown to the human', { ...request, conversationId: B }, onC],
    ['a tab that now shows another conversation', request, tab(7, conversation(B))],
    ['a closed tab', request, null],
  ])('refuses %s', (_label, confirm, observed) => {
    expect(confirmConversationIdentity(unconfirmed, confirm, observed).ok).toBe(false);
  });

  it('refuses when nothing is waiting for confirmation', () => {
    expect(confirmConversationIdentity(pendingRegistry(), { ...request, expectedRevision: 1 }, onC).ok).toBe(false);
    expect(confirmConversationIdentity(EMPTY_CONNECTION_REGISTRY, { ...request, expectedRevision: 0 }, onC).ok).toBe(false);
  });

  it('refuses once the unconfirmed link has gone stale', () => {
    const stale = reconcileRegistry(unconfirmed, () => ({ kind: 'present', tab: tab(7, conversation(B)) }));
    expect(confirmConversationIdentity(stale, { ...request, expectedRevision: 3 }, onC).ok).toBe(false);
  });
});

describe('reconnection of new chats', () => {
  it('refuses to reconnect a pending new chat, which has nothing to recognize it by', () => {
    const closed = reconcileRegistry(pendingRegistry(), () => ({ kind: 'missing' }));
    const result = reconnectConversation(closed, { provider: 'chatgpt', expectedRevision: 2, tabId: 9 }, tab(9, conversation(C)));
    expect(result.ok).toBe(false);
  });

  it('reconnects a resolved new chat by its conversation id and keeps how it was learned', () => {
    const onC = tab(7, conversation(C));
    const resolved = reconcileRegistry(pendingRegistry(), () => ({ kind: 'present', tab: onC }), history([tab(7, newChat())], [onC]));
    const closed = reconcileRegistry(resolved, () => ({ kind: 'missing' }));
    const result = reconnectConversation(closed, { provider: 'chatgpt', expectedRevision: 3, tabId: 20 }, tab(20, conversation(C)));
    if (!result.ok) throw new Error(result.reason);
    expect(result.registry.chatgpt.link).toMatchObject({
      tabId: 20,
      identity: { kind: 'saved', conversationId: C, source: 'new-chat' },
      state: { kind: 'linked' },
    });
  });
});

// ---------------------------------------------------------------------------
// Storage validation and migration
// ---------------------------------------------------------------------------

describe('stored registry validation', () => {
  it('round-trips valid registries through JSON, including pending and unconfirmed identities', () => {
    const linked = linkedRegistry();
    expect(parseConnectionRegistry(JSON.parse(JSON.stringify(linked)))).toEqual(linked);
    const pending = pendingRegistry();
    expect(parseConnectionRegistry(JSON.parse(JSON.stringify(pending)))).toEqual(pending);
    const unconfirmed = reconcileRegistry(pending, () => ({ kind: 'present', tab: tab(7, conversation(C)) }), NO_HISTORY);
    expect(chatgptLink(unconfirmed).identity.kind).toBe('unconfirmed');
    expect(parseConnectionRegistry(JSON.parse(JSON.stringify(unconfirmed)))).toEqual(unconfirmed);
  });

  it('drops unknown fields', () => {
    const registry = linkedRegistry();
    const withExtra = { ...registry, chatgpt: { ...registry.chatgpt, link: { ...chatgptLink(registry), title: 'x' } } };
    expect(parseConnectionRegistry(withExtra)).toEqual(registry);
  });

  const slot = (link: unknown) => ({ chatgpt: { revision: 1, link }, claude: { revision: 0, link: null } });
  const base = { provider: 'chatgpt', origin: 'https://chatgpt.com', tabId: 1, state: { kind: 'linked' } };

  it.each<[unknown]>([
    [null],
    [[]],
    [{}],
    [{ chatgpt: { revision: 0, link: null } }],
    [{ chatgpt: { revision: -1, link: null }, claude: { revision: 0, link: null } }],
    [{ chatgpt: { revision: 0, link: { provider: 'claude' } }, claude: { revision: 0, link: null } }],
    [slot({ ...base, identity: { kind: 'pending' }, state: { kind: 'linked-ish' } })],
    [slot({ ...base, identity: { kind: 'guessed' } })],
    [slot({ ...base, identity: { kind: 'saved', conversationId: '', canonicalUrl: '', source: 'selected' } })],
    [slot({ ...base, identity: { kind: 'saved', conversationId: A, canonicalUrl: 'x', source: 'automatic' } })],
    [slot({ ...base, identity: { kind: 'unconfirmed', conversationId: A, canonicalUrl: 'x', reason: 'hunch' } })],
    [slot({ ...base, origin: '', identity: { kind: 'pending' } })],
    // A version 1 link (no origin, no identity) is not a valid version 2 link.
    [slot({ provider: 'chatgpt', tabId: 1, conversationId: A, canonicalUrl: `https://chatgpt.com/c/${A}`, state: { kind: 'linked' } })],
  ])('rejects %j', (value) => {
    expect(parseConnectionRegistry(value)).toBeNull();
  });
});

describe('migration of version 1 registries', () => {
  /** Minimal stand-in for the infrastructure URL rules. */
  const recognize = (url: string): UrlClassification => {
    const match = /^https:\/\/chatgpt\.com\/c\/([0-9a-f-]{36})$/.exec(url);
    const conversationId = match?.[1];
    return conversationId === undefined
      ? { kind: 'unsupported' }
      : {
          kind: 'conversation',
          conversation: { provider: 'chatgpt', origin: 'https://chatgpt.com', conversationId, canonicalUrl: url },
        };
  };

  const v1 = (canonicalUrl: string) => ({
    chatgpt: {
      revision: 3,
      link: {
        provider: 'chatgpt',
        tabId: 4,
        conversationId: A,
        canonicalUrl,
        state: { kind: 'stale', reason: 'left-conversation' },
      },
    },
    claude: { revision: 0, link: null },
  });

  it('converts a saved conversation link, keeping its tab, state and revision', () => {
    expect(migrateConnectionRegistryV1(v1(`https://chatgpt.com/c/${A}`), recognize)).toEqual({
      chatgpt: {
        revision: 3,
        link: {
          provider: 'chatgpt',
          origin: 'https://chatgpt.com',
          tabId: 4,
          identity: { kind: 'saved', conversationId: A, canonicalUrl: `https://chatgpt.com/c/${A}`, source: 'selected' },
          state: { kind: 'stale', reason: 'left-conversation' },
        },
      },
      claude: { revision: 0, link: null },
    });
  });

  it('drops a link whose stored URL is no longer recognized as the same conversation', () => {
    expect(migrateConnectionRegistryV1(v1('https://chatgpt.com.evil.example/c/x'), recognize)?.chatgpt).toEqual({
      revision: 4,
      link: null,
    });
    expect(migrateConnectionRegistryV1(v1(`https://chatgpt.com/c/${B}`), recognize)?.chatgpt).toEqual({
      revision: 4,
      link: null,
    });
  });

  it('rejects malformed version 1 data', () => {
    expect(migrateConnectionRegistryV1({ chatgpt: { revision: 'x' } }, recognize)).toBeNull();
    expect(migrateConnectionRegistryV1(42, recognize)).toBeNull();
  });
});

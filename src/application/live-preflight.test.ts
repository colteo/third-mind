import { describe, expect, it } from 'vitest';
import type { ConversationProviderId } from '../domain';
import { createConsumerSiteAdapters } from '../infrastructure/live/consumer-site-adapters';
import type { LiveAdapterRegistry } from '../ports';
import { createTestClock } from '../test-support/fixtures';
import {
  CHATGPT_CONVERSATION,
  CHATGPT_TAB,
  CLAUDE_CONVERSATION,
  CLAUDE_TAB,
  CREATED_CONVERSATIONS,
  ORIGINS,
  createFakeConnections,
  createFakeLiveAdapter,
  createFakeTransport,
  linkedConnections,
  newChatConnections,
  newChatIdentity,
  type FakeConnections,
  type FakeTransport,
} from '../test-support/live-fakes';
import type { PreflightIssueCode } from './live-capabilities';
import type { NewChatBinding } from './execution-mode';
import { createLivePreflight, type LivePreflightResult, type ProviderPreflight } from './live-preflight';

/** Transport showing a new-chat document in both linked tabs. */
function newChatTransport(): FakeTransport {
  const transport = createFakeTransport();
  transport.showNewChat(CHATGPT_TAB, 'chatgpt', 'page-chatgpt-new');
  transport.showNewChat(CLAUDE_TAB, 'claude', 'page-claude-new');
  return transport;
}

function fakeAdapters(): LiveAdapterRegistry {
  return { chatgpt: createFakeLiveAdapter('chatgpt').adapter, claude: createFakeLiveAdapter('claude').adapter };
}

function setup(
  connections: FakeConnections = linkedConnections(),
  adapters: LiveAdapterRegistry = fakeAdapters(),
  transport: FakeTransport = createFakeTransport(),
) {
  const preflight = createLivePreflight({ connections, transport, adapters, clock: createTestClock() });
  return { preflight, connections, transport };
}

function providerOf(result: LivePreflightResult, provider: ConversationProviderId): ProviderPreflight {
  const found = result.providers.find((candidate) => candidate.provider === provider);
  if (found === undefined) throw new Error(`No preflight for ${provider}`);
  return found;
}

function codes(result: LivePreflightResult, provider: ConversationProviderId): readonly PreflightIssueCode[] {
  return providerOf(result, provider).issues.map((issue) => issue.code);
}

describe('live preflight', () => {
  it('reports ready when both conversations, pages and authorized adapters are available', async () => {
    const { preflight, connections } = setup();
    const result = await preflight.run();
    expect(result.ready).toBe(true);
    expect(result.issues).toEqual([]);
    expect(connections.refreshCount).toBe(1);
    expect(providerOf(result, 'chatgpt')).toMatchObject({
      technicallyReady: true,
      authorized: true,
      ready: true,
      target: { kind: 'conversation', conversationId: CHATGPT_CONVERSATION },
      binding: {
        kind: 'conversation',
        provider: 'chatgpt',
        tabId: CHATGPT_TAB,
        conversationId: CHATGPT_CONVERSATION,
        source: 'linked',
      },
    });
    expect(providerOf(result, 'claude').binding).toMatchObject({ tabId: CLAUDE_TAB, conversationId: CLAUDE_CONVERSATION });
    expect(result.revisions).toEqual({ chatgpt: 1, claude: 1 });
  });

  it('rejects a missing ChatGPT connection with an actionable ChatGPT-specific reason', async () => {
    const { preflight } = setup(createFakeConnections().link('claude'));
    const result = await preflight.run();
    expect(result.ready).toBe(false);
    expect(codes(result, 'chatgpt')).toEqual(['not-linked']);
    expect(providerOf(result, 'chatgpt').issues[0]?.message).toContain(
      'Link a saved ChatGPT conversation or a new ChatGPT chat',
    );
    expect(providerOf(result, 'chatgpt').capabilities.transport.status).toBe('not-checked');
    expect(providerOf(result, 'claude').ready).toBe(true);
  });

  it('rejects a missing Claude connection', async () => {
    const { preflight } = setup(createFakeConnections().link('chatgpt'));
    const result = await preflight.run();
    expect(result.ready).toBe(false);
    expect(codes(result, 'claude')).toEqual(['not-linked']);
    expect(providerOf(result, 'claude').issues[0]?.message).toContain('Claude');
    expect(codes(result, 'chatgpt')).toEqual([]);
  });

  it('accepts linked new chats on both providers: a missing conversation id does not block', async () => {
    const result = await setup(newChatConnections(), fakeAdapters(), newChatTransport()).preflight.run();
    expect(result.ready).toBe(true);
    expect(result.issues).toEqual([]);
    expect(providerOf(result, 'chatgpt')).toMatchObject({
      ready: true,
      target: { kind: 'new-chat' },
      binding: {
        kind: 'new-chat',
        provider: 'chatgpt',
        tabId: CHATGPT_TAB,
        origin: 'https://chatgpt.com',
        pageInstanceId: 'page-chatgpt-new',
      },
    });
    expect(providerOf(result, 'claude')).toMatchObject({
      ready: true,
      target: { kind: 'new-chat' },
      binding: { kind: 'new-chat', provider: 'claude', tabId: CLAUDE_TAB, origin: 'https://claude.ai', pageInstanceId: 'page-claude-new' },
    });
    // Nothing is invented for a new chat.
    expect(providerOf(result, 'chatgpt').binding).not.toHaveProperty('conversationId');
  });

  it('mixes a saved conversation and a new chat', async () => {
    const transport = createFakeTransport();
    transport.showNewChat(CLAUDE_TAB, 'claude', 'page-claude-new');
    const connections = linkedConnections().link('claude', { identity: { kind: 'pending' } });
    const result = await setup(connections, fakeAdapters(), transport).preflight.run();
    expect(result.ready).toBe(true);
    expect(providerOf(result, 'chatgpt').binding).toMatchObject({ kind: 'conversation', source: 'linked' });
    expect(providerOf(result, 'claude').binding).toMatchObject({ kind: 'new-chat' });
  });

  it('asks the adapter about the new-chat target itself, and reports a route that cannot start new chats', async () => {
    const chatgpt = createFakeLiveAdapter('chatgpt', {
      capabilities: (target) =>
        Promise.resolve(
          target.kind === 'new-chat'
            ? {
                submission: { status: 'unavailable', reason: 'This route cannot start new chats.' },
                responseAcquisition: { status: 'available' },
              }
            : { submission: { status: 'available' }, responseAcquisition: { status: 'available' } },
        ),
    });
    const adapters = { ...fakeAdapters(), chatgpt: chatgpt.adapter };
    const result = await setup(newChatConnections(), adapters, newChatTransport()).preflight.run();
    expect(codes(result, 'chatgpt')).toEqual(['submission-unavailable']);
    expect(providerOf(result, 'chatgpt').target).toEqual({ kind: 'new-chat' });
  });

  it('probes a new chat page: it must show a new chat of the linked provider, with a message box', async () => {
    const transport = newChatTransport();
    // The new chat's tab now shows a conversation page although the link still expects the new chat.
    transport.reload(CHATGPT_TAB, 'chatgpt', CHATGPT_CONVERSATION, 'page-chatgpt-2');
    transport.set(CLAUDE_TAB, {
      ok: true,
      status: {
        provider: 'claude',
        page: { kind: 'new-chat' },
        documentState: 'loading',
        visibility: 'visible',
        composer: 'absent',
        tabId: CLAUDE_TAB,
        pageInstanceId: 'p',
        readiness: 'loading',
      },
    });
    const result = await setup(newChatConnections(), fakeAdapters(), transport).preflight.run();
    expect(codes(result, 'chatgpt')).toEqual(['target-changed']);
    expect(codes(result, 'claude')).toEqual(['page-not-ready']);
    // Without an observed document there is no new-chat binding.
    expect(providerOf(result, 'chatgpt').binding).toBeNull();
    expect(providerOf(result, 'chatgpt').target).toEqual({ kind: 'new-chat' });
  });

  it('rejects a page that answers for the other provider', async () => {
    const transport = newChatTransport();
    transport.showNewChat(CHATGPT_TAB, 'claude', 'page-impostor');
    const result = await setup(newChatConnections(), fakeAdapters(), transport).preflight.run();
    expect(codes(result, 'chatgpt')).toEqual(['transport-unavailable']);
    expect(providerOf(result, 'chatgpt').issues[0]?.message).toBe('The linked tab does not show a ChatGPT page.');
  });

  it.each<[string, Parameters<FakeConnections['link']>[1], PreflightIssueCode]>([
    ['stale', { identity: { kind: 'pending' }, state: { kind: 'stale', reason: 'left-conversation' } }, 'link-stale'],
    ['closed', { identity: { kind: 'pending' }, state: { kind: 'disconnected', reason: 'tab-closed' } }, 'link-disconnected'],
    ['unverifiable', { identity: { kind: 'pending' }, state: { kind: 'unavailable', reason: 'tab-query-failed' } }, 'link-unavailable'],
    ['unconfirmed', { identity: newChatIdentity(CREATED_CONVERSATIONS.chatgpt, 'unconfirmed') }, 'identity-unconfirmed'],
  ])('keeps a %s new-chat link blocked', async (_name, options, code) => {
    const connections = newChatConnections().link('chatgpt', options);
    const result = await setup(connections, fakeAdapters(), newChatTransport()).preflight.run();
    expect(result.ready).toBe(false);
    expect(codes(result, 'chatgpt')).toEqual([code]);
  });

  it('verifies a new-chat binding: same tab, origin and document, still on the new chat', async () => {
    const { preflight, transport, connections } = setup(newChatConnections(), fakeAdapters(), newChatTransport());
    const binding = providerOf(await preflight.run(), 'chatgpt').binding as NewChatBinding;
    await expect(preflight.verifyTarget(binding)).resolves.toEqual({
      ok: true,
      target: {
        kind: 'new-chat',
        provider: 'chatgpt',
        tabId: CHATGPT_TAB,
        origin: ORIGINS.chatgpt,
        pageInstanceId: 'page-chatgpt-new',
      },
    });
    // A reloaded new chat is a different document from the one approved.
    transport.showNewChat(CHATGPT_TAB, 'chatgpt', 'page-chatgpt-reloaded');
    await expect(preflight.verifyTarget(binding)).resolves.toMatchObject({ ok: false, issue: { code: 'target-changed' } });
    transport.showNewChat(CHATGPT_TAB, 'chatgpt', 'page-chatgpt-new');
    // Re-linking the provider to a saved conversation is not the new chat.
    connections.link('chatgpt');
    await expect(preflight.verifyTarget(binding)).resolves.toMatchObject({ ok: false, issue: { code: 'target-changed' } });
  });

  it('observes the expected new-chat-to-conversation transition on the same document', async () => {
    const { preflight, transport, connections } = setup(newChatConnections(), fakeAdapters(), newChatTransport());
    const binding = providerOf(await preflight.run(), 'chatgpt').binding as NewChatBinding;
    await expect(preflight.observeNewChat(binding)).resolves.toMatchObject({
      kind: 'new-chat',
      pageInstanceId: 'page-chatgpt-new',
    });

    transport.navigateWithinDocument(CHATGPT_TAB, 'chatgpt', CREATED_CONVERSATIONS.chatgpt);
    connections.link('chatgpt', { identity: newChatIdentity(CREATED_CONVERSATIONS.chatgpt) });
    await expect(preflight.observeNewChat(binding)).resolves.toEqual({
      kind: 'conversation',
      conversationId: CREATED_CONVERSATIONS.chatgpt,
      pageInstanceId: 'page-chatgpt-new',
      linkRevision: 2,
    });

    // A move to an unrelated conversation makes the link stale: the target is invalid.
    connections.link('chatgpt', {
      identity: { kind: 'pending' },
      state: { kind: 'stale', reason: 'different-conversation' },
    });
    await expect(preflight.observeNewChat(binding)).resolves.toMatchObject({ kind: 'invalid' });
  });

  it('rejects an unconfirmed identity', async () => {
    const connections = linkedConnections().link('claude', {
      identity: {
        kind: 'unconfirmed',
        conversationId: CLAUDE_CONVERSATION,
        canonicalUrl: 'https://example.invalid/x',
        reason: 'observation-gap',
      },
    });
    const result = await setup(connections).preflight.run();
    expect(codes(result, 'claude')).toEqual(['identity-unconfirmed']);
  });

  it.each<[string, Parameters<FakeConnections['link']>[1], PreflightIssueCode]>([
    ['stale', { state: { kind: 'stale', reason: 'different-conversation' } }, 'link-stale'],
    ['disconnected', { state: { kind: 'disconnected', reason: 'tab-closed' } }, 'link-disconnected'],
    ['unavailable', { state: { kind: 'unavailable', reason: 'tab-unreadable' } }, 'link-unavailable'],
  ])('rejects a %s link', async (_name, options, code) => {
    const result = await setup(linkedConnections().link('chatgpt', options)).preflight.run();
    expect(result.ready).toBe(false);
    expect(codes(result, 'chatgpt')).toEqual([code]);
  });

  it('rejects every link when the open tabs could not be listed', async () => {
    const result = await setup(linkedConnections().failDiscovery()).preflight.run();
    expect(codes(result, 'chatgpt')).toEqual(['tabs-unreadable']);
    expect(codes(result, 'claude')).toEqual(['tabs-unreadable']);
  });

  it('rejects a command from a panel that showed older link revisions', async () => {
    const { preflight } = setup();
    const result = await preflight.run({ expectedRevisions: { chatgpt: 1, claude: 0 } });
    expect(result.ready).toBe(false);
    expect(codes(result, 'claude')).toEqual(['view-outdated']);
    expect(codes(result, 'chatgpt')).toEqual([]);
  });

  it('reports an unavailable provider transport', async () => {
    const transport = createFakeTransport();
    transport.set(CHATGPT_TAB, { ok: false, failure: { kind: 'content-script-unavailable', outcome: 'not-performed' } });
    transport.set(CLAUDE_TAB, { ok: false, failure: { kind: 'timeout', outcome: 'unknown' } });
    const result = await setup(linkedConnections(), fakeAdapters(), transport).preflight.run();
    expect(codes(result, 'chatgpt')).toEqual(['content-script-unavailable']);
    expect(providerOf(result, 'chatgpt').issues[0]?.message).toContain('Reload that tab');
    expect(codes(result, 'claude')).toEqual(['transport-unavailable']);
    // Without a verified page there is no target, so the adapter is not asked.
    expect(providerOf(result, 'claude').capabilities.submission.status).toBe('not-checked');
  });

  it('reports a page that is not ready, and a page that shows another conversation', async () => {
    const transport = createFakeTransport();
    transport.set(CHATGPT_TAB, {
      ok: true,
      status: {
        provider: 'chatgpt',
        page: { kind: 'conversation', conversationId: CHATGPT_CONVERSATION },
        documentState: 'complete',
        visibility: 'visible',
        composer: 'absent',
        tabId: CHATGPT_TAB,
        pageInstanceId: 'p',
        readiness: 'composer-missing',
      },
    });
    transport.reload(CLAUDE_TAB, 'claude', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'p2');
    const result = await setup(linkedConnections(), fakeAdapters(), transport).preflight.run();
    expect(codes(result, 'chatgpt')).toEqual(['page-not-ready']);
    expect(codes(result, 'claude')).toEqual(['target-changed']);
  });

  it('reports submission capability unavailable while staying authorized', async () => {
    const chatgpt = createFakeLiveAdapter('chatgpt', {
      capabilities: {
        submission: { status: 'unavailable', reason: 'Submission is switched off in this test.' },
        responseAcquisition: { status: 'available' },
      },
    });
    const result = await setup(linkedConnections(), { ...fakeAdapters(), chatgpt: chatgpt.adapter }).preflight.run();
    const provider = providerOf(result, 'chatgpt');
    expect(provider).toMatchObject({ technicallyReady: false, authorized: true, ready: false });
    expect(codes(result, 'chatgpt')).toEqual(['submission-unavailable']);
    expect(provider.issues[0]?.message).toBe('Submission is switched off in this test.');
  });

  it('reports response capability unavailable', async () => {
    const claude = createFakeLiveAdapter('claude', {
      capabilities: {
        submission: { status: 'available' },
        responseAcquisition: { status: 'unavailable', reason: 'Responses cannot be read in this test.' },
      },
    });
    const result = await setup(linkedConnections(), { ...fakeAdapters(), claude: claude.adapter }).preflight.run();
    expect(result.ready).toBe(false);
    expect(codes(result, 'claude')).toEqual(['response-unavailable']);
  });

  it('keeps technical readiness and authorization apart', async () => {
    const chatgpt = createFakeLiveAdapter('chatgpt', {
      authorization: { kind: 'not-authorized', reason: 'This route is not permitted.' },
    });
    const result = await setup(linkedConnections(), { ...fakeAdapters(), chatgpt: chatgpt.adapter }).preflight.run();
    expect(providerOf(result, 'chatgpt')).toMatchObject({ technicallyReady: true, authorized: false, ready: false });
    expect(codes(result, 'chatgpt')).toEqual(['automation-not-authorized']);
    expect(result.ready).toBe(false);
  });

  it('never infers submission from a page that answers: the shipped consumer-site route is unsupported', async () => {
    const transport = createFakeTransport();
    const result = await setup(linkedConnections(), createConsumerSiteAdapters(), transport).preflight.run();
    expect(transport.probeCount).toBe(2);
    for (const provider of ['chatgpt', 'claude'] as const) {
      const preflight = providerOf(result, provider);
      expect(preflight.capabilities.connection.status).toBe('available');
      expect(preflight.capabilities.transport.status).toBe('available');
      expect(preflight.capabilities.submission.status).toBe('unavailable');
      expect(preflight.capabilities.responseAcquisition.status).toBe('unavailable');
      expect(preflight.capabilities.authorization.status).toBe('unavailable');
      expect(preflight).toMatchObject({ technicallyReady: false, authorized: false, ready: false });
      expect(codes(result, provider)).toEqual(['submission-unavailable', 'response-unavailable', 'automation-not-authorized']);
    }
    expect(result.ready).toBe(false);
  });

  it('reports a provider without any adapter', async () => {
    const result = await setup(linkedConnections(), { claude: createFakeLiveAdapter('claude').adapter }).preflight.run();
    expect(providerOf(result, 'chatgpt').route).toBeNull();
    expect(codes(result, 'chatgpt')).toEqual(['no-adapter', 'no-adapter', 'no-adapter']);
  });

  it('reports an adapter that fails to describe its capabilities', async () => {
    const chatgpt = createFakeLiveAdapter('chatgpt', { capabilities: () => Promise.reject(new Error('boom')) });
    const result = await setup(linkedConnections(), { ...fakeAdapters(), chatgpt: chatgpt.adapter }).preflight.run();
    expect(codes(result, 'chatgpt')).toEqual(['adapter-error', 'adapter-error']);
  });

  it('rejects a session whose link now points at another conversation', async () => {
    const { preflight, connections } = setup();
    const started = await preflight.run();
    const targets = {
      chatgpt: { kind: 'ready', binding: providerOf(started, 'chatgpt').binding! },
      claude: { kind: 'ready', binding: providerOf(started, 'claude').binding! },
    } as const;
    connections.link('chatgpt', {
      identity: {
        kind: 'saved',
        conversationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        canonicalUrl: 'https://example.invalid/d',
        source: 'selected',
      },
    });
    const result = await preflight.run({ expectedTargets: targets });
    expect(codes(result, 'chatgpt')).toEqual(['target-changed']);
    expect(codes(result, 'claude')).toEqual([]);
  });

  it('verifies a bound target before each operation', async () => {
    const { preflight, transport, connections } = setup();
    const started = await preflight.run();
    const binding = providerOf(started, 'chatgpt').binding!;
    await expect(preflight.verifyTarget(binding)).resolves.toEqual({
      ok: true,
      target: {
        kind: 'conversation',
        provider: 'chatgpt',
        tabId: CHATGPT_TAB,
        conversationId: CHATGPT_CONVERSATION,
        pageInstanceId: 'page-chatgpt-1',
      },
    });
    transport.reload(CHATGPT_TAB, 'chatgpt', CHATGPT_CONVERSATION, 'page-chatgpt-2');
    await expect(preflight.verifyTarget(binding)).resolves.toMatchObject({ ok: true, target: { pageInstanceId: 'page-chatgpt-2' } });
    connections.link('chatgpt', { state: { kind: 'stale', reason: 'left-conversation' } });
    await expect(preflight.verifyTarget(binding)).resolves.toMatchObject({ ok: false, issue: { code: 'link-stale' } });
  });
});

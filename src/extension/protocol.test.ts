import { describe, expect, it } from 'vitest';
import { isConnectionMessage, parseClientMessage, parseHostMessage, type ClientMessage } from './protocol';

describe('client message parsing', () => {
  it('accepts well-formed messages', () => {
    expect(
      parseClientMessage({ type: 'start', topic: 'T', constraints: ['a'], scenario: 'full-debate', pace: 'slow' }),
    ).toEqual({
      type: 'start',
      topic: 'T',
      constraints: ['a'],
      scenario: 'full-debate',
      pace: 'slow',
    });
    expect(parseClientMessage({ type: 'pause', sessionId: 's-1' })).toEqual({ type: 'pause', sessionId: 's-1' });
    expect(parseClientMessage({ type: 'reset', sessionId: 's-1' })).toEqual({ type: 'reset', sessionId: 's-1' });
    expect(parseClientMessage({ type: 'add-constraint', sessionId: 's-1', content: 'x' })).toEqual({
      type: 'add-constraint',
      sessionId: 's-1',
      content: 'x',
    });
    expect(parseClientMessage({ type: 'reissue-operation', sessionId: 's-1', operationId: 'op' })).toEqual({
      type: 'reissue-operation',
      sessionId: 's-1',
      operationId: 'op',
    });
  });

  it.each<[unknown]>([
    [null],
    ['pause'],
    [[]],
    [{ type: 'explode', sessionId: 's-1' }],
    [{ type: 'start', topic: 1, constraints: [], scenario: 'full-debate', pace: 'standard' }],
    [{ type: 'start', topic: 'T', constraints: [1], scenario: 'full-debate', pace: 'standard' }],
    [{ type: 'start', topic: 'T', constraints: [], scenario: 'live-chatgpt', pace: 'standard' }],
    [{ type: 'start', topic: 'T', constraints: [], scenario: 'full-debate' }],
    [{ type: 'start', topic: 'T', constraints: [], scenario: 'full-debate', pace: 'instant' }],
    // Session-scoped commands must name the session they act on.
    [{ type: 'pause' }],
    [{ type: 'resume', sessionId: '' }],
    [{ type: 'reset' }],
    [{ type: 'add-constraint', content: 'x' }],
    [{ type: 'add-constraint', sessionId: 's-1' }],
    [{ type: 'reissue-operation', sessionId: 's-1', operationId: '' }],
  ])('rejects %j', (value) => {
    expect(parseClientMessage(value)).toBeNull();
  });
});

describe('host message parsing', () => {
  it('accepts snapshots and rejections, and nothing else', () => {
    for (const mode of [null, 'simulation', 'live']) {
      const snapshot = {
        type: 'snapshot',
        snapshot: { mode, participants: [], liveParticipants: [], session: null, scenario: null, pace: null },
      };
      expect(parseHostMessage(snapshot)).toEqual(snapshot);
    }
    expect(parseHostMessage({ type: 'command-rejected', command: 'pause', reason: 'No' })).not.toBeNull();
    expect(parseHostMessage({ type: 'snapshot', snapshot: { mode: 'live' } })).toBeNull();
    expect(
      parseHostMessage({ type: 'snapshot', snapshot: { mode: 'remote', participants: [], liveParticipants: [] } }),
    ).toBeNull();
    expect(parseHostMessage(42)).toBeNull();
  });

  it('accepts live readiness results', () => {
    const message = { type: 'live-readiness', readiness: { ready: false, providers: [], issues: [] } };
    expect(parseHostMessage(message)).toEqual(message);
    expect(parseHostMessage({ type: 'live-readiness', readiness: {} })).toBeNull();
  });
});

describe('live message parsing', () => {
  it('accepts a readiness check and a live start with link revisions', () => {
    expect(parseClientMessage({ type: 'check-live-readiness' })).toEqual({ type: 'check-live-readiness' });
    expect(
      parseClientMessage({
        type: 'start-live',
        topic: 'T',
        constraints: ['a'],
        expectedRevisions: { chatgpt: 2, claude: 5 },
        extra: 'ignored',
      }),
    ).toEqual({ type: 'start-live', topic: 'T', constraints: ['a'], expectedRevisions: { chatgpt: 2, claude: 5 } });
  });

  it.each<[unknown]>([
    [{ type: 'start-live', topic: 'T', constraints: [] }],
    [{ type: 'start-live', topic: 'T', constraints: [], expectedRevisions: { chatgpt: 1 } }],
    [{ type: 'start-live', topic: 'T', constraints: [], expectedRevisions: { chatgpt: -1, claude: 0 } }],
    [{ type: 'start-live', topic: 'T', constraints: [3], expectedRevisions: { chatgpt: 0, claude: 0 } }],
    [{ type: 'start-live', topic: 7, constraints: [], expectedRevisions: { chatgpt: 0, claude: 0 } }],
  ])('rejects a malformed live start %#', (value) => {
    expect(parseClientMessage(value)).toBeNull();
  });

  it('never routes live commands to the connection coordinator', () => {
    expect(isConnectionMessage({ type: 'check-live-readiness' })).toBe(false);
  });
});

describe('connection message parsing', () => {
  it('accepts well-formed connection commands', () => {
    expect(parseClientMessage({ type: 'refresh-connections' })).toEqual({ type: 'refresh-connections' });
    expect(
      parseClientMessage({
        type: 'link-conversation',
        provider: 'chatgpt',
        tabId: 12,
        conversationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        expectedRevision: 0,
        extra: 'ignored',
      }),
    ).toEqual({
      type: 'link-conversation',
      provider: 'chatgpt',
      tabId: 12,
      conversationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      expectedRevision: 0,
    });
    expect(parseClientMessage({ type: 'reconnect-conversation', provider: 'claude', tabId: 3, expectedRevision: 2 })).toEqual({
      type: 'reconnect-conversation',
      provider: 'claude',
      tabId: 3,
      expectedRevision: 2,
    });
    expect(parseClientMessage({ type: 'disconnect-conversation', provider: 'claude', expectedRevision: 5 })).toEqual({
      type: 'disconnect-conversation',
      provider: 'claude',
      expectedRevision: 5,
    });
  });

  it('accepts new chat and identity confirmation commands, dropping anything the host must not trust', () => {
    expect(
      parseClientMessage({
        type: 'link-new-chat',
        provider: 'claude',
        tabId: 4,
        expectedRevision: 0,
        // A client cannot supply a URL or invent an identifier for a new chat.
        url: 'https://claude.ai/chat/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        conversationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      }),
    ).toEqual({ type: 'link-new-chat', provider: 'claude', tabId: 4, expectedRevision: 0 });
    expect(
      parseClientMessage({
        type: 'confirm-conversation-identity',
        provider: 'chatgpt',
        tabId: 7,
        conversationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        expectedRevision: 3,
        canonicalUrl: 'https://evil.example/',
      }),
    ).toEqual({
      type: 'confirm-conversation-identity',
      provider: 'chatgpt',
      tabId: 7,
      conversationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      expectedRevision: 3,
    });
  });

  it.each<[unknown]>([
    [{ type: 'link-conversation', provider: 'gemini', tabId: 1, conversationId: 'a', expectedRevision: 0 }],
    [{ type: 'link-conversation', provider: 'chatgpt', tabId: -1, conversationId: 'a', expectedRevision: 0 }],
    [{ type: 'link-conversation', provider: 'chatgpt', tabId: 1.5, conversationId: 'a', expectedRevision: 0 }],
    [{ type: 'link-conversation', provider: 'chatgpt', tabId: '1', conversationId: 'a', expectedRevision: 0 }],
    [{ type: 'link-conversation', provider: 'chatgpt', tabId: 1, conversationId: '', expectedRevision: 0 }],
    [{ type: 'link-conversation', provider: 'chatgpt', tabId: 1, conversationId: 'a'.repeat(129), expectedRevision: 0 }],
    [{ type: 'link-conversation', provider: 'chatgpt', tabId: 1, conversationId: 'a' }],
    [{ type: 'reconnect-conversation', provider: 'claude', tabId: 1 }],
    [{ type: 'reconnect-conversation', provider: 'claude', tabId: 1, expectedRevision: -1 }],
    [{ type: 'disconnect-conversation', expectedRevision: 0 }],
    [{ type: 'disconnect-conversation', provider: 'claude', expectedRevision: Number.NaN }],
    [{ type: 'disconnect-conversation', provider: '__proto__', expectedRevision: 0 }],
    [{ type: 'link-new-chat', provider: 'chatgpt', tabId: 1 }],
    [{ type: 'link-new-chat', provider: 'chatgpt', expectedRevision: 0 }],
    [{ type: 'link-new-chat', provider: 'gemini', tabId: 1, expectedRevision: 0 }],
    [{ type: 'link-new-chat', provider: 'chatgpt', tabId: -3, expectedRevision: 0 }],
    [{ type: 'link-new-chat', provider: 'chatgpt', tabId: Number.MAX_SAFE_INTEGER + 2, expectedRevision: 0 }],
    [{ type: 'confirm-conversation-identity', provider: 'chatgpt', tabId: 1, expectedRevision: 0 }],
    [{ type: 'confirm-conversation-identity', provider: 'chatgpt', tabId: 1, conversationId: '', expectedRevision: 0 }],
    [{ type: 'confirm-conversation-identity', provider: 'chatgpt', tabId: 1, conversationId: 7, expectedRevision: 0 }],
    [{ type: 'confirm-conversation-identity', provider: 'chatgpt', tabId: 1, conversationId: 'a'.repeat(129), expectedRevision: 0 }],
    [{ type: 'confirm-conversation-identity', provider: 'chatgpt', conversationId: 'a', expectedRevision: 0 }],
    [{ type: 'confirm-conversation-identity', provider: 'claude', tabId: 1, conversationId: 'a', expectedRevision: 1.5 }],
  ])('rejects %j', (value) => {
    expect(parseClientMessage(value)).toBeNull();
  });

  it('accepts connection views as a separate host message', () => {
    const message = {
      type: 'connections',
      connections: { discovery: 'ready', discoveryError: null, unavailableTabCount: 0, providers: [] },
    };
    expect(parseHostMessage(message)).toEqual(message);
    expect(parseHostMessage({ type: 'connections', connections: {} })).toBeNull();
  });

  it('keeps debate snapshots and connection views apart', () => {
    // A connection view is not a debate snapshot, and a debate snapshot never carries links.
    expect(parseHostMessage({ type: 'snapshot', snapshot: { providers: [] } })).toBeNull();
    expect(
      parseHostMessage({
        type: 'connections',
        connections: { mode: 'simulation', participants: [], session: null, scenario: null, pace: null },
      }),
    ).toBeNull();
  });
});

describe('message routing', () => {
  it('routes every link command to the connection coordinator and debate commands to the runner', () => {
    const connection: ClientMessage[] = [
      { type: 'refresh-connections' },
      { type: 'link-conversation', provider: 'chatgpt', tabId: 1, conversationId: 'a', expectedRevision: 0 },
      { type: 'link-new-chat', provider: 'chatgpt', tabId: 1, expectedRevision: 0 },
      { type: 'confirm-conversation-identity', provider: 'chatgpt', tabId: 1, conversationId: 'a', expectedRevision: 0 },
      { type: 'reconnect-conversation', provider: 'claude', tabId: 1, expectedRevision: 0 },
      { type: 'disconnect-conversation', provider: 'claude', expectedRevision: 0 },
    ];
    expect(connection.every(isConnectionMessage)).toBe(true);
    expect(isConnectionMessage({ type: 'pause', sessionId: 's-1' })).toBe(false);
    // Page checks are handled by the transport, not by the link coordinator.
    expect(isConnectionMessage({ type: 'check-provider-page', provider: 'claude' })).toBe(false);
  });
});

describe('page check messages', () => {
  it('accepts a page check that names only a provider', () => {
    expect(parseClientMessage({ type: 'check-provider-page', provider: 'chatgpt' })).toEqual({
      type: 'check-provider-page',
      provider: 'chatgpt',
    });
    // The panel cannot choose the tab or pass anything to the page: extra fields are dropped.
    expect(
      parseClientMessage({ type: 'check-provider-page', provider: 'claude', tabId: 99, code: 'document.body.innerText' }),
    ).toEqual({ type: 'check-provider-page', provider: 'claude' });
  });

  it.each<[unknown]>([
    [{ type: 'check-provider-page' }],
    [{ type: 'check-provider-page', provider: 'gemini' }],
    [{ type: 'check-provider-page', provider: '__proto__' }],
  ])('rejects %j', (value) => {
    expect(parseClientMessage(value)).toBeNull();
  });

  it('accepts page check results as a separate host message', () => {
    const message = {
      type: 'page-check',
      check: { provider: 'chatgpt', tabId: 1, result: { ok: false, failure: { kind: 'timeout', outcome: 'unknown' } } },
    };
    expect(parseHostMessage(message)).toEqual(message);
    expect(parseHostMessage({ type: 'page-check', check: { provider: 'chatgpt', tabId: 1 } })).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import { parseClientMessage, parseHostMessage } from './protocol';

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
    const snapshot = {
      type: 'snapshot',
      snapshot: { mode: 'simulation', participants: [], session: null, scenario: null, pace: null },
    };
    expect(parseHostMessage(snapshot)).toEqual(snapshot);
    expect(parseHostMessage({ type: 'command-rejected', command: 'pause', reason: 'No' })).not.toBeNull();
    expect(parseHostMessage({ type: 'snapshot', snapshot: { mode: 'live' } })).toBeNull();
    expect(parseHostMessage(42)).toBeNull();
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

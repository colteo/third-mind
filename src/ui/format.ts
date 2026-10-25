import type { ConnectionState, ConversationProviderId, DebateStatus, ProviderOperation } from '../domain';
import type { ConnectionStatus } from '../extension/side-panel-client';

export function statusLabel(status: DebateStatus | null, connection: ConnectionStatus): string {
  if (connection !== 'connected') {
    return connection === 'connecting' ? 'Connecting…' : 'Reconnecting…';
  }
  if (status === null) {
    return 'No session';
  }
  switch (status.kind) {
    case 'idle':
      return 'Ready';
    case 'running':
      return 'Running';
    case 'pausing':
      return 'Pausing…';
    case 'paused':
      return 'Paused';
    case 'completed':
      return 'Completed';
    case 'failed':
      return 'Failed';
  }
}

export function operationLabel(operation: ProviderOperation | undefined): string {
  if (operation === undefined) {
    return 'Not started';
  }
  switch (operation.status) {
    case 'pending':
      return 'Queued';
    case 'dispatched':
      return 'Waiting for the simulated response…';
    case 'acknowledged':
      return 'Received';
    case 'failed':
      return `Failed: ${operation.error}`;
    case 'uncertain':
      return 'Uncertain: interrupted by a background restart';
    case 'superseded':
      return 'Superseded by a new attempt';
  }
}

export function formatTime(timestamp: string): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime())
    ? timestamp
    : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function providerLabel(provider: ConversationProviderId): string {
  return provider === 'chatgpt' ? 'ChatGPT' : 'Claude';
}

export function connectionStateLabel(state: ConnectionState): string {
  switch (state.kind) {
    case 'linked':
      return 'Linked';
    case 'unavailable':
      return 'Unavailable';
    case 'stale':
      return 'Stale';
    case 'disconnected':
      return 'Disconnected';
  }
}

export function connectionStateDescription(state: ConnectionState): string {
  switch (state.kind) {
    case 'linked':
      return 'The tab is open and shows this conversation.';
    case 'unavailable':
      return state.reason === 'tab-unreadable'
        ? 'ThirdMind cannot read the address of this tab right now. The link is kept and checked again automatically.'
        : 'ThirdMind could not list the open tabs, so this link could not be checked. Use Refresh to try again.';
    case 'stale':
      return state.reason === 'different-conversation'
        ? 'The tab now shows a different conversation. This link is no longer valid.'
        : 'The tab no longer shows this conversation. This link is no longer valid.';
    case 'disconnected':
      return 'The tab was closed.';
  }
}

/** Short form of a conversation identifier for display. */
export function shortConversationId(conversationId: string): string {
  return conversationId.length > 8 ? `${conversationId.slice(0, 8)}…` : conversationId;
}

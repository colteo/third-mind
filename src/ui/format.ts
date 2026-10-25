import type { LinkedIdentityView } from '../application';
import type { ConversationProviderId, DebateStatus, LinkStatus, ProviderOperation } from '../domain';
import type { PageCheckView } from '../extension/protocol';
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

export function linkStatusLabel(status: LinkStatus): string {
  switch (status.kind) {
    case 'linked':
      return 'Linked';
    case 'awaiting-identity':
      return 'New chat — pending first message';
    case 'confirmation-required':
      return 'Confirmation required';
    case 'unavailable':
      return 'Unavailable';
    case 'stale':
      return 'Stale';
    case 'disconnected':
      return 'Disconnected';
  }
}

/**
 * Explains a link's status. `identity` matters only where a new chat and a
 * saved conversation need different wording.
 */
export function linkStatusDescription(status: LinkStatus, identity: LinkedIdentityView): string {
  switch (status.kind) {
    case 'linked':
      return identity.kind === 'saved' && identity.source === 'new-chat'
        ? 'The tab is open and shows this conversation. ThirdMind recorded it when the linked new chat was saved.'
        : 'The tab is open and shows this conversation.';
    case 'awaiting-identity':
      return 'The tab shows a new, empty chat. It gets a conversation address once its first message is sent in this tab; ThirdMind then records it automatically. Linking does not send any message.';
    case 'confirmation-required':
      return status.reason === 'observation-gap'
        ? 'The linked tab now shows a saved conversation, but ThirdMind was not watching the tab continuously (for example, the background service restarted), so it cannot tell whether this is the new chat you linked. Confirm only if you sent the first message of that new chat in this tab.'
        : 'The linked tab now shows a saved conversation that is also open in another tab, so it may be an existing conversation rather than the new chat you linked. Confirm only if you sent the first message of that new chat in this tab.';
    case 'unavailable':
      return status.reason === 'tab-unreadable'
        ? 'ThirdMind cannot read the address of this tab right now. The link is kept and checked again automatically.'
        : 'ThirdMind could not list the open tabs, so this link could not be checked. Use Refresh to try again.';
    case 'stale':
      if (identity.kind === 'pending') {
        return status.reason === 'different-conversation'
          ? 'The tab opened a conversation that is not the linked new chat (it was already open elsewhere, or belongs to another site). This link is no longer valid.'
          : 'The tab left the new chat before a conversation was saved. This link is no longer valid.';
      }
      return status.reason === 'different-conversation'
        ? 'The tab now shows a different conversation. This link is no longer valid.'
        : 'The tab no longer shows this conversation. This link is no longer valid.';
    case 'disconnected':
      return 'The tab was closed.';
  }
}

/** Describes the result of a page check (Phase 2.2B foundation). */
export function pageCheckDescription(result: PageCheckView['result'], label: string): string {
  if (result.ok) {
    const { status } = result;
    const page =
      status.page.kind === 'conversation'
        ? 'a saved conversation'
        : status.page.kind === 'new-chat'
          ? 'a new chat'
          : 'neither a conversation nor a new chat';
    const visibility = status.visibility === 'visible' ? 'visible' : 'in the background';
    switch (status.readiness) {
      case 'ready':
        return `Page connection active. The ${label} page shows ${page}, is ${visibility}, and its message box was found.`;
      case 'loading':
        return `Page connection active. The ${label} page is still loading. Check again in a moment.`;
      case 'composer-missing':
        return `Page connection active, but no message box was found on the ${label} page (it shows ${page}). You may need to sign in, wait for the page to finish loading, or ThirdMind may not recognize a changed page layout.`;
      case 'not-a-chat-page':
        return `Page connection active, but the ${label} page shows ${page}.`;
    }
  }
  switch (result.failure.kind) {
    case 'content-script-unavailable':
      return `ThirdMind's page connection is not active in this tab. Reload the ${label} tab (tabs opened before ThirdMind was installed, updated or reloaded need a reload), then check again.`;
    case 'timeout':
      return 'The page did not answer in time. This does not mean that anything failed on the page. Check again.';
    case 'navigated':
      return 'The tab navigated or reloaded during the check, so its answer was discarded. Check again.';
    case 'tab-closed':
      return 'The tab was closed.';
    case 'tab-unreadable':
      return "The tab's address could not be read.";
    case 'unsupported-page':
      return `The tab does not show a ${label} page.`;
    case 'wrong-provider':
      return `The tab does not show a ${label} page; it belongs to another provider.`;
    case 'invalid-response':
      return 'The page sent an answer that ThirdMind did not accept. Reload the tab and check again.';
    case 'transport-unavailable':
      return 'This browser does not allow ThirdMind to message the tab.';
    case 'transport-error':
      return 'The page could not be reached. Check again.';
  }
}

/** Short form of a conversation identifier for display. */
export function shortConversationId(conversationId: string): string {
  return conversationId.length > 8 ? `${conversationId.slice(0, 8)}…` : conversationId;
}

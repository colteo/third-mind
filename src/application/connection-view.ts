import {
  CONVERSATION_PROVIDERS,
  isSameConversation,
  tabShowsLinkedConversation,
  type BrowserTabId,
  type ConnectionState,
  type ConversationProviderId,
} from '../domain';
import type { ConnectionsSnapshot } from './connection-coordinator';

/**
 * Read model of the conversation links for the side panel. Contains only what
 * the panel displays: no URLs, and titles only for supported provider tabs.
 */

/**
 * - `available`: can be linked;
 * - `linked`: the tab of a healthy link;
 * - `reconnectable`: shows the conversation of a stale, disconnected or unavailable link.
 */
export type CandidateStatus = 'available' | 'linked' | 'reconnectable';

export interface ConversationCandidate {
  readonly tabId: BrowserTabId;
  readonly conversationId: string;
  readonly title: string | null;
  readonly status: CandidateStatus;
}

export interface LinkedConversationView {
  readonly tabId: BrowserTabId;
  readonly conversationId: string;
  readonly state: ConnectionState;
  /** Current tab title, only while the tab still shows the linked conversation. */
  readonly title: string | null;
}

export interface ProviderConnectionsView {
  readonly provider: ConversationProviderId;
  /** Slot revision; sent back with every command so outdated views are rejected. */
  readonly revision: number;
  readonly link: LinkedConversationView | null;
  /** Open conversations of this provider, in tab order. */
  readonly candidates: readonly ConversationCandidate[];
  /** Open tabs of this provider that do not show a recognized conversation (home page, new chat). */
  readonly otherPageCount: number;
}

export interface ConnectionsView {
  readonly discovery: 'pending' | 'ready' | 'failed';
  readonly discoveryError: string | null;
  /** Tabs whose URL could not be read. */
  readonly unavailableTabCount: number;
  readonly providers: readonly ProviderConnectionsView[];
}

export function buildConnectionsView({ registry, discovery }: ConnectionsSnapshot): ConnectionsView {
  const tabs = discovery.status === 'ready' ? discovery.tabs : [];
  return {
    discovery: discovery.status,
    discoveryError: discovery.status === 'failed' ? discovery.reason : null,
    unavailableTabCount: discovery.status === 'ready' ? discovery.unavailableTabCount : 0,
    providers: CONVERSATION_PROVIDERS.map((provider): ProviderConnectionsView => {
      const { revision, link } = registry[provider];
      const candidates: ConversationCandidate[] = [];
      let otherPageCount = 0;
      let linkTitle: string | null = null;
      for (const tab of tabs) {
        const { classification } = tab;
        if (classification.kind === 'provider-page' && classification.provider === provider) {
          otherPageCount += 1;
        }
        if (classification.kind !== 'conversation' || classification.conversation.provider !== provider) {
          continue;
        }
        const { conversation } = classification;
        let status: CandidateStatus = 'available';
        if (link !== null && isSameConversation(link, conversation)) {
          if (link.state.kind !== 'linked') {
            status = 'reconnectable';
          } else if (link.tabId === tab.tabId) {
            status = 'linked';
          }
        }
        if (link !== null && link.tabId === tab.tabId && tabShowsLinkedConversation(link, tab)) {
          linkTitle = tab.title;
        }
        candidates.push({ tabId: tab.tabId, conversationId: conversation.conversationId, title: tab.title, status });
      }
      return {
        provider,
        revision,
        link:
          link === null
            ? null
            : { tabId: link.tabId, conversationId: link.conversationId, state: link.state, title: linkTitle },
        candidates,
        otherPageCount,
      };
    }),
  };
}

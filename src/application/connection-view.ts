import {
  CONVERSATION_PROVIDERS,
  isSameConversation,
  linkStatus,
  tabShowsLinkTarget,
  type BrowserTabId,
  type ConfirmationReason,
  type ConversationIdentity,
  type ConversationProviderId,
  type IdentitySource,
  type LinkStatus,
} from '../domain';
import type { ConnectionsSnapshot } from './connection-coordinator';

/**
 * Read model of the conversation links for the side panel. Contains only what
 * the panel displays: no URLs, and titles only for supported provider tabs.
 */

/**
 * - `available`: can be linked;
 * - `linked`: the tab of the current link, showing what the link expects;
 * - `reconnectable`: shows the saved conversation of a stale, disconnected or unavailable link.
 */
export type CandidateStatus = 'available' | 'linked' | 'reconnectable';

export interface ConversationCandidate {
  readonly tabId: BrowserTabId;
  readonly conversationId: string;
  readonly title: string | null;
  readonly status: CandidateStatus;
}

/** An open new-chat page. It has no conversation identifier, so it can never be reconnectable. */
export interface NewChatCandidate {
  readonly tabId: BrowserTabId;
  readonly title: string | null;
  readonly status: Exclude<CandidateStatus, 'reconnectable'>;
}

/** The link's identity without URLs. */
export type LinkedIdentityView =
  | { readonly kind: 'saved'; readonly conversationId: string; readonly source: IdentitySource }
  | { readonly kind: 'pending' }
  | { readonly kind: 'unconfirmed'; readonly conversationId: string; readonly reason: ConfirmationReason };

export interface LinkedConversationView {
  readonly tabId: BrowserTabId;
  readonly identity: LinkedIdentityView;
  readonly status: LinkStatus;
  /** Current tab title, only while the tab still shows what the link expects. */
  readonly title: string | null;
}

export interface ProviderConnectionsView {
  readonly provider: ConversationProviderId;
  /** Slot revision; sent back with every command so outdated views are rejected. */
  readonly revision: number;
  readonly link: LinkedConversationView | null;
  /** Open saved conversations of this provider, in tab order. */
  readonly candidates: readonly ConversationCandidate[];
  /** Open new-chat pages of this provider, in tab order. */
  readonly newChats: readonly NewChatCandidate[];
  /** Open tabs of this provider that show neither a saved conversation nor a new chat (settings, projects). */
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
      const newChats: NewChatCandidate[] = [];
      let otherPageCount = 0;
      let linkTitle: string | null = null;
      for (const tab of tabs) {
        const { classification } = tab;
        const showsLinkTarget = link !== null && link.tabId === tab.tabId && tabShowsLinkTarget(link, tab);
        if (showsLinkTarget) {
          linkTitle = tab.title;
        }
        // A stale or disconnected link's former tab can be selected again like any other tab.
        const isLinkTab = showsLinkTarget && link.state.kind === 'linked';
        switch (classification.kind) {
          case 'provider-page':
            if (classification.provider === provider) {
              otherPageCount += 1;
            }
            break;
          case 'new-chat':
            if (classification.provider === provider) {
              newChats.push({ tabId: tab.tabId, title: tab.title, status: isLinkTab ? 'linked' : 'available' });
            }
            break;
          case 'conversation': {
            const { conversation } = classification;
            if (conversation.provider !== provider) {
              break;
            }
            let status: CandidateStatus = isLinkTab ? 'linked' : 'available';
            if (link !== null && isSameConversation(link, conversation) && link.state.kind !== 'linked') {
              status = 'reconnectable';
            }
            candidates.push({ tabId: tab.tabId, conversationId: conversation.conversationId, title: tab.title, status });
            break;
          }
          case 'unsupported':
          case 'unavailable':
            break;
        }
      }
      return {
        provider,
        revision,
        link:
          link === null
            ? null
            : { tabId: link.tabId, identity: identityView(link.identity), status: linkStatus(link), title: linkTitle },
        candidates,
        newChats,
        otherPageCount,
      };
    }),
  };
}

function identityView(identity: ConversationIdentity): LinkedIdentityView {
  switch (identity.kind) {
    case 'saved':
      return { kind: 'saved', conversationId: identity.conversationId, source: identity.source };
    case 'pending':
      return { kind: 'pending' };
    case 'unconfirmed':
      return { kind: 'unconfirmed', conversationId: identity.conversationId, reason: identity.reason };
  }
}

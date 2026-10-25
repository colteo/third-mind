import { useId, useState } from 'react';
import type {
  ConnectionsView,
  ConversationCandidate,
  LinkedConversationView,
  NewChatCandidate,
  ProviderConnectionsView,
} from '../../application';
import type { ConnectionClientMessage, PageCheckClientMessage, PageCheckView } from '../../extension/protocol';
import type { PageChecks } from '../use-debate-host';
import {
  linkStatusDescription,
  linkStatusLabel,
  pageCheckDescription,
  providerLabel,
  shortConversationId,
} from '../format';

type ConnectionsCommand = ConnectionClientMessage | PageCheckClientMessage;

interface ConversationConnectionsProps {
  /** `null` until the background service has sent the first view. */
  readonly view: ConnectionsView | null;
  /** Latest page check per provider (Phase 2.2B foundation). */
  readonly pageChecks?: PageChecks;
  readonly onCommand: (message: ConnectionsCommand) => void;
}

/**
 * Linked conversations (Phase 2.1; new chats Phase 2.2A). Associates open
 * ChatGPT and Claude tabs, showing a saved conversation or a new empty chat,
 * with ThirdMind. Nothing here reads or sends messages, and the simulated
 * debate does not use these links. A linked tab's page connection can be
 * checked (Phase 2.2B foundation); the check only reports readiness.
 *
 * Tab titles are untrusted. They are only ever rendered as React text, never as HTML.
 */
export function ConversationConnections({ view, pageChecks = {}, onCommand }: ConversationConnectionsProps) {
  const id = useId();
  // The view once the first tab scan has finished.
  const ready = view !== null && view.discovery !== 'pending' ? view : null;
  return (
    <section className="card connections" aria-labelledby={`${id}-heading`}>
      <div className="card-heading">
        <h2 id={`${id}-heading`}>Linked conversations</h2>
        <button
          type="button"
          className="button"
          disabled={view === null}
          onClick={() => {
            onCommand({ type: 'refresh-connections' });
          }}
        >
          Refresh
        </button>
      </div>
      <p className="hint">
        Link an open ChatGPT or Claude conversation, or a new empty chat, to ThirdMind. ThirdMind only records which tab
        shows which conversation. It does not read or send messages, and the simulated debate does not use linked
        conversations.
      </p>

      {ready === null && <p className="muted">Looking for open conversations…</p>}

      {view?.discovery === 'failed' && (
        <div className="notice notice-error connections-notice" role="alert">
          {view.discoveryError ?? 'The open tabs could not be listed.'}
        </div>
      )}

      {ready !== null && ready.unavailableTabCount > 0 && (
        <p className="hint">
          {ready.unavailableTabCount === 1
            ? '1 tab could not be inspected and is not listed.'
            : `${ready.unavailableTabCount} tabs could not be inspected and are not listed.`}
        </p>
      )}

      {ready !== null &&
        ready.providers.map((provider) => (
          <ProviderConnection
            key={provider.provider}
            view={provider}
            canSelect={ready.discovery === 'ready'}
            pageCheck={pageChecks[provider.provider] ?? null}
            onCommand={onCommand}
          />
        ))}
    </section>
  );
}

interface ProviderConnectionProps {
  readonly view: ProviderConnectionsView;
  /** False when the tabs could not be listed: no candidate is trustworthy. */
  readonly canSelect: boolean;
  readonly pageCheck: PageCheckView | null;
  readonly onCommand: (message: ConnectionsCommand) => void;
}

type Selectable =
  | { readonly kind: 'conversation'; readonly candidate: ConversationCandidate }
  | { readonly kind: 'new-chat'; readonly candidate: NewChatCandidate };

function selectableKey(selectable: Selectable): string {
  return selectable.kind === 'conversation'
    ? `conversation:${selectable.candidate.tabId}:${selectable.candidate.conversationId}`
    : `new-chat:${selectable.candidate.tabId}`;
}

function ProviderConnection({ view, canSelect, pageCheck, onCommand }: ProviderConnectionProps) {
  const id = useId();
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const { provider, revision, link } = view;
  const label = providerLabel(provider);
  const state = link?.status.kind ?? 'none';
  // Selection is never automatic, not even with a single candidate.
  const conversations: Selectable[] = view.candidates
    .filter((candidate) => candidate.status === 'available')
    .map((candidate) => ({ kind: 'conversation' as const, candidate }));
  const newChats: Selectable[] = view.newChats
    .filter((candidate) => candidate.status === 'available')
    .map((candidate) => ({ kind: 'new-chat' as const, candidate }));
  const selected = [...conversations, ...newChats].find((item) => selectableKey(item) === selectedKey) ?? null;
  const showPicker =
    canSelect &&
    (link === null || state === 'stale' || state === 'disconnected' || state === 'confirmation-required');

  const renderOption = (item: Selectable) => {
    const key = selectableKey(item);
    return (
      <label key={key} className="radio candidate">
        <input
          type="radio"
          name={`${id}-candidate`}
          value={key}
          checked={selectedKey === key}
          onChange={() => {
            setSelectedKey(key);
          }}
        />
        <span className="candidate-text">
          <span className="radio-label candidate-title">{item.candidate.title ?? 'Untitled tab'}</span>
          {item.kind === 'conversation' ? (
            <span className="radio-description">
              Saved conversation{' '}
              <code title={item.candidate.conversationId}>{shortConversationId(item.candidate.conversationId)}</code> ·
              Available
            </span>
          ) : (
            <span className="radio-description">
              <span className="badge new-chat-badge">New chat</span> No conversation address until the first message is
              sent
            </span>
          )}
        </span>
      </label>
    );
  };

  return (
    <div className="provider-connection" role="group" aria-labelledby={`${id}-name`}>
      <div className="provider-heading">
        <h3 id={`${id}-name`}>{label}</h3>
        <span className={`badge connection-badge connection-${state}`}>
          {link === null ? 'Not linked' : linkStatusLabel(link.status)}
        </span>
      </div>

      {link !== null && (
        <LinkedConversation
          view={view}
          link={link}
          label={label}
          canSelect={canSelect}
          pageCheck={pageCheck}
          onCommand={onCommand}
        />
      )}

      {showPicker && (
        <fieldset className="field candidates">
          <legend>
            {link === null
              ? `Select a ${label} conversation or new chat`
              : `Or link a different ${label} conversation or new chat`}
          </legend>
          {conversations.length === 0 && newChats.length === 0 ? (
            <p className="hint empty-state">{emptyMessage(label, link !== null, view.otherPageCount)}</p>
          ) : (
            <>
              {conversations.length > 0 && (
                <div className="candidate-group" role="group" aria-label={`Saved ${label} conversations`}>
                  <p className="candidate-group-title">Saved conversations</p>
                  {conversations.map(renderOption)}
                </div>
              )}
              {newChats.length > 0 && (
                <div className="candidate-group" role="group" aria-label={`New ${label} chats`}>
                  <p className="candidate-group-title">New chats</p>
                  {newChats.map(renderOption)}
                </div>
              )}
              {view.otherPageCount > 0 && <p className="hint">{otherPagesMessage(label, view.otherPageCount)}</p>}
              <div className="button-row">
                <button
                  type="button"
                  className="button button-primary"
                  disabled={selected === null}
                  onClick={() => {
                    if (selected === null) {
                      return;
                    }
                    setSelectedKey(null);
                    onCommand(
                      selected.kind === 'conversation'
                        ? {
                            type: 'link-conversation',
                            provider,
                            tabId: selected.candidate.tabId,
                            conversationId: selected.candidate.conversationId,
                            expectedRevision: revision,
                          }
                        : { type: 'link-new-chat', provider, tabId: selected.candidate.tabId, expectedRevision: revision },
                    );
                  }}
                >
                  {linkButtonLabel(selected?.kind ?? null, link !== null)}
                </button>
              </div>
            </>
          )}
        </fieldset>
      )}
    </div>
  );
}

interface LinkedConversationProps {
  readonly view: ProviderConnectionsView;
  readonly link: LinkedConversationView;
  readonly label: string;
  readonly canSelect: boolean;
  readonly pageCheck: PageCheckView | null;
  readonly onCommand: (message: ConnectionsCommand) => void;
}

function LinkedConversation({ view, link, label, canSelect, pageCheck, onCommand }: LinkedConversationProps) {
  const { provider, revision } = view;
  const { identity, status } = link;
  const reconnectable = view.candidates.filter((candidate) => candidate.status === 'reconnectable');
  const lost = status.kind === 'stale' || status.kind === 'disconnected';
  // The tab still shows what the link expects; the host rejects checks of any other link.
  const checkable = status.kind === 'linked' || status.kind === 'awaiting-identity' || status.kind === 'confirmation-required';
  // A check of a previously linked tab says nothing about the current one.
  const check = checkable && pageCheck?.tabId === link.tabId ? pageCheck : null;

  return (
    <div className="linked-conversation">
      <p className="conversation-title">{link.title ?? 'Title not available'}</p>
      <p className="conversation-ref">
        {identity.kind === 'pending' && 'New chat · no conversation address yet'}
        {identity.kind === 'saved' && (
          <>
            Conversation <code title={identity.conversationId}>{shortConversationId(identity.conversationId)}</code>
            {identity.source === 'new-chat' && ' · recorded from the linked new chat'}
            {identity.source === 'confirmed' && ' · confirmed by you'}
          </>
        )}
        {identity.kind === 'unconfirmed' && (
          <>
            Observed conversation{' '}
            <code title={identity.conversationId}>{shortConversationId(identity.conversationId)}</code> · not confirmed
          </>
        )}
      </p>
      <p className={`connection-detail connection-detail-${status.kind}`} role="status" aria-live="polite">
        {linkStatusDescription(status, identity)}
      </p>
      {check !== null && (
        <p
          className={`page-check page-check-${check.result.ok ? check.result.status.readiness : 'failed'}`}
          role="status"
          aria-live="polite"
        >
          {pageCheckDescription(check.result, label)}
        </p>
      )}

      {reconnectable.length > 0 && (
        <ul className="reconnect-list" aria-label={`Tabs showing the previously linked ${label} conversation`}>
          {reconnectable.map((candidate) => (
            <li key={`${candidate.tabId}:${candidate.conversationId}`}>
              <span className="candidate-title">{candidate.title ?? 'Untitled tab'}</span>
              <button
                type="button"
                className="button"
                onClick={() => {
                  onCommand({
                    type: 'reconnect-conversation',
                    provider,
                    tabId: candidate.tabId,
                    expectedRevision: revision,
                  });
                }}
              >
                Reconnect
              </button>
            </li>
          ))}
        </ul>
      )}
      {lost && reconnectable.length === 0 && canSelect && (
        <p className="hint">
          {identity.kind === 'saved'
            ? 'To reconnect, open this conversation in a tab and click Refresh.'
            : 'A new chat cannot be reconnected. Link a conversation or a new chat below.'}
        </p>
      )}

      <div className="button-row">
        {status.kind === 'confirmation-required' && identity.kind === 'unconfirmed' && (
          <button
            type="button"
            className="button button-primary"
            onClick={() => {
              onCommand({
                type: 'confirm-conversation-identity',
                provider,
                tabId: link.tabId,
                conversationId: identity.conversationId,
                expectedRevision: revision,
              });
            }}
          >
            Confirm this conversation
          </button>
        )}
        {checkable && (
          <button
            type="button"
            className="button"
            onClick={() => {
              onCommand({ type: 'check-provider-page', provider });
            }}
          >
            Check page connection
          </button>
        )}
        <button
          type="button"
          className="button"
          onClick={() => {
            onCommand({ type: 'disconnect-conversation', provider, expectedRevision: revision });
          }}
        >
          Disconnect
        </button>
      </div>
    </div>
  );
}

function linkButtonLabel(kind: Selectable['kind'] | null, hasLink: boolean): string {
  if (kind === 'new-chat') {
    return hasLink ? 'Replace with selected new chat' : 'Link selected new chat';
  }
  return hasLink ? 'Replace with selected conversation' : 'Link selected conversation';
}

function emptyMessage(label: string, hasLink: boolean, otherPageCount: number): string {
  const base = hasLink
    ? `No other ${label} conversations or new chats found. Open one in another tab and click Refresh.`
    : `No ${label} conversations or new chats found. Open a ${label} conversation or a new chat in another tab and click Refresh.`;
  return otherPageCount > 0 ? `${base} ${otherPagesMessage(label, otherPageCount)}` : base;
}

function otherPagesMessage(label: string, count: number): string {
  return count === 1
    ? `1 ${label} tab is open but shows neither a saved conversation nor a new chat (for example, settings or a project page).`
    : `${count} ${label} tabs are open but show neither a saved conversation nor a new chat (for example, settings or a project page).`;
}

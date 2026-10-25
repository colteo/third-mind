import { useId, useState } from 'react';
import type { ConnectionsView, ConversationCandidate, ProviderConnectionsView } from '../../application';
import type { ConnectionClientMessage } from '../../extension/protocol';
import { connectionStateDescription, connectionStateLabel, providerLabel, shortConversationId } from '../format';

interface ConversationConnectionsProps {
  /** `null` until the background service has sent the first view. */
  readonly view: ConnectionsView | null;
  readonly onCommand: (message: ConnectionClientMessage) => void;
}

/**
 * Linked conversations (Phase 2.1). Associates open ChatGPT and Claude tabs
 * with ThirdMind. Nothing here reads or sends messages, and the simulated
 * debate does not use these links.
 *
 * Tab titles are untrusted. They are only ever rendered as React text, never as HTML.
 */
export function ConversationConnections({ view, onCommand }: ConversationConnectionsProps) {
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
        Link an open ChatGPT or Claude conversation to ThirdMind. ThirdMind only records which tab shows which
        conversation. It does not read or send messages, and the simulated debate does not use linked conversations.
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
  readonly onCommand: (message: ConnectionClientMessage) => void;
}

function candidateKey(candidate: ConversationCandidate): string {
  return `${candidate.tabId}:${candidate.conversationId}`;
}

function ProviderConnection({ view, canSelect, onCommand }: ProviderConnectionProps) {
  const id = useId();
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const { provider, revision, link } = view;
  const label = providerLabel(provider);
  const state = link?.state.kind ?? 'none';
  // Selection is never automatic, not even with a single candidate.
  const selectable = view.candidates.filter((candidate) => candidate.status === 'available');
  const selected = selectable.find((candidate) => candidateKey(candidate) === selectedKey) ?? null;
  const reconnectable = view.candidates.filter((candidate) => candidate.status === 'reconnectable');
  const showPicker = canSelect && (link === null || state === 'stale' || state === 'disconnected');

  return (
    <div className="provider-connection" role="group" aria-labelledby={`${id}-name`}>
      <div className="provider-heading">
        <h3 id={`${id}-name`}>{label}</h3>
        <span className={`badge connection-badge connection-${state}`}>
          {link === null ? 'Not linked' : connectionStateLabel(link.state)}
        </span>
      </div>

      {link !== null && (
        <div className="linked-conversation">
          <p className="conversation-title">{link.title ?? 'Title not available'}</p>
          <p className="conversation-ref">
            Conversation <code title={link.conversationId}>{shortConversationId(link.conversationId)}</code>
          </p>
          <p className={`connection-detail connection-detail-${state}`} role="status" aria-live="polite">
            {connectionStateDescription(link.state)}
          </p>

          {reconnectable.length > 0 && (
            <ul className="reconnect-list" aria-label={`Tabs showing the previously linked ${label} conversation`}>
              {reconnectable.map((candidate) => (
                <li key={candidateKey(candidate)}>
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
          {(state === 'stale' || state === 'disconnected') && reconnectable.length === 0 && canSelect && (
            <p className="hint">To reconnect, open this conversation in a tab and click Refresh.</p>
          )}

          <div className="button-row">
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
      )}

      {showPicker && (
        <fieldset className="field candidates">
          <legend>{link === null ? `Select a ${label} conversation` : `Or link a different ${label} conversation`}</legend>
          {selectable.length === 0 ? (
            <p className="hint empty-state">{emptyMessage(label, link !== null, view.otherPageCount)}</p>
          ) : (
            <>
              {selectable.map((candidate) => {
                const key = candidateKey(candidate);
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
                      <span className="radio-label candidate-title">{candidate.title ?? 'Untitled tab'}</span>
                      <span className="radio-description">
                        Conversation <code title={candidate.conversationId}>{shortConversationId(candidate.conversationId)}</code>{' '}
                        · Available
                      </span>
                    </span>
                  </label>
                );
              })}
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
                    onCommand({
                      type: 'link-conversation',
                      provider,
                      tabId: selected.tabId,
                      conversationId: selected.conversationId,
                      expectedRevision: revision,
                    });
                  }}
                >
                  {link === null ? 'Link selected conversation' : 'Replace with selected conversation'}
                </button>
              </div>
            </>
          )}
        </fieldset>
      )}
    </div>
  );
}

function emptyMessage(label: string, hasLink: boolean, otherPageCount: number): string {
  const base = hasLink
    ? `No other ${label} conversations found. Open one in another tab and click Refresh.`
    : `No ${label} conversations found. Open a ${label} conversation in another tab and click Refresh.`;
  return otherPageCount > 0 ? `${base} ${otherPagesMessage(label, otherPageCount)}` : base;
}

function otherPagesMessage(label: string, count: number): string {
  return count === 1
    ? `1 ${label} tab is open but does not show a saved conversation (for example, a new chat).`
    : `${count} ${label} tabs are open but do not show a saved conversation (for example, a new chat).`;
}

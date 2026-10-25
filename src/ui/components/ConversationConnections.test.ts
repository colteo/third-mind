import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ConnectionsView, ProviderConnectionsView } from '../../application';
import { ConversationConnections } from './ConversationConnections';

/** Static render tests (no DOM), like Results.test.ts. */

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function provider(overrides: Partial<ProviderConnectionsView> & Pick<ProviderConnectionsView, 'provider'>): ProviderConnectionsView {
  return { revision: 0, link: null, candidates: [], otherPageCount: 0, ...overrides };
}

function render(view: ConnectionsView | null): string {
  return renderToStaticMarkup(createElement(ConversationConnections, { view, onCommand: () => undefined }));
}

function text(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
}

const ready = (providers: ProviderConnectionsView[]): ConnectionsView => ({
  discovery: 'ready',
  discoveryError: null,
  unavailableTabCount: 0,
  providers,
});

describe('conversation connections panel', () => {
  it('shows meaningful empty states', () => {
    const html = text(
      render(ready([provider({ provider: 'chatgpt', otherPageCount: 1 }), provider({ provider: 'claude' })])),
    );
    expect(html).toContain('No ChatGPT conversations found. Open a ChatGPT conversation in another tab and click Refresh.');
    expect(html).toContain('1 ChatGPT tab is open but does not show a saved conversation');
    expect(html).toContain('No Claude conversations found. Open a Claude conversation in another tab and click Refresh.');
  });

  it('never preselects a candidate, even when there is only one', () => {
    const html = render(
      ready([
        provider({
          provider: 'claude',
          candidates: [{ tabId: 3, conversationId: A, title: 'Only one', status: 'available' }],
        }),
      ]),
    );
    expect(html).not.toContain('checked');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Link selected conversation<\/button>/);
  });

  it('renders untrusted tab titles as text, never as HTML', () => {
    const title = '<img src=x onerror="alert(1)">';
    const html = render(
      ready([
        provider({
          provider: 'chatgpt',
          candidates: [{ tabId: 3, conversationId: A, title, status: 'available' }],
        }),
      ]),
    );
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
  });

  it('explains a closed tab and offers explicit reconnection only for the same conversation', () => {
    const html = text(
      render(
        ready([
          provider({
            provider: 'chatgpt',
            revision: 2,
            link: { tabId: 1, conversationId: A, title: null, state: { kind: 'disconnected', reason: 'tab-closed' } },
            candidates: [{ tabId: 9, conversationId: A, title: 'Reopened', status: 'reconnectable' }],
          }),
        ]),
      ),
    );
    expect(html).toContain('Disconnected');
    expect(html).toContain('The tab was closed.');
    expect(html).toContain('Reopened Reconnect');
    expect(html).toContain('Disconnect');
  });

  it('explains a tab that navigated to another conversation', () => {
    const html = text(
      render(
        ready([
          provider({
            provider: 'claude',
            revision: 2,
            link: {
              tabId: 1,
              conversationId: A,
              title: null,
              state: { kind: 'stale', reason: 'different-conversation' },
            },
          }),
        ]),
      ),
    );
    expect(html).toContain('Stale');
    expect(html).toContain('The tab now shows a different conversation. This link is no longer valid.');
    expect(html).toContain('To reconnect, open this conversation in a tab and click Refresh.');
  });

  it('shows a failed tab query without offering unverified candidates', () => {
    const html = text(
      render({
        discovery: 'failed',
        discoveryError: 'Tab access is not available.',
        unavailableTabCount: 0,
        providers: [provider({ provider: 'chatgpt' })],
      }),
    );
    expect(html).toContain('Tab access is not available.');
    expect(html).not.toContain('No ChatGPT conversations found');
  });

  it('states that links are not used by the simulated debate', () => {
    expect(text(render(null))).toContain('the simulated debate does not use linked conversations');
  });
});

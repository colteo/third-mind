import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ConnectionsView, LinkedConversationView, ProviderConnectionsView } from '../../application';
import type { PageCheckView } from '../../extension/protocol';
import { ConversationConnections } from './ConversationConnections';

/** Static render tests (no DOM), like Results.test.ts. */

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function provider(overrides: Partial<ProviderConnectionsView> & Pick<ProviderConnectionsView, 'provider'>): ProviderConnectionsView {
  return { revision: 0, link: null, candidates: [], newChats: [], otherPageCount: 0, ...overrides };
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
    expect(html).toContain(
      'No ChatGPT conversations or new chats found. Open a ChatGPT conversation or a new chat in another tab and click Refresh.',
    );
    expect(html).toContain('1 ChatGPT tab is open but shows neither a saved conversation nor a new chat');
    expect(html).toContain(
      'No Claude conversations or new chats found. Open a Claude conversation or a new chat in another tab and click Refresh.',
    );
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

  it('lists new chats next to saved conversations and distinguishes them clearly', () => {
    const html = render(
      ready([
        provider({
          provider: 'chatgpt',
          candidates: [{ tabId: 3, conversationId: A, title: 'Saved one', status: 'available' }],
          newChats: [{ tabId: 5, title: 'ChatGPT', status: 'available' }],
        }),
      ]),
    );
    const plain = text(html);
    expect(plain).toContain('Select a ChatGPT conversation or new chat');
    expect(plain).toContain('Saved conversations Saved one Saved conversation');
    expect(plain).toContain('New chats ChatGPT New chat No conversation address until the first message is sent');
    expect(html).toContain('value="new-chat:5"');
    expect(html).not.toContain('checked');
  });

  it('does not offer the linked new chat again', () => {
    const html = text(
      render(
        ready([
          provider({
            provider: 'chatgpt',
            revision: 1,
            link: { tabId: 5, identity: { kind: 'pending' }, status: { kind: 'awaiting-identity' }, title: 'ChatGPT' },
            newChats: [{ tabId: 5, title: 'ChatGPT', status: 'linked' }],
          }),
        ]),
      ),
    );
    expect(text(html)).not.toContain('Link selected');
  });

  it('shows a pending new chat without claiming that messages are automated', () => {
    const html = text(
      render(
        ready([
          provider({
            provider: 'chatgpt',
            revision: 1,
            link: { tabId: 5, identity: { kind: 'pending' }, status: { kind: 'awaiting-identity' }, title: 'ChatGPT' },
          }),
        ]),
      ),
    );
    expect(html).toContain('New chat — pending first message');
    expect(html).toContain('New chat · no conversation address yet');
    expect(html).toContain('Linking does not send any message.');
    expect(html).toContain('Disconnect');
    expect(html).not.toContain('Confirm this conversation');
  });

  it('shows the conversation once a new chat has been resolved', () => {
    const html = text(
      render(
        ready([
          provider({
            provider: 'claude',
            revision: 2,
            link: {
              tabId: 5,
              identity: { kind: 'saved', conversationId: A, source: 'new-chat' },
              status: { kind: 'linked' },
              title: 'Fresh chat',
            },
          }),
        ]),
      ),
    );
    expect(html).toContain('Linked');
    expect(html).toContain('Fresh chat');
    expect(html).toContain('Conversation aaaaaaaa… · recorded from the linked new chat');
  });

  it('explains when confirmation is required and offers an explicit confirmation', () => {
    const html = render(
      ready([
        provider({
          provider: 'chatgpt',
          revision: 2,
          link: {
            tabId: 5,
            identity: { kind: 'unconfirmed', conversationId: A, reason: 'observation-gap' },
            status: { kind: 'confirmation-required', reason: 'observation-gap' },
            title: 'Some chat',
          },
        }),
      ]),
    );
    const plain = text(html);
    expect(plain).toContain('Confirmation required');
    expect(plain).toContain('Observed conversation aaaaaaaa… · not confirmed');
    expect(plain).toContain('cannot tell whether this is the new chat you linked');
    expect(plain).toContain('Confirm only if you sent the first message of that new chat in this tab.');
    expect(html).toMatch(/<button[^>]*>Confirm this conversation<\/button>/);
    expect(plain).toContain('Disconnect');
  });

  it('explains a duplicate conversation as a reason for confirmation', () => {
    const html = text(
      render(
        ready([
          provider({
            provider: 'chatgpt',
            revision: 2,
            link: {
              tabId: 5,
              identity: { kind: 'unconfirmed', conversationId: A, reason: 'open-in-another-tab' },
              status: { kind: 'confirmation-required', reason: 'open-in-another-tab' },
              title: null,
            },
          }),
        ]),
      ),
    );
    expect(html).toContain('also open in another tab');
  });

  it('explains a new chat that left before it was saved, and how to continue', () => {
    const html = text(
      render(
        ready([
          provider({
            provider: 'claude',
            revision: 2,
            link: {
              tabId: 5,
              identity: { kind: 'pending' },
              status: { kind: 'stale', reason: 'left-conversation' },
              title: null,
            },
          }),
        ]),
      ),
    );
    expect(html).toContain('Stale');
    expect(html).toContain('The tab left the new chat before a conversation was saved.');
    expect(html).toContain('A new chat cannot be reconnected. Link a conversation or a new chat below.');
    expect(html).toContain('Or link a different Claude conversation or new chat');
  });

  it('renders untrusted tab titles as text, never as HTML', () => {
    const title = '<img src=x onerror="alert(1)">';
    const html = render(
      ready([
        provider({
          provider: 'chatgpt',
          candidates: [{ tabId: 3, conversationId: A, title, status: 'available' }],
          newChats: [{ tabId: 4, title, status: 'available' }],
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
            link: {
              tabId: 1,
              identity: { kind: 'saved', conversationId: A, source: 'selected' },
              title: null,
              status: { kind: 'disconnected', reason: 'tab-closed' },
            },
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
              identity: { kind: 'saved', conversationId: A, source: 'selected' },
              title: null,
              status: { kind: 'stale', reason: 'different-conversation' },
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
        providers: [provider({ provider: 'chatgpt', newChats: [{ tabId: 5, title: 'ChatGPT', status: 'available' }] })],
      }),
    );
    expect(html).toContain('Tab access is not available.');
    expect(html).not.toContain('No ChatGPT conversations');
    expect(html).not.toContain('New chats');
  });

  it('states that links are not used by the simulated debate', () => {
    expect(text(render(null))).toContain('the simulated debate does not use linked conversations');
  });
});

describe('page connection checks', () => {
  const linked = (tabId: number, status: LinkedConversationView['status']) =>
    ready([
      provider({
        provider: 'chatgpt',
        revision: 1,
        link: { tabId, identity: { kind: 'saved', conversationId: A, source: 'selected' }, status, title: 'Chat' },
      }),
    ]);

  function renderWithCheck(view: ConnectionsView, check: PageCheckView | null): string {
    return text(
      renderToStaticMarkup(
        createElement(ConversationConnections, {
          view,
          pageChecks: check === null ? {} : { chatgpt: check },
          onCommand: () => undefined,
        }),
      ),
    );
  }

  const readyCheck: PageCheckView = {
    provider: 'chatgpt',
    tabId: 5,
    linkRevision: 1,
    checkedAt: '2026-10-25T12:00:00Z',
    result: {
      ok: true,
      status: {
        provider: 'chatgpt',
        tabId: 5,
        pageInstanceId: 'p',
        page: { kind: 'conversation', conversationId: A },
        documentState: 'complete',
        visibility: 'visible',
        composer: 'present',
        readiness: 'ready',
      },
    },
  };

  it('offers a check only while the tab shows what the link expects', () => {
    expect(renderWithCheck(linked(5, { kind: 'linked' }), null)).toContain('Check page connection');
    expect(renderWithCheck(linked(5, { kind: 'stale', reason: 'different-conversation' }), null)).not.toContain(
      'Check page connection',
    );
    expect(renderWithCheck(linked(5, { kind: 'disconnected', reason: 'tab-closed' }), null)).not.toContain(
      'Check page connection',
    );
  });

  it('shows the readiness of the linked tab', () => {
    expect(renderWithCheck(linked(5, { kind: 'linked' }), readyCheck)).toContain(
      'Page connection active. The ChatGPT page shows a saved conversation, is visible, and its message box was found.',
    );
  });

  it('ignores a check of a previously linked tab', () => {
    expect(renderWithCheck(linked(6, { kind: 'linked' }), readyCheck)).not.toContain('Page connection active');
  });

  it('discards diagnostics from another link revision', () => {
    expect(renderWithCheck(linked(5, { kind: 'linked' }), { ...readyCheck, linkRevision: 0 })).not.toContain('Page connection active');
  });

  it('hides diagnostics in production', () => {
    vi.stubEnv('DEV', false);
    try {
      const html = renderWithCheck(linked(5, { kind: 'linked' }), readyCheck);
      expect(html).not.toContain('Check page connection');
      expect(html).not.toContain('Page connection active');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('shows identity evidence and unavailable exchange capabilities', () => {
    const html = renderWithCheck(linked(5, { kind: 'linked' }), readyCheck);
    expect(html).toContain('Exact origin verified: https://chatgpt.com');
    expect(html).toContain('Background messaging: confirmed');
    expect(html).toContain('Document instance: p');
    expect(html).toContain('Automated submission and reply acquisition are unavailable');
  });

  it('never presents a timeout as a failure on the page', () => {
    const html = renderWithCheck(linked(5, { kind: 'linked' }), {
      provider: 'chatgpt',
      tabId: 5,
      linkRevision: 1,
      checkedAt: '2026-10-25T12:00:00Z',
      result: { ok: false, failure: { kind: 'timeout', outcome: 'unknown' } },
    });
    expect(html).toContain('The page did not answer in time. This does not mean that anything failed on the page.');
  });

  it('asks for a reload when the content script is not active', () => {
    const html = renderWithCheck(linked(5, { kind: 'linked' }), {
      provider: 'chatgpt',
      tabId: 5,
      linkRevision: 1,
      checkedAt: '2026-10-25T12:00:00Z',
      result: { ok: false, failure: { kind: 'content-script-unavailable', outcome: 'not-performed' } },
    });
    expect(html).toContain('page connection is not active in this tab. Reload the ChatGPT tab');
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConversationProviderId } from '../domain';
import { createConversationRecognizer } from '../infrastructure/conversation-urls';
import type { PageEnvironment } from '../infrastructure/provider-pages';
import type { IdGenerator } from '../ports';
import { handleTransportRequest } from './provider-content-script';
import {
  DEFAULT_TRANSPORT_TIMEOUT_MS,
  createProviderTransport,
  type ProviderTransport,
  type TransportTabsApi,
} from './provider-transport';
import { pageHello, pageReport, parseInspectPageRequest, type MessageSenderLike } from './provider-transport-protocol';

// The content script module imports `wxt/browser` for its live entry point, which these tests do not use.
vi.mock('wxt/browser', () => ({ browser: {} }));

const EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CHATGPT_A = `https://chatgpt.com/c/${A}`;
const CHATGPT_B = `https://chatgpt.com/c/${B}`;
const CLAUDE_NEW = 'https://claude.ai/new';
const CHATGPT_COMPOSER = '#prompt-textarea';
const CLAUDE_COMPOSER = 'div.ProseMirror[contenteditable="true"]';

const NO_RECEIVER = 'Could not establish connection. Receiving end does not exist.';
const BACKGROUND_SENDER = { id: EXTENSION_ID, url: `chrome-extension://${EXTENSION_ID}/background.js` };

type PageHandler = (message: unknown, tabId: number) => unknown;

/**
 * Fake `chrome.tabs`: `urls` is what each open tab shows, and `pages` is the
 * content script answering in each tab. A tab without a page has no content script.
 */
function fakeBrowser(initial: Record<number, string>) {
  const urls = new Map<number, string>(Object.entries(initial).map(([tabId, url]) => [Number(tabId), url]));
  const pages = new Map<number, PageHandler>();
  const sent: { tabId: number; message: unknown; options: { frameId: number } }[] = [];
  const tabs: TransportTabsApi = {
    get: (tabId) => {
      const url = urls.get(tabId);
      return url === undefined
        ? Promise.reject(new Error(`No tab with id: ${tabId}.`))
        : Promise.resolve({ id: tabId, url });
    },
    sendMessage: async (tabId, message, options) => {
      sent.push({ tabId, message, options });
      if (!urls.has(tabId)) {
        throw new Error(`No tab with id: ${tabId}.`);
      }
      const page = pages.get(tabId);
      if (page === undefined) {
        throw new Error(NO_RECEIVER);
      }
      return page(message, tabId);
    },
  };
  return { tabs, urls, pages, sent };
}

/** A real content script handler for `provider`, on a fake page. */
function contentScript(
  provider: ConversationProviderId,
  pageInstanceId: string,
  page: () => Partial<PageEnvironment> & { href: string },
  elements: readonly string[] = [],
): PageHandler {
  return (message) => {
    const current = page();
    return handleTransportRequest(message, BACKGROUND_SENDER, {
      provider,
      extensionId: EXTENSION_ID,
      pageInstanceId,
      page: {
        readyState: 'complete',
        visibilityState: 'visible',
        hasElement: (selector) => elements.includes(selector),
        ...current,
      },
    });
  };
}

/** Unique across transport instances, like the random ids of real (restarted) workers. */
let nextId = 0;
const sequentialIds: IdGenerator = {
  newId: (prefix) => {
    nextId += 1;
    return `${prefix}-${nextId}`;
  },
};

function transportFor(tabs: TransportTabsApi | undefined, timeoutMs?: number): ProviderTransport {
  return createProviderTransport({
    tabs,
    extensionId: EXTENSION_ID,
    recognizer: createConversationRecognizer(),
    ids: sequentialIds,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

/** A ChatGPT tab 1 showing conversation A, with a ready content script. */
function chatgptTab() {
  const browser = fakeBrowser({ 1: CHATGPT_A });
  browser.pages.set(1, contentScript('chatgpt', 'page-1', () => ({ href: browser.urls.get(1) ?? '' }), [CHATGPT_COMPOSER]));
  return browser;
}

function senderFor(url: string, tabId = 1) {
  return { id: EXTENSION_ID, url, origin: new URL(url).origin, frameId: 0, tab: { id: tabId } };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('valid provider origin', () => {
  it('reports readiness of a ChatGPT conversation through the top frame only', async () => {
    const browser = chatgptTab();
    const result = await transportFor(browser.tabs).probe(1, 'chatgpt');
    expect(result).toEqual({
      ok: true,
      status: {
        provider: 'chatgpt',
        tabId: 1,
        pageInstanceId: 'page-1',
        page: { kind: 'conversation', conversationId: A },
        documentState: 'complete',
        visibility: 'visible',
        composer: 'present',
        readiness: 'ready',
      },
    });
    expect(browser.sent).toHaveLength(1);
    expect(browser.sent[0]?.options).toEqual({ frameId: 0 });
    expect(parseInspectPageRequest(browser.sent[0]?.message)).toMatchObject({ provider: 'chatgpt' });
  });

  it('validates the tab before every operation', async () => {
    const browser = chatgptTab();
    const transport = transportFor(browser.tabs);
    expect((await transport.probe(1, 'chatgpt')).ok).toBe(true);
    browser.urls.set(1, 'https://example.com/');
    expect(await transport.probe(1, 'chatgpt')).toEqual({
      ok: false,
      failure: { kind: 'unsupported-page', outcome: 'not-performed' },
    });
    expect(browser.sent).toHaveLength(1);
  });
});

describe('invalid provider origin', () => {
  it.each([
    ['a lookalike host', `https://chatgpt.com.example.net/c/${A}`],
    ['a provider URL in the query of another site', `https://example.com/?u=${CHATGPT_A}`],
    ['plain http', `http://chatgpt.com/c/${A}`],
    ['another port', `https://chatgpt.com:8443/c/${A}`],
  ])('never messages %s', async (_name, url) => {
    const browser = fakeBrowser({ 1: url });
    browser.pages.set(1, () => {
      throw new Error('must not be called');
    });
    expect(await transportFor(browser.tabs).probe(1, 'chatgpt')).toEqual({
      ok: false,
      failure: { kind: 'unsupported-page', outcome: 'not-performed' },
    });
    expect(browser.sent).toEqual([]);
  });

  it('never messages a tab of the other provider', async () => {
    const browser = fakeBrowser({ 1: CLAUDE_NEW });
    expect(await transportFor(browser.tabs).probe(1, 'chatgpt')).toEqual({
      ok: false,
      failure: { kind: 'wrong-provider', outcome: 'not-performed' },
    });
    expect(browser.sent).toEqual([]);
  });

  it('accepts the content script refusing a request for the other provider', async () => {
    // The tab URL looks like ChatGPT, but the script that answers belongs to Claude.
    const browser = fakeBrowser({ 1: CHATGPT_A });
    browser.pages.set(1, contentScript('claude', 'page-1', () => ({ href: CLAUDE_NEW })));
    expect(await transportFor(browser.tabs).probe(1, 'chatgpt')).toEqual({
      ok: false,
      failure: { kind: 'wrong-provider', outcome: 'not-performed' },
    });
  });
});

describe('missing content script', () => {
  it('reports that nothing answers, and that nothing was performed', async () => {
    const browser = fakeBrowser({ 1: CHATGPT_A });
    expect(await transportFor(browser.tabs).probe(1, 'chatgpt')).toEqual({
      ok: false,
      failure: { kind: 'content-script-unavailable', outcome: 'not-performed' },
    });
  });

  it('reports a missing Tabs API', async () => {
    expect(await transportFor(undefined).probe(1, 'chatgpt')).toEqual({
      ok: false,
      failure: { kind: 'transport-unavailable', outcome: 'not-performed' },
    });
  });
});

describe('closed tab', () => {
  it('does not message a tab that does not exist', async () => {
    const browser = fakeBrowser({});
    expect(await transportFor(browser.tabs).probe(9, 'claude')).toEqual({
      ok: false,
      failure: { kind: 'tab-closed', outcome: 'not-performed' },
    });
    expect(browser.sent).toEqual([]);
  });

  it('treats a tab closed during the request as an unknown outcome', async () => {
    const browser = chatgptTab();
    const transport = transportFor(browser.tabs);
    const answer = browser.pages.get(1);
    browser.pages.set(1, (message, tabId) => {
      const response = answer?.(message, tabId);
      browser.urls.delete(1);
      transport.tabRemoved(1);
      return response;
    });
    expect(await transport.probe(1, 'chatgpt')).toEqual({ ok: false, failure: { kind: 'tab-closed', outcome: 'unknown' } });
  });

  it('treats a tab closed during the request without an event as an unknown outcome', async () => {
    const browser = chatgptTab();
    const answer = browser.pages.get(1);
    browser.pages.set(1, (message, tabId) => {
      browser.urls.delete(1);
      return answer?.(message, tabId);
    });
    expect(await transportFor(browser.tabs).probe(1, 'chatgpt')).toEqual({
      ok: false,
      failure: { kind: 'tab-closed', outcome: 'unknown' },
    });
  });

  it('reports a tab whose URL cannot be read', async () => {
    const browser = fakeBrowser({ 1: '' });
    expect(await transportFor(browser.tabs).probe(1, 'chatgpt')).toEqual({
      ok: false,
      failure: { kind: 'tab-unreadable', outcome: 'not-performed' },
    });
  });
});

describe('navigation during a request', () => {
  it('discards the answer when a tab event reports a new URL', async () => {
    const browser = chatgptTab();
    const transport = transportFor(browser.tabs);
    const answer = browser.pages.get(1);
    browser.pages.set(1, (message, tabId) => {
      const response = answer?.(message, tabId);
      browser.urls.set(1, CHATGPT_B);
      transport.tabChanged(1, CHATGPT_B);
      return response;
    });
    expect(await transport.probe(1, 'chatgpt')).toEqual({ ok: false, failure: { kind: 'navigated', outcome: 'unknown' } });
  });

  it('discards the answer when the URL changed without an event (missed while suspended)', async () => {
    const browser = chatgptTab();
    const answer = browser.pages.get(1);
    browser.pages.set(1, (message, tabId) => {
      const response = answer?.(message, tabId);
      browser.urls.set(1, CHATGPT_B);
      return response;
    });
    expect(await transportFor(browser.tabs).probe(1, 'chatgpt')).toEqual({
      ok: false,
      failure: { kind: 'navigated', outcome: 'unknown' },
    });
  });

  it('discards the answer when a new document announces itself (reload keeps the URL)', async () => {
    const browser = chatgptTab();
    const transport = transportFor(browser.tabs);
    const answer = browser.pages.get(1);
    browser.pages.set(1, (message, tabId) => {
      const response = answer?.(message, tabId);
      expect(transport.receivePageMessage(pageHello('chatgpt', 'page-2'), senderFor(CHATGPT_A))).toEqual({
        accepted: true,
        tabId: 1,
      });
      return response;
    });
    expect(await transport.probe(1, 'chatgpt')).toEqual({ ok: false, failure: { kind: 'navigated', outcome: 'unknown' } });
  });

  it('discards an answer from a document that shows something other than the tab URL', async () => {
    const browser = fakeBrowser({ 1: CHATGPT_A });
    browser.pages.set(1, contentScript('chatgpt', 'page-1', () => ({ href: CHATGPT_B }), [CHATGPT_COMPOSER]));
    expect(await transportFor(browser.tabs).probe(1, 'chatgpt')).toEqual({
      ok: false,
      failure: { kind: 'navigated', outcome: 'unknown' },
    });
  });

  it('discards an answer from a previous document of the same tab', async () => {
    const browser = chatgptTab();
    const transport = transportFor(browser.tabs);
    // The current document announced itself as page-2, but the old page-1 script answers.
    transport.receivePageMessage(pageHello('chatgpt', 'page-2'), senderFor(CHATGPT_A));
    expect(await transport.probe(1, 'chatgpt')).toEqual({ ok: false, failure: { kind: 'navigated', outcome: 'unknown' } });
  });

  it('discards an answer that belongs to another request', async () => {
    const browser = chatgptTab();
    browser.pages.set(1, () =>
      pageReport('page-request-0', 'page-1', {
        provider: 'chatgpt',
        page: { kind: 'conversation', conversationId: A },
        documentState: 'complete',
        visibility: 'visible',
        composer: 'present',
      }),
    );
    expect(await transportFor(browser.tabs).probe(1, 'chatgpt')).toEqual({
      ok: false,
      failure: { kind: 'invalid-response', outcome: 'unknown' },
    });
  });

  it('reports a document that went away after delivery as navigated with an unknown outcome', async () => {
    const browser = chatgptTab();
    browser.pages.set(1, () => {
      throw new Error('The page keeping the extension port is moved into back/forward cache, so the message channel is closed.');
    });
    expect(await transportFor(browser.tabs).probe(1, 'chatgpt')).toEqual({
      ok: false,
      failure: { kind: 'navigated', outcome: 'unknown' },
    });
  });

  it('works again on the next request after a navigation', async () => {
    const browser = chatgptTab();
    const transport = transportFor(browser.tabs);
    browser.urls.set(1, CHATGPT_B);
    transport.tabChanged(1, CHATGPT_B);
    expect(await transport.probe(1, 'chatgpt')).toMatchObject({
      ok: true,
      status: { page: { kind: 'conversation', conversationId: B } },
    });
  });

  it('ignores tab events that do not change the URL (for example, title updates)', async () => {
    const browser = chatgptTab();
    const transport = transportFor(browser.tabs);
    const answer = browser.pages.get(1);
    browser.pages.set(1, (message, tabId) => {
      transport.tabChanged(1, CHATGPT_A);
      transport.tabChanged(2, CLAUDE_NEW);
      return answer?.(message, tabId);
    });
    expect((await transport.probe(1, 'chatgpt')).ok).toBe(true);
  });
});

describe('worker restart', () => {
  it('works without any state from the previous worker, and rejects answers to its requests', async () => {
    const browser = chatgptTab();
    const before = transportFor(browser.tabs);
    expect((await before.probe(1, 'chatgpt')).ok).toBe(true);

    // The worker stops: its traces are gone. The content script keeps running and has no worker state.
    const restarted = transportFor(browser.tabs);
    expect(await restarted.probe(1, 'chatgpt')).toMatchObject({ ok: true, status: { pageInstanceId: 'page-1' } });

    // An answer to the old worker's request is never accepted by the new one.
    const answer = browser.pages.get(1);
    const oldRequest = browser.sent[0]?.message;
    browser.pages.set(1, (_message, tabId) => answer?.(oldRequest, tabId));
    const third = transportFor(browser.tabs);
    third.receivePageMessage(pageHello('chatgpt', 'page-1'), senderFor(CHATGPT_A));
    expect(await third.probe(1, 'chatgpt')).toEqual({ ok: false, failure: { kind: 'invalid-response', outcome: 'unknown' } });
  });

  it('accepts a page announcement that arrives after the restart', async () => {
    const browser = chatgptTab();
    const restarted = transportFor(browser.tabs);
    expect(restarted.receivePageMessage(pageHello('chatgpt', 'page-1'), senderFor(CHATGPT_A))).toEqual({
      accepted: true,
      tabId: 1,
    });
    expect((await restarted.probe(1, 'chatgpt')).ok).toBe(true);
  });
});

describe('incorrect message sender', () => {
  const hello = pageHello('chatgpt', 'page-9');

  it.each<[string, MessageSenderLike, string]>([
    ['another extension', { ...senderFor(CHATGPT_A), id: 'other-extension' }, 'foreign-extension'],
    ['an extension page (no tab)', { id: EXTENSION_ID, url: `chrome-extension://${EXTENSION_ID}/sidepanel.html` }, 'not-a-tab'],
    ['a subframe', { ...senderFor(CHATGPT_A), frameId: 2 }, 'subframe'],
    ['a page of the other provider', senderFor(CLAUDE_NEW), 'wrong-origin'],
    ['a lookalike origin', senderFor('https://chatgpt.com.example.net/'), 'wrong-origin'],
  ])('rejects a hello from %s', (_name, sender, reason) => {
    const transport = transportFor(chatgptTab().tabs);
    expect(transport.receivePageMessage(hello, sender)).toEqual({ accepted: false, reason });
  });

  it('ignores messages that are not transport messages', () => {
    const transport = transportFor(chatgptTab().tabs);
    expect(transport.receivePageMessage({ type: 'start' }, senderFor(CHATGPT_A))).toEqual({
      accepted: false,
      reason: 'not-a-transport-message',
    });
  });

  it('a rejected hello does not disturb a request in flight', async () => {
    const browser = chatgptTab();
    const transport = transportFor(browser.tabs);
    const answer = browser.pages.get(1);
    browser.pages.set(1, (message, tabId) => {
      // A provider page frame (for example, an embedded iframe) tries to announce a new document for tab 1.
      transport.receivePageMessage(hello, { ...senderFor(CHATGPT_A), frameId: 5 });
      return answer?.(message, tabId);
    });
    expect((await transport.probe(1, 'chatgpt')).ok).toBe(true);
  });

  it('content scripts stay silent for requests that do not come from this extension', () => {
    const page: PageEnvironment = {
      href: CHATGPT_A,
      readyState: 'complete',
      visibilityState: 'visible',
      hasElement: () => true,
    };
    const context = { provider: 'chatgpt' as const, extensionId: EXTENSION_ID, pageInstanceId: 'p', page };
    const request = { channel: 'thirdmind/provider-transport', version: 1, type: 'inspect-page', requestId: 'r', provider: 'chatgpt' };
    expect(handleTransportRequest(request, { id: 'other-extension' }, context)).toBeNull();
    expect(handleTransportRequest(request, { id: EXTENSION_ID, tab: { id: 3 } }, context)).toBeNull();
    expect(handleTransportRequest({ ...request, type: 'eval', code: '1' }, BACKGROUND_SENDER, context)).toBeNull();
    expect(handleTransportRequest(request, BACKGROUND_SENDER, context)).toMatchObject({ type: 'page-report' });
  });
});

describe('unsupported page', () => {
  it('does not message tabs outside the provider sites', async () => {
    const browser = fakeBrowser({ 1: 'chrome://newtab/' });
    expect(await transportFor(browser.tabs).probe(1, 'claude')).toEqual({
      ok: false,
      failure: { kind: 'unsupported-page', outcome: 'not-performed' },
    });
  });

  it('reports other provider pages as not a chat page', async () => {
    const browser = fakeBrowser({ 1: 'https://claude.ai/settings' });
    browser.pages.set(1, contentScript('claude', 'page-1', () => ({ href: 'https://claude.ai/settings' }), [CLAUDE_COMPOSER]));
    expect(await transportFor(browser.tabs).probe(1, 'claude')).toMatchObject({
      ok: true,
      status: { page: { kind: 'provider-page' }, readiness: 'not-a-chat-page' },
    });
  });
});

describe('transport timeout', () => {
  it('reports a timeout as an unknown outcome, never as a failure of the page operation', async () => {
    vi.useFakeTimers();
    const browser = chatgptTab();
    const late: { answer?: (value: unknown) => void } = {};
    browser.pages.set(
      1,
      () =>
        new Promise((resolve) => {
          late.answer = resolve;
        }),
    );
    const probe = transportFor(browser.tabs).probe(1, 'chatgpt');
    await vi.advanceTimersByTimeAsync(DEFAULT_TRANSPORT_TIMEOUT_MS - 1);
    const progress = { settled: false };
    void probe.then(() => {
      progress.settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(progress.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await probe).toEqual({ ok: false, failure: { kind: 'timeout', outcome: 'unknown' } });
    // A late answer changes nothing.
    late.answer?.(undefined);
    expect(await probe).toEqual({ ok: false, failure: { kind: 'timeout', outcome: 'unknown' } });
  });

  it('honours a configured timeout', async () => {
    vi.useFakeTimers();
    const browser = chatgptTab();
    browser.pages.set(1, () => new Promise(() => undefined));
    const probe = transportFor(browser.tabs, 50).probe(1, 'chatgpt');
    await vi.advanceTimersByTimeAsync(50);
    expect(await probe).toEqual({ ok: false, failure: { kind: 'timeout', outcome: 'unknown' } });
  });

  it('reports malformed answers and unknown errors as unknown outcomes', async () => {
    const browser = chatgptTab();
    const transport = transportFor(browser.tabs);
    browser.pages.set(1, () => undefined);
    expect(await transport.probe(1, 'chatgpt')).toEqual({ ok: false, failure: { kind: 'invalid-response', outcome: 'unknown' } });
    browser.pages.set(1, () => {
      throw new Error('Something unexpected');
    });
    expect(await transport.probe(1, 'chatgpt')).toEqual({ ok: false, failure: { kind: 'transport-error', outcome: 'unknown' } });
  });

  it('handles a sendMessage that throws synchronously', async () => {
    const browser = chatgptTab();
    const tabs: TransportTabsApi = {
      get: browser.tabs.get,
      sendMessage: () => {
        throw new Error(NO_RECEIVER);
      },
    };
    expect(await transportFor(tabs).probe(1, 'chatgpt')).toEqual({
      ok: false,
      failure: { kind: 'content-script-unavailable', outcome: 'not-performed' },
    });
  });
});

describe('provider-specific readiness detection', () => {
  it('reports a Claude new chat with its message box as ready', async () => {
    const browser = fakeBrowser({ 2: CLAUDE_NEW });
    browser.pages.set(2, contentScript('claude', 'page-c', () => ({ href: CLAUDE_NEW }), [CLAUDE_COMPOSER]));
    expect(await transportFor(browser.tabs).probe(2, 'claude')).toMatchObject({
      ok: true,
      status: { provider: 'claude', tabId: 2, page: { kind: 'new-chat' }, composer: 'present', readiness: 'ready' },
    });
  });

  it("reports composer-missing when only the other provider's message box exists", async () => {
    const browser = fakeBrowser({ 2: CLAUDE_NEW });
    browser.pages.set(2, contentScript('claude', 'page-c', () => ({ href: CLAUDE_NEW }), [CHATGPT_COMPOSER]));
    expect(await transportFor(browser.tabs).probe(2, 'claude')).toMatchObject({
      ok: true,
      status: { composer: 'absent', readiness: 'composer-missing' },
    });
  });

  it('reports a loading, hidden ChatGPT page', async () => {
    const browser = fakeBrowser({ 1: CHATGPT_A });
    browser.pages.set(
      1,
      contentScript('chatgpt', 'page-1', () => ({ href: CHATGPT_A, readyState: 'loading', visibilityState: 'hidden' })),
    );
    expect(await transportFor(browser.tabs).probe(1, 'chatgpt')).toMatchObject({
      ok: true,
      status: { documentState: 'loading', visibility: 'hidden', readiness: 'loading' },
    });
  });
});

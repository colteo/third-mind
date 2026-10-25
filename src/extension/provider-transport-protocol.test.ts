import { describe, expect, it } from 'vitest';
import { createConversationRecognizer } from '../infrastructure/conversation-urls';
import {
  PROVIDER_TRANSPORT_CHANNEL,
  PROVIDER_TRANSPORT_VERSION,
  checkPageSender,
  inspectPageRequest,
  isExtensionSender,
  pageHello,
  pageRefused,
  pageReport,
  parseInspectPageRequest,
  parsePageHello,
  parsePageResponse,
} from './provider-transport-protocol';

const EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';
const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const recognizer = createConversationRecognizer();
const envelope = { channel: PROVIDER_TRANSPORT_CHANNEL, version: PROVIDER_TRANSPORT_VERSION };
const report = {
  provider: 'chatgpt',
  page: { kind: 'conversation', conversationId: ID },
  documentState: 'complete',
  visibility: 'visible',
  composer: 'present',
} as const;

describe('provider transport message parsing', () => {
  it('round-trips every message type', () => {
    const request = inspectPageRequest('r-1', 'claude');
    expect(parseInspectPageRequest(request)).toEqual(request);
    const hello = pageHello('chatgpt', 'p-1');
    expect(parsePageHello(hello)).toEqual(hello);
    expect(parsePageResponse(pageReport('r-1', 'p-1', report))).toEqual(pageReport('r-1', 'p-1', report));
    expect(parsePageResponse(pageRefused('r-1', 'p-1', 'wrong-provider'))).toEqual(
      pageRefused('r-1', 'p-1', 'wrong-provider'),
    );
  });

  it.each<[unknown]>([
    [null],
    ['inspect-page'],
    [{ type: 'inspect-page', requestId: 'r', provider: 'claude' }],
    [{ ...envelope, version: 2, type: 'inspect-page', requestId: 'r', provider: 'claude' }],
    [{ ...envelope, type: 'inspect-page', requestId: '', provider: 'claude' }],
    [{ ...envelope, type: 'inspect-page', requestId: 'x'.repeat(129), provider: 'claude' }],
    [{ ...envelope, type: 'inspect-page', requestId: 'r', provider: 'gemini' }],
    // There is no operation that carries code, selectors or text.
    [{ ...envelope, type: 'run-script', requestId: 'r', provider: 'claude', code: 'alert(1)' }],
  ])('rejects the malformed request %o', (value) => {
    expect(parseInspectPageRequest(value)).toBeNull();
  });

  it('drops unexpected fields from requests and responses', () => {
    expect(
      parseInspectPageRequest({ ...envelope, type: 'inspect-page', requestId: 'r', provider: 'claude', selector: '*' }),
    ).toEqual(inspectPageRequest('r', 'claude'));
    expect(
      parsePageResponse({
        ...pageReport('r', 'p', report),
        transcript: 'secret',
        report: { ...report, title: 'Private title' },
      }),
    ).toEqual(pageReport('r', 'p', report));
  });

  it.each<[unknown]>([
    [{ ...pageReport('r', 'p', report), requestId: 7 }],
    [{ ...pageReport('r', 'p', report), pageInstanceId: '' }],
    [{ ...pageReport('r', 'p', report), report: { ...report, provider: 'gemini' } }],
    [{ ...pageReport('r', 'p', report), report: { ...report, documentState: 'done' } }],
    [{ ...pageReport('r', 'p', report), report: { ...report, visibility: 'prerender' } }],
    [{ ...pageReport('r', 'p', report), report: { ...report, composer: 'maybe' } }],
    [{ ...pageReport('r', 'p', report), report: { ...report, page: { kind: 'conversation' } } }],
    [{ ...pageReport('r', 'p', report), report: { ...report, page: { kind: 'settings' } } }],
    [{ ...pageRefused('r', 'p', 'wrong-provider'), reason: 'busy' }],
    [{ ...envelope, type: 'page-hello', provider: 'claude', pageInstanceId: 'p' }],
  ])('rejects the malformed response %o', (value) => {
    expect(parsePageResponse(value)).toBeNull();
  });
});

describe('message senders', () => {
  const contentScript = (url: string, overrides: object = {}) => ({
    id: EXTENSION_ID,
    url,
    origin: new URL(url).origin,
    frameId: 0,
    tab: { id: 4 },
    ...overrides,
  });

  it('content scripts accept only this extension’s own pages and service worker', () => {
    expect(isExtensionSender({ id: EXTENSION_ID }, EXTENSION_ID)).toBe(true);
    expect(
      isExtensionSender(
        {
          id: EXTENSION_ID,
          url: `chrome-extension://${EXTENSION_ID}/background.js`,
          origin: `chrome-extension://${EXTENSION_ID}`,
        },
        EXTENSION_ID,
      ),
    ).toBe(true);
    // Another extension.
    expect(isExtensionSender({ id: 'other' }, EXTENSION_ID)).toBe(false);
    // A content script of this extension (it has a tab).
    expect(isExtensionSender({ id: EXTENSION_ID, tab: { id: 1 } }, EXTENSION_ID)).toBe(false);
    // A web page origin.
    expect(isExtensionSender({ id: EXTENSION_ID, origin: 'https://chatgpt.com' }, EXTENSION_ID)).toBe(false);
    expect(isExtensionSender({ id: EXTENSION_ID, url: 'https://chatgpt.com/' }, EXTENSION_ID)).toBe(false);
  });

  it('the worker accepts a top-frame content script on the exact provider origin', () => {
    expect(checkPageSender(contentScript(`https://chatgpt.com/c/${ID}`), EXTENSION_ID, 'chatgpt', recognizer)).toEqual(
      { ok: true, tabId: 4 },
    );
    expect(checkPageSender(contentScript('https://claude.ai/settings'), EXTENSION_ID, 'claude', recognizer)).toEqual({
      ok: true,
      tabId: 4,
    });
  });

  it.each<[string, object, 'chatgpt' | 'claude', string]>([
    ['another extension', { id: 'other' }, 'chatgpt', 'foreign-extension'],
    ['no tab', { tab: undefined }, 'chatgpt', 'not-a-tab'],
    ['an invalid tab id', { tab: { id: -1 } }, 'chatgpt', 'not-a-tab'],
    ['a subframe', { frameId: 3 }, 'chatgpt', 'subframe'],
    ['a missing frame id', { frameId: undefined }, 'chatgpt', 'subframe'],
    ['the other provider', {}, 'claude', 'wrong-origin'],
    ['a lookalike host', { url: 'https://chatgpt.com.example.net/', origin: 'https://chatgpt.com.example.net' }, 'chatgpt', 'wrong-origin'],
    ['plain http', { url: 'http://chatgpt.com/', origin: 'http://chatgpt.com' }, 'chatgpt', 'wrong-origin'],
    ['a document whose origin differs from its URL', { origin: 'null' }, 'chatgpt', 'wrong-origin'],
    ['no URL', { url: undefined }, 'chatgpt', 'wrong-origin'],
  ])('the worker rejects %s', (_name, overrides, provider, reason) => {
    expect(
      checkPageSender(contentScript('https://chatgpt.com/', overrides), EXTENSION_ID, provider, recognizer),
    ).toEqual({ ok: false, reason });
  });
});

import {
  isConversationId,
  isConversationProviderId,
  isTabId,
  type ConversationProviderId,
  type UrlClassification,
} from '../domain';
import type { PageRefusalReason } from '../infrastructure/provider-pages';
import type { ConversationRecognizer, ProviderPageKind, ProviderPageReport } from '../ports';

/**
 * Typed messages between the background service worker and the provider
 * content scripts (Phase 2.2B foundation).
 *
 * - The worker sends `inspect-page` with `tabs.sendMessage` to the top frame
 *   of one tab; the content script answers with `page-report` or `page-refused`.
 * - A content script sends `page-hello` with `runtime.sendMessage` once per
 *   document load, so the worker learns about new documents (navigations and
 *   reloads) even when it missed the tab events.
 *
 * There is no message that carries code, selectors, URLs or prompt text: the
 * set of operations is fixed here, and every message is validated as untrusted
 * `unknown` on arrival, together with its sender.
 */
export const PROVIDER_TRANSPORT_CHANNEL = 'thirdmind/provider-transport';
export const PROVIDER_TRANSPORT_VERSION = 1;

const MAX_ID_LENGTH = 128;

interface Envelope {
  readonly channel: typeof PROVIDER_TRANSPORT_CHANNEL;
  readonly version: typeof PROVIDER_TRANSPORT_VERSION;
}

/** Worker → content script. */
export interface InspectPageRequest extends Envelope {
  readonly type: 'inspect-page';
  readonly requestId: string;
  /** The provider the worker expects this tab to belong to. */
  readonly provider: ConversationProviderId;
}

/** Content script → worker, as the answer to an `inspect-page` request. */
export type PageResponse =
  | (Envelope & {
      readonly type: 'page-report';
      readonly requestId: string;
      readonly pageInstanceId: string;
      readonly report: ProviderPageReport;
    })
  | (Envelope & {
      readonly type: 'page-refused';
      readonly requestId: string;
      readonly pageInstanceId: string;
      readonly reason: PageRefusalReason;
    });

/** Content script → worker, sent once when a content script starts in a document. */
export interface PageHello extends Envelope {
  readonly type: 'page-hello';
  readonly provider: ConversationProviderId;
  readonly pageInstanceId: string;
}

const ENVELOPE: Envelope = { channel: PROVIDER_TRANSPORT_CHANNEL, version: PROVIDER_TRANSPORT_VERSION };

export function inspectPageRequest(requestId: string, provider: ConversationProviderId): InspectPageRequest {
  return { ...ENVELOPE, type: 'inspect-page', requestId, provider };
}

export function pageHello(provider: ConversationProviderId, pageInstanceId: string): PageHello {
  return { ...ENVELOPE, type: 'page-hello', provider, pageInstanceId };
}

export function pageReport(requestId: string, pageInstanceId: string, report: ProviderPageReport): PageResponse {
  return { ...ENVELOPE, type: 'page-report', requestId, pageInstanceId, report };
}

export function pageRefused(requestId: string, pageInstanceId: string, reason: PageRefusalReason): PageResponse {
  return { ...ENVELOPE, type: 'page-refused', requestId, pageInstanceId, reason };
}

export function parseInspectPageRequest(value: unknown): InspectPageRequest | null {
  if (!hasEnvelope(value) || value.type !== 'inspect-page') {
    return null;
  }
  const { requestId, provider } = value;
  return isId(requestId) && isConversationProviderId(provider) ? inspectPageRequest(requestId, provider) : null;
}

export function parsePageHello(value: unknown): PageHello | null {
  if (!hasEnvelope(value) || value.type !== 'page-hello') {
    return null;
  }
  const { provider, pageInstanceId } = value;
  return isConversationProviderId(provider) && isId(pageInstanceId) ? pageHello(provider, pageInstanceId) : null;
}

/**
 * Content scripts run inside provider pages, so their answers are validated
 * completely and rebuilt field by field: nothing unexpected is passed on.
 */
export function parsePageResponse(value: unknown): PageResponse | null {
  if (!hasEnvelope(value)) {
    return null;
  }
  const { type, requestId, pageInstanceId } = value;
  if (!isId(requestId) || !isId(pageInstanceId)) {
    return null;
  }
  if (type === 'page-refused') {
    const { reason } = value;
    return reason === 'unsupported-page' || reason === 'wrong-provider'
      ? pageRefused(requestId, pageInstanceId, reason)
      : null;
  }
  if (type === 'page-report') {
    const report = parseReport(value.report);
    return report === null ? null : pageReport(requestId, pageInstanceId, report);
  }
  return null;
}

function parseReport(value: unknown): ProviderPageReport | null {
  if (!isRecord(value)) {
    return null;
  }
  const { provider, documentState, visibility, composer } = value;
  const page = parsePageKind(value.page);
  if (
    !isConversationProviderId(provider) ||
    page === null ||
    (documentState !== 'loading' && documentState !== 'interactive' && documentState !== 'complete') ||
    (visibility !== 'visible' && visibility !== 'hidden') ||
    (composer !== 'present' && composer !== 'absent')
  ) {
    return null;
  }
  return { provider, page, documentState, visibility, composer };
}

function parsePageKind(value: unknown): ProviderPageKind | null {
  if (!isRecord(value)) {
    return null;
  }
  switch (value.kind) {
    case 'conversation':
      return isConversationId(value.conversationId)
        ? { kind: 'conversation', conversationId: value.conversationId }
        : null;
    case 'new-chat':
      return { kind: 'new-chat' };
    case 'provider-page':
      return { kind: 'provider-page' };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Senders
// ---------------------------------------------------------------------------

/** The parts of `runtime.MessageSender` that are checked. The real sender satisfies it structurally. */
export interface MessageSenderLike {
  readonly id?: string;
  readonly url?: string;
  readonly origin?: string;
  readonly frameId?: number;
  readonly tab?: { readonly id?: number };
}

/**
 * Content script side: accepts only messages sent by this extension's own
 * pages or service worker. Messages from content scripts carry a `tab`; this
 * also rejects messages from other extensions and from web pages.
 */
export function isExtensionSender(sender: MessageSenderLike, extensionId: string): boolean {
  if (sender.id !== extensionId || sender.tab !== undefined) {
    return false;
  }
  const extensionOrigin = `chrome-extension://${extensionId}`;
  return (
    (sender.origin === undefined || sender.origin === extensionOrigin) &&
    (sender.url === undefined || sender.url.startsWith(`${extensionOrigin}/`))
  );
}

export type PageSenderCheck =
  | { readonly ok: true; readonly tabId: number }
  | { readonly ok: false; readonly reason: 'foreign-extension' | 'not-a-tab' | 'subframe' | 'wrong-origin' };

/**
 * Worker side: accepts a message only from this extension's content script
 * in the top frame of a tab whose document is on `provider`'s exact origin.
 * The sender's URL and origin are set by Chrome, not by the page, so a
 * provider page cannot claim to be the other provider.
 */
export function checkPageSender(
  sender: MessageSenderLike,
  extensionId: string,
  provider: ConversationProviderId,
  recognizer: ConversationRecognizer,
): PageSenderCheck {
  if (sender.id !== extensionId) {
    return { ok: false, reason: 'foreign-extension' };
  }
  const tabId = sender.tab?.id;
  if (!isTabId(tabId)) {
    return { ok: false, reason: 'not-a-tab' };
  }
  if (sender.frameId !== 0) {
    return { ok: false, reason: 'subframe' };
  }
  if (typeof sender.url !== 'string') {
    return { ok: false, reason: 'wrong-origin' };
  }
  // The URL rules match the exact provider origin, so a URL of `provider` is on that origin.
  if (providerOf(recognizer.recognize(sender.url)) !== provider) {
    return { ok: false, reason: 'wrong-origin' };
  }
  // `origin` is the document's real origin (it differs from the URL for sandboxed or opaque documents).
  if (sender.origin !== undefined && !hasOrigin(sender.url, sender.origin)) {
    return { ok: false, reason: 'wrong-origin' };
  }
  return { ok: true, tabId };
}

export function providerOf(classification: UrlClassification): ConversationProviderId | null {
  switch (classification.kind) {
    case 'conversation':
      return classification.conversation.provider;
    case 'new-chat':
    case 'provider-page':
      return classification.provider;
    case 'unsupported':
      return null;
  }
}

function hasOrigin(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

function hasEnvelope(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) && value.channel === PROVIDER_TRANSPORT_CHANNEL && value.version === PROVIDER_TRANSPORT_VERSION
  );
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

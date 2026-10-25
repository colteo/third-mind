import type { BrowserTabId, UrlClassification } from '../domain';
import { providerPageReadiness } from '../infrastructure/provider-pages';
import type {
  ConversationRecognizer,
  IdGenerator,
  ProviderPageKind,
  ProviderPageTransport,
  ProviderProbeResult,
  TransportFailure,
  TransportFailureKind,
} from '../ports';
import type { TabLike } from './chrome-tabs';
import {
  checkPageSender,
  inspectPageRequest,
  parsePageHello,
  parsePageResponse,
  providerOf,
  type MessageSenderLike,
  type PageSenderCheck,
} from './provider-transport-protocol';

/**
 * Background end of the provider page transport (Phase 2.2B foundation).
 *
 * Only the parts of `chrome.tabs` that the transport uses are described here,
 * so tests can pass a fake object. The real `browser.tabs` satisfies this
 * interface structurally. `tabs.sendMessage` needs no permission beyond the
 * content scripts declared in the manifest.
 */
export interface TransportTabsApi {
  get(tabId: number): Promise<TabLike>;
  sendMessage(tabId: number, message: unknown, options: { frameId: number }): Promise<unknown>;
}

/** Long enough for a busy provider page, short enough that the panel does not appear stuck. */
export const DEFAULT_TRANSPORT_TIMEOUT_MS = 3000;

export interface ProviderTransportOptions {
  /** `undefined` when the browser does not expose `chrome.tabs` to this context. */
  readonly tabs: TransportTabsApi | undefined;
  readonly extensionId: string;
  readonly recognizer: ConversationRecognizer;
  readonly ids: IdGenerator;
  readonly timeoutMs?: number;
}

export type PageMessageResult =
  | { readonly accepted: true; readonly tabId: BrowserTabId }
  | { readonly accepted: false; readonly reason: 'not-a-transport-message' | Extract<PageSenderCheck, { ok: false }>['reason'] };

export interface ProviderTransport extends ProviderPageTransport {
  /** Tab events from `watchTabEvents`. A changed URL marks a navigation. */
  tabChanged(tabId: BrowserTabId, url: string | null): void;
  tabRemoved(tabId: BrowserTabId): void;
  /** A `runtime.onMessage` message. Only valid `page-hello` messages from a provider page's top frame are accepted. */
  receivePageMessage(raw: unknown, sender: MessageSenderLike): PageMessageResult;
}

/**
 * What the transport knows about a tab's document. `navigation` comes from a
 * counter shared by all tabs and changes whenever the tab may show a different
 * document: a URL change, removal, or a content script announcing a new
 * document. An answer is only accepted if `navigation` did not change while
 * its request was in flight.
 *
 * Traces live only in memory. After a service worker restart nothing is
 * known, and the first operation on each tab starts a new trace. Requests
 * that were in flight when the worker stopped are lost together with their
 * answer channel; nothing about them is restored or replayed.
 */
interface TabTrace {
  readonly navigation: number;
  readonly url: string | null;
  readonly pageInstanceId: string | null;
}

type TabRead =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly kind: 'tab-closed' | 'tab-unreadable' | 'transport-error' };

type SendResult = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly failure: TransportFailure };

export function createProviderTransport(options: ProviderTransportOptions): ProviderTransport {
  const { tabs, extensionId, recognizer, ids, timeoutMs = DEFAULT_TRANSPORT_TIMEOUT_MS } = options;
  let sequence = 0;
  // Removed tabs keep their (small) trace: Chrome does not reuse tab ids within a browser session.
  const traces = new Map<BrowserTabId, TabTrace>();

  const navigated = (tabId: BrowserTabId, url: string | null, pageInstanceId: string | null): TabTrace => {
    sequence += 1;
    const trace = { navigation: sequence, url, pageInstanceId };
    traces.set(tabId, trace);
    return trace;
  };

  /** Starts or confirms the trace for a tab whose URL was just read. */
  const observe = (tabId: BrowserTabId, url: string): TabTrace => {
    const trace = traces.get(tabId);
    return trace !== undefined && trace.url === url ? trace : navigated(tabId, url, null);
  };

  const readTab = async (tabId: BrowserTabId): Promise<TabRead> => {
    if (tabs === undefined) {
      return { ok: false, kind: 'transport-error' };
    }
    let tab: TabLike;
    try {
      tab = await tabs.get(tabId);
    } catch (error) {
      return { ok: false, kind: isNoTabError(error) ? 'tab-closed' : 'transport-error' };
    }
    return typeof tab.url === 'string' && tab.url.length > 0
      ? { ok: true, url: tab.url }
      : { ok: false, kind: 'tab-unreadable' };
  };

  const send = (api: TransportTabsApi, tabId: BrowserTabId, message: unknown): Promise<SendResult> =>
    new Promise((resolve) => {
      // The first settlement wins; later ones are ignored by the promise.
      const timer = setTimeout(() => {
        resolve({ ok: false, failure: { kind: 'timeout', outcome: 'unknown' } });
      }, timeoutMs);
      const settle = (result: SendResult): void => {
        clearTimeout(timer);
        resolve(result);
      };
      try {
        // Top frame only: provider content scripts never run in subframes.
        api.sendMessage(tabId, message, { frameId: 0 }).then(
          (value) => {
            settle({ ok: true, value });
          },
          (error: unknown) => {
            settle({ ok: false, failure: classifySendError(error) });
          },
        );
      } catch (error) {
        settle({ ok: false, failure: classifySendError(error) });
      }
    });

  return {
    async probe(tabId, provider): Promise<ProviderProbeResult> {
      if (tabs === undefined || typeof tabs.get !== 'function' || typeof tabs.sendMessage !== 'function') {
        return failed('transport-unavailable', 'not-performed');
      }

      // 1. Validate the tab before sending anything.
      const before = await readTab(tabId);
      if (!before.ok) {
        return failed(before.kind, 'not-performed');
      }
      const expected = recognizer.recognize(before.url);
      const shownProvider = providerOf(expected);
      if (shownProvider === null) {
        return failed('unsupported-page', 'not-performed');
      }
      if (shownProvider !== provider) {
        return failed('wrong-provider', 'not-performed');
      }
      const trace = observe(tabId, before.url);

      // 2. Send to the top frame, with a timeout.
      const requestId = ids.newId('page-request');
      const sent = await send(tabs, tabId, inspectPageRequest(requestId, provider));
      if (!sent.ok) {
        return { ok: false, failure: sent.failure };
      }

      // 3. Reject stale answers: the tab must still exist and show the document the request was sent to.
      //    The URL is compared as well as the trace, because tab events are lost while the worker is suspended.
      const after = await readTab(tabId);
      if (!after.ok) {
        return failed(after.kind, 'unknown');
      }
      if (traces.get(tabId)?.navigation !== trace.navigation || after.url !== before.url) {
        observe(tabId, after.url);
        return failed('navigated', 'unknown');
      }

      // 4. Validate the answer itself.
      const response = parsePageResponse(sent.value);
      if (response === null || response.requestId !== requestId) {
        return failed('invalid-response', 'unknown');
      }
      if (response.type === 'page-refused') {
        return failed(response.reason, 'not-performed');
      }
      const { report, pageInstanceId } = response;
      // A script that reports (rather than refuses) for another provider is misbehaving.
      if (report.provider !== provider) {
        return failed('invalid-response', 'unknown');
      }
      // The page classifies its own URL. Disagreement means the answer came from another document than the tab shows.
      if (!showsSamePage(report.page, expected) || (trace.pageInstanceId ?? pageInstanceId) !== pageInstanceId) {
        return failed('navigated', 'unknown');
      }
      traces.set(tabId, { ...trace, pageInstanceId });
      return {
        ok: true,
        status: { ...report, tabId, pageInstanceId, readiness: providerPageReadiness(report) },
      };
    },

    tabChanged(tabId, url) {
      const trace = traces.get(tabId);
      // Tabs that were never used by the transport need no trace yet.
      if (trace !== undefined && trace.url !== url) {
        navigated(tabId, url, null);
      }
    },

    tabRemoved(tabId) {
      if (traces.has(tabId)) {
        navigated(tabId, null, null);
      }
    },

    receivePageMessage(raw, sender) {
      const hello = parsePageHello(raw);
      if (hello === null) {
        return { accepted: false, reason: 'not-a-transport-message' };
      }
      const check = checkPageSender(sender, extensionId, hello.provider, recognizer);
      if (!check.ok) {
        return { accepted: false, reason: check.reason };
      }
      const trace = traces.get(check.tabId);
      if (trace?.pageInstanceId !== hello.pageInstanceId) {
        // A new document in this tab: answers from the previous one are stale from now on.
        navigated(check.tabId, sender.url ?? null, hello.pageInstanceId);
      }
      return { accepted: true, tabId: check.tabId };
    },
  };
}

function failed(kind: TransportFailureKind, outcome: TransportFailure['outcome']): ProviderProbeResult {
  return { ok: false, failure: { kind, outcome } };
}

function showsSamePage(page: ProviderPageKind, expected: UrlClassification): boolean {
  switch (page.kind) {
    case 'conversation':
      return expected.kind === 'conversation' && expected.conversation.conversationId === page.conversationId;
    case 'new-chat':
      return expected.kind === 'new-chat';
    case 'provider-page':
      return expected.kind === 'provider-page';
  }
}

/**
 * Chrome reports messaging failures only as error messages, which are not a
 * stable API. Messages that are not recognized are treated conservatively:
 * the request may have been delivered, so the outcome is unknown.
 */
function classifySendError(error: unknown): TransportFailure {
  const message = error instanceof Error ? error.message : String(error);
  // Nothing in the tab listens: no content script was injected (for example, the tab was opened before the
  // extension was installed or reloaded) or the document has no content script yet.
  if (/receiving end does not exist|could not establish connection/i.test(message)) {
    return { kind: 'content-script-unavailable', outcome: 'not-performed' };
  }
  if (isNoTabError(error)) {
    return { kind: 'tab-closed', outcome: 'not-performed' };
  }
  // The document went away (navigation, reload, back/forward cache) after the message may have been delivered.
  if (/back\/forward cache|message channel is closed|message port closed/i.test(message)) {
    return { kind: 'navigated', outcome: 'unknown' };
  }
  return { kind: 'transport-error', outcome: 'unknown' };
}

function isNoTabError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no tab with id/i.test(message);
}

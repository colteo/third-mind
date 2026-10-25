import { browser } from 'wxt/browser';
import type { ConversationProviderId } from '../domain';
import { inspectProviderPage, type PageEnvironment } from '../infrastructure/provider-pages';
import {
  isExtensionSender,
  pageHello,
  pageRefused,
  pageReport,
  parseInspectPageRequest,
  type MessageSenderLike,
  type PageResponse,
} from './provider-transport-protocol';

/**
 * Provider content script (Phase 2.2B foundation).
 *
 * Runs in the isolated world of the top frame of `https://chatgpt.com/*` and
 * `https://claude.ai/*` pages. It answers exactly one kind of request,
 * `inspect-page`, with non-sensitive readiness facts. It does not read
 * conversation text, type, click, submit, observe the DOM, make network
 * requests or evaluate anything it receives.
 */
export interface ContentScriptContext {
  /** The provider this script was declared for in the manifest. */
  readonly provider: ConversationProviderId;
  readonly extensionId: string;
  /** Random per script instance, so the worker can tell documents apart. */
  readonly pageInstanceId: string;
  readonly page: PageEnvironment;
}

/**
 * Returns the answer to send, or `null` to stay silent: messages that are not
 * transport requests, or that do not come from this extension's own pages or
 * service worker, are ignored without an answer.
 */
export function handleTransportRequest(
  raw: unknown,
  sender: MessageSenderLike,
  context: ContentScriptContext,
): PageResponse | null {
  if (!isExtensionSender(sender, context.extensionId)) {
    return null;
  }
  const request = parseInspectPageRequest(raw);
  if (request === null) {
    return null;
  }
  if (request.provider !== context.provider) {
    return pageRefused(request.requestId, context.pageInstanceId, 'wrong-provider');
  }
  const inspection = inspectProviderPage(context.page, context.provider);
  return inspection.ok
    ? pageReport(request.requestId, context.pageInstanceId, inspection.report)
    : pageRefused(request.requestId, context.pageInstanceId, inspection.reason);
}

/** Reads the live page lazily, at the time of each request. */
const livePage: PageEnvironment = {
  get href() {
    return location.href;
  },
  get readyState() {
    return document.readyState;
  },
  get visibilityState() {
    return document.visibilityState;
  },
  hasElement: (selector) => document.querySelector(selector) !== null,
};

interface InvalidationContext {
  onInvalidated(callback: () => void): () => void;
}

/** Entry point for the WXT content script entrypoints. */
export function startProviderContentScript(provider: ConversationProviderId, ctx: InvalidationContext): void {
  const context: ContentScriptContext = {
    provider,
    extensionId: browser.runtime.id,
    pageInstanceId: crypto.randomUUID(),
    page: livePage,
  };

  const listener = (raw: unknown, sender: MessageSenderLike, sendResponse: (response: unknown) => void): undefined => {
    const response = handleTransportRequest(raw, sender, context);
    if (response !== null) {
      // Inspection is synchronous, so the answer is sent before the listener returns.
      sendResponse(response);
    }
    return undefined;
  };
  browser.runtime.onMessage.addListener(listener);
  // After the extension is reloaded or updated, this script is orphaned and must stop answering.
  ctx.onInvalidated(() => {
    browser.runtime.onMessage.removeListener(listener);
  });

  browser.runtime.sendMessage(pageHello(provider, context.pageInstanceId)).catch(() => {
    // The worker does not answer hellos, and it may be unavailable during an extension reload. Both are harmless:
    // the worker validates the tab before every operation and does not depend on this announcement.
  });
}

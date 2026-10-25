import type { ConversationProviderId } from '../domain';
import type { ProviderPageKind, ProviderPageReadiness, ProviderPageReport } from '../ports';
import { PROVIDER_URL_RULES, classifyUrl, type ProviderUrlRule } from './conversation-urls';

/**
 * Provider page readiness rules (Phase 2.2B foundation).
 *
 * Like the URL rules, these describe the providers' current websites and
 * will change when the providers change them. They are configuration used by
 * the content scripts, not domain rules.
 *
 * A page is inspected only for facts that contain no user data: what its URL
 * shows (by the same exact-origin rules as tab discovery), the document's
 * loading and visibility state, and whether the provider's message box
 * element exists. Element contents, titles and conversation text are never read.
 */
export interface ProviderPageRule {
  readonly provider: ConversationProviderId;
  /**
   * CSS selectors of the message box ("composer"). The composer counts as
   * present when any of them matches an element.
   *
   * These selectors are based on manual inspection of the providers' current
   * pages and are **unverified**: no automated test runs against the real
   * websites. A selector that no longer matches makes chat pages report
   * `composer-missing`; it never makes a page look ready.
   */
  readonly composerSelectors: readonly string[];
}

export const PROVIDER_PAGE_RULES: readonly ProviderPageRule[] = [
  { provider: 'chatgpt', composerSelectors: ['#prompt-textarea'] },
  { provider: 'claude', composerSelectors: ['div.ProseMirror[contenteditable="true"]'] },
];

/**
 * The parts of the page a content script may look at. The real implementation
 * reads `location` and `document`; tests pass plain objects.
 */
export interface PageEnvironment {
  readonly href: string;
  readonly readyState: string;
  readonly visibilityState: string;
  /** True when at least one element matches `selector`. Must not read the element's contents. */
  hasElement(selector: string): boolean;
}

/**
 * Why a page refuses to report:
 * - `unsupported-page`: the page is not on a supported provider origin;
 * - `wrong-provider`: the page belongs to a different provider than the one asked about.
 */
export type PageRefusalReason = 'unsupported-page' | 'wrong-provider';

export type PageInspection =
  | { readonly ok: true; readonly report: ProviderPageReport }
  | { readonly ok: false; readonly reason: PageRefusalReason };

/**
 * Inspects the current page for `expectedProvider`. The page's own URL is
 * classified with the exact-origin rules, so a content script that runs on
 * any other origin (or for the other provider) refuses instead of reporting.
 */
export function inspectProviderPage(
  page: PageEnvironment,
  expectedProvider: ConversationProviderId,
  urlRules: readonly ProviderUrlRule[] = PROVIDER_URL_RULES,
  pageRules: readonly ProviderPageRule[] = PROVIDER_PAGE_RULES,
): PageInspection {
  const classification = classifyUrl(page.href, urlRules);
  if (classification.kind === 'unsupported') {
    return { ok: false, reason: 'unsupported-page' };
  }
  const provider =
    classification.kind === 'conversation' ? classification.conversation.provider : classification.provider;
  if (provider !== expectedProvider) {
    return { ok: false, reason: 'wrong-provider' };
  }
  const kind: ProviderPageKind =
    classification.kind === 'conversation'
      ? { kind: 'conversation', conversationId: classification.conversation.conversationId }
      : classification.kind === 'new-chat'
        ? { kind: 'new-chat' }
        : { kind: 'provider-page' };
  const selectors = pageRules.find((rule) => rule.provider === provider)?.composerSelectors ?? [];
  return {
    ok: true,
    report: {
      provider,
      page: kind,
      documentState: toDocumentState(page.readyState),
      visibility: page.visibilityState === 'visible' ? 'visible' : 'hidden',
      composer: selectors.some((selector) => safeHasElement(page, selector)) ? 'present' : 'absent',
    },
  };
}

export function providerPageReadiness(report: ProviderPageReport): ProviderPageReadiness {
  if (report.page.kind === 'provider-page') {
    return 'not-a-chat-page';
  }
  if (report.documentState === 'loading') {
    return 'loading';
  }
  return report.composer === 'present' ? 'ready' : 'composer-missing';
}

function toDocumentState(readyState: string): ProviderPageReport['documentState'] {
  return readyState === 'complete' || readyState === 'interactive' ? readyState : 'loading';
}

/** An invalid selector (for example, after a bad rule update) counts as no match rather than an error. */
function safeHasElement(page: PageEnvironment, selector: string): boolean {
  try {
    return page.hasElement(selector);
  } catch {
    return false;
  }
}

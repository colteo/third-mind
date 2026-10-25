import type { ConversationProviderId, UrlClassification } from '../domain';
import type { ConversationRecognizer } from '../ports';

/**
 * Provider URL rules (Phase 2.1).
 *
 * These describe the providers' current websites and will change when the
 * providers change them. They are configuration, not domain rules: the domain
 * only sees the resulting `UrlClassification`.
 *
 * Matching is done on the parsed URL: the origin must be exactly equal to the
 * rule's origin (scheme, host and port), and the path must match one of the
 * anchored conversation patterns. Substring matching is never used, so
 * lookalike hosts (`chatgpt.com.example.net`, `evil-claude.ai`) and URLs that
 * merely mention a provider in their path or query are rejected.
 */
export interface ProviderUrlRule {
  readonly provider: ConversationProviderId;
  /** Exact origin, for example `https://chatgpt.com`. */
  readonly origin: string;
  /**
   * Anchored path patterns of conversation pages. Each must capture the
   * conversation identifier in a named group `id`.
   */
  readonly conversationPaths: readonly RegExp[];
}

/** Conversation identifiers on both sites are UUIDs today. */
const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';

export const PROVIDER_URL_RULES: readonly ProviderUrlRule[] = [
  {
    provider: 'chatgpt',
    origin: 'https://chatgpt.com',
    conversationPaths: [
      // https://chatgpt.com/c/<uuid>
      new RegExp(`^/c/(?<id>${UUID})/?$`),
      // Conversations inside a custom GPT or a project: https://chatgpt.com/g/<g-…>/c/<uuid>
      new RegExp(`^/g/g-[A-Za-z0-9_-]+/c/(?<id>${UUID})/?$`),
    ],
  },
  {
    provider: 'claude',
    origin: 'https://claude.ai',
    conversationPaths: [
      // https://claude.ai/chat/<uuid>
      new RegExp(`^/chat/(?<id>${UUID})/?$`),
    ],
  },
];

/** Longer URLs are not classified at all. */
export const MAX_RECOGNIZED_URL_LENGTH = 2048;

const UNSUPPORTED: UrlClassification = { kind: 'unsupported' };

export function classifyUrl(url: string, rules: readonly ProviderUrlRule[] = PROVIDER_URL_RULES): UrlClassification {
  if (url.length > MAX_RECOGNIZED_URL_LENGTH) {
    return UNSUPPORTED;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return UNSUPPORTED;
  }
  // Credentials in a URL are never legitimate here and are a common spoofing device.
  if (parsed.username !== '' || parsed.password !== '') {
    return UNSUPPORTED;
  }
  const rule = rules.find((candidate) => candidate.origin === parsed.origin);
  if (rule === undefined) {
    return UNSUPPORTED;
  }
  for (const pattern of rule.conversationPaths) {
    const id = pattern.exec(parsed.pathname)?.groups?.id;
    if (id !== undefined) {
      const path = parsed.pathname.endsWith('/') ? parsed.pathname.slice(0, -1) : parsed.pathname;
      const conversationId = id.toLowerCase();
      return {
        kind: 'conversation',
        conversation: {
          provider: rule.provider,
          conversationId,
          canonicalUrl: `${rule.origin}${path.slice(0, path.length - id.length)}${conversationId}`,
        },
      };
    }
  }
  return { kind: 'provider-page', provider: rule.provider };
}

export function createConversationRecognizer(
  rules: readonly ProviderUrlRule[] = PROVIDER_URL_RULES,
): ConversationRecognizer {
  return { recognize: (url) => classifyUrl(url, rules) };
}

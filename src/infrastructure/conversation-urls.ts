import type { ConversationProviderId, UrlClassification } from '../domain';
import type { ConversationRecognizer } from '../ports';

/**
 * Provider URL rules (Phase 2.1, new-chat entry points Phase 2.2A).
 *
 * These describe the providers' current websites and will change when the
 * providers change them. They are configuration, not domain rules: the domain
 * only sees the resulting `UrlClassification`.
 *
 * Matching is done on the parsed URL: the origin must be exactly equal to the
 * rule's origin (scheme, host and port), and the path must match one of the
 * anchored patterns. Substring matching is never used, so lookalike hosts
 * (`chatgpt.com.example.net`, `evil-claude.ai`) and URLs that merely mention a
 * provider in their path or query are rejected.
 *
 * Every other path on a supported origin is a `provider-page`: it is listed
 * as "not a conversation or new chat" and can never be linked. A new path
 * only becomes linkable once it is modeled here explicitly.
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
  /** Anchored path patterns of confirmed new-chat entry points (pages that start an empty, unsaved chat). */
  readonly newChatPaths: readonly RegExp[];
  /**
   * Query parameters that turn a new-chat entry point into a chat the
   * provider does not save (for example, temporary chats). Such a page never
   * receives a conversation identifier, so it is not offered as a new chat.
   */
  readonly unsavedChatQueryParameters: readonly string[];
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
    // The home page is ChatGPT's new-chat page; the first message moves the tab to /c/<uuid>.
    // New chats inside a custom GPT or project (/g/…) are not modeled yet and stay provider pages.
    newChatPaths: [/^\/$/],
    // https://chatgpt.com/?temporary-chat=true is never saved and never gets a conversation URL.
    unsavedChatQueryParameters: ['temporary-chat'],
  },
  {
    provider: 'claude',
    origin: 'https://claude.ai',
    conversationPaths: [
      // https://claude.ai/chat/<uuid>
      new RegExp(`^/chat/(?<id>${UUID})/?$`),
    ],
    // https://claude.ai/new is the new-chat page. The site root is accepted as the same entry point,
    // because for signed-in users it shows the new-chat page (manually observed, not guaranteed).
    // A link created on `/` stays pending until the tab moves to /chat/<uuid>, so a root page that
    // never starts a chat (for example, a signed-out landing page) is harmless.
    newChatPaths: [/^\/new\/?$/, /^\/$/],
    // Incognito chats are not saved to the chat history. Whether they ever receive a /chat/ URL is
    // unverified, so they are not offered as new chats.
    unsavedChatQueryParameters: ['incognito'],
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
          origin: rule.origin,
          conversationId,
          canonicalUrl: `${rule.origin}${path.slice(0, path.length - id.length)}${conversationId}`,
        },
      };
    }
  }
  const isNewChat =
    rule.newChatPaths.some((pattern) => pattern.test(parsed.pathname)) &&
    !rule.unsavedChatQueryParameters.some((name) => parsed.searchParams.has(name));
  return isNewChat
    ? { kind: 'new-chat', provider: rule.provider, origin: rule.origin }
    : { kind: 'provider-page', provider: rule.provider };
}

export function createConversationRecognizer(
  rules: readonly ProviderUrlRule[] = PROVIDER_URL_RULES,
): ConversationRecognizer {
  return { recognize: (url) => classifyUrl(url, rules) };
}

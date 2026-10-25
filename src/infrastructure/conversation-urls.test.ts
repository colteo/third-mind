import { describe, expect, it } from 'vitest';
import { MAX_RECOGNIZED_URL_LENGTH, classifyUrl, createConversationRecognizer } from './conversation-urls';

const ID = '6f1c2a4e-1b2c-4d5e-8f90-a1b2c3d4e5f6';

describe('ChatGPT URL recognition', () => {
  it('recognizes a conversation URL and canonicalizes it', () => {
    expect(classifyUrl(`https://chatgpt.com/c/${ID}`)).toEqual({
      kind: 'conversation',
      conversation: { provider: 'chatgpt', origin: 'https://chatgpt.com', conversationId: ID, canonicalUrl: `https://chatgpt.com/c/${ID}` },
    });
  });

  it('ignores query strings, fragments, a trailing slash, the default port and letter case', () => {
    const result = classifyUrl(`HTTPS://ChatGPT.com:443/c/${ID.toUpperCase()}/?model=x#top`);
    expect(result).toEqual({
      kind: 'conversation',
      conversation: { provider: 'chatgpt', origin: 'https://chatgpt.com', conversationId: ID, canonicalUrl: `https://chatgpt.com/c/${ID}` },
    });
  });

  it('recognizes conversations inside a custom GPT or project', () => {
    const url = `https://chatgpt.com/g/g-p-67ab12cd-research/c/${ID}`;
    expect(classifyUrl(url)).toEqual({
      kind: 'conversation',
      conversation: { provider: 'chatgpt', origin: 'https://chatgpt.com', conversationId: ID, canonicalUrl: url },
    });
  });
});

describe('Claude URL recognition', () => {
  it('recognizes a conversation URL', () => {
    expect(classifyUrl(`https://claude.ai/chat/${ID}?q=1`)).toEqual({
      kind: 'conversation',
      conversation: { provider: 'claude', origin: 'https://claude.ai', conversationId: ID, canonicalUrl: `https://claude.ai/chat/${ID}` },
    });
  });
});

describe('new-chat entry points', () => {
  it.each(['https://chatgpt.com/', 'https://chatgpt.com', 'https://chatgpt.com/?model=gpt-5', 'https://chatgpt.com/#settings'])(
    'treats %s as a ChatGPT new chat',
    (url) => {
      expect(classifyUrl(url)).toEqual({ kind: 'new-chat', provider: 'chatgpt', origin: 'https://chatgpt.com' });
    },
  );

  it.each(['https://claude.ai/new', 'https://claude.ai/new/', 'https://claude.ai/new?q=hello', 'https://claude.ai/'])(
    'treats %s as a Claude new chat',
    (url) => {
      expect(classifyUrl(url)).toEqual({ kind: 'new-chat', provider: 'claude', origin: 'https://claude.ai' });
    },
  );

  it('never invents a conversation identifier for a new chat', () => {
    expect(classifyUrl('https://claude.ai/new')).not.toHaveProperty('conversation');
  });

  it.each([
    // Temporary and incognito chats are never saved, so they never receive a conversation identifier.
    ['https://chatgpt.com/?temporary-chat=true', 'chatgpt'],
    ['https://claude.ai/new?incognito', 'claude'],
    ['https://claude.ai/new?incognito=true', 'claude'],
  ] as const)('does not offer the unsaved chat %s as a new chat', (url, provider) => {
    expect(classifyUrl(url)).toEqual({ kind: 'provider-page', provider });
  });
});

describe('conversation versus provider page classification', () => {
  it.each([
    `https://chatgpt.com/share/${ID}`,
    'https://chatgpt.com/g/g-abc123-writer',
    // New chats inside a custom GPT or project are not modeled yet.
    'https://chatgpt.com/g/g-p-67ab12cd-research/project',
    'https://chatgpt.com/c/',
    'https://chatgpt.com/c/not-a-conversation-id',
    `https://chatgpt.com/c/${ID}/extra`,
    `https://chatgpt.com/x/c/${ID}`,
    'https://chatgpt.com/new',
    'https://chatgpt.com/gpts',
    'https://chatgpt.com//',
  ])('treats %s as a ChatGPT page without a conversation or new chat', (url) => {
    expect(classifyUrl(url)).toEqual({ kind: 'provider-page', provider: 'chatgpt' });
  });

  it.each([
    'https://claude.ai/recents',
    'https://claude.ai/NEW',
    'https://claude.ai/new/extra',
    'https://claude.ai/newchat',
    'https://claude.ai/projects',
    `https://claude.ai/project/${ID}`,
    `https://claude.ai/chat/${ID}x`,
    'https://claude.ai/settings/profile',
  ])('treats %s as a Claude page without a conversation or new chat', (url) => {
    expect(classifyUrl(url)).toEqual({ kind: 'provider-page', provider: 'claude' });
  });
});

describe('unsupported URLs', () => {
  it.each([
    'https://example.com/',
    `https://example.com/c/${ID}`,
    'chrome://extensions/',
    'about:blank',
    'not a url',
    '',
    `file:///C:/chatgpt.com/c/${ID}`,
    // Wrong scheme or port: not the same origin.
    `http://chatgpt.com/c/${ID}`,
    `https://chatgpt.com:8443/c/${ID}`,
    `http://claude.ai/chat/${ID}`,
    // Former domain; it redirects to chatgpt.com but is not supported.
    `https://chat.openai.com/c/${ID}`,
    `https://www.claude.ai/chat/${ID}`,
  ])('rejects %s', (url) => {
    expect(classifyUrl(url)).toEqual({ kind: 'unsupported' });
  });

  it('rejects URLs longer than the limit', () => {
    const url = `https://chatgpt.com/c/${ID}?pad=${'a'.repeat(MAX_RECOGNIZED_URL_LENGTH)}`;
    expect(classifyUrl(url)).toEqual({ kind: 'unsupported' });
  });
});

describe('hostname spoofing and lookalike domains', () => {
  it.each([
    `https://chatgpt.com.evil.example/c/${ID}`,
    `https://evil-chatgpt.com/c/${ID}`,
    `https://chatgpt.co/c/${ID}`,
    `https://chatgpt.com.:443/c/${ID}`,
    `https://claude.ai.evil.example/chat/${ID}`,
    `https://notclaude.ai/chat/${ID}`,
    `https://claude.ai@evil.example/chat/${ID}`,
    `https://user:pass@claude.ai/chat/${ID}`,
    `https://evil.example/https://chatgpt.com/c/${ID}`,
    `https://evil.example/?next=https://claude.ai/chat/${ID}`,
    `https://evil.example/#https://chatgpt.com/c/${ID}`,
    // Cyrillic letters that look like Latin ones (IDN homograph).
    `https://сhatgpt.com/c/${ID}`,
    `https://claudе.ai/chat/${ID}`,
    // Spoofed new-chat entry points.
    'https://chatgpt.com.evil.example/',
    'http://chatgpt.com/',
    'https://chatgpt.com:8443/',
    'https://www.chatgpt.com/',
    'https://claude.ai.evil.example/new',
    'http://claude.ai/new',
    'https://user@claude.ai/new',
    'https://evil.example/new?next=https://claude.ai/new',
    'https://сhatgpt.com/',
  ])('rejects %s', (url) => {
    expect(classifyUrl(url).kind).not.toBe('conversation');
    expect(classifyUrl(url).kind).not.toBe('new-chat');
    expect(classifyUrl(url)).toEqual({ kind: 'unsupported' });
  });
});

describe('configurable rules', () => {
  it('uses the rules it is given, so URL patterns can change without touching the domain', () => {
    const recognizer = createConversationRecognizer([
      {
        provider: 'claude',
        origin: 'https://claude.example',
        conversationPaths: [/^\/t\/(?<id>[a-z]+)$/],
        newChatPaths: [/^\/start$/],
        unsavedChatQueryParameters: [],
      },
    ]);
    expect(recognizer.recognize('https://claude.example/t/abc')).toEqual({
      kind: 'conversation',
      conversation: {
        provider: 'claude',
        origin: 'https://claude.example',
        conversationId: 'abc',
        canonicalUrl: 'https://claude.example/t/abc',
      },
    });
    expect(recognizer.recognize('https://claude.example/start')).toEqual({
      kind: 'new-chat',
      provider: 'claude',
      origin: 'https://claude.example',
    });
    expect(recognizer.recognize('https://claude.example/new')).toEqual({ kind: 'provider-page', provider: 'claude' });
    expect(recognizer.recognize(`https://claude.ai/chat/${ID}`)).toEqual({ kind: 'unsupported' });
  });
});

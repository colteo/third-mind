import { describe, expect, it } from 'vitest';
import { MAX_RECOGNIZED_URL_LENGTH, classifyUrl, createConversationRecognizer } from './conversation-urls';

const ID = '6f1c2a4e-1b2c-4d5e-8f90-a1b2c3d4e5f6';

describe('ChatGPT URL recognition', () => {
  it('recognizes a conversation URL and canonicalizes it', () => {
    expect(classifyUrl(`https://chatgpt.com/c/${ID}`)).toEqual({
      kind: 'conversation',
      conversation: { provider: 'chatgpt', conversationId: ID, canonicalUrl: `https://chatgpt.com/c/${ID}` },
    });
  });

  it('ignores query strings, fragments, a trailing slash, the default port and letter case', () => {
    const result = classifyUrl(`HTTPS://ChatGPT.com:443/c/${ID.toUpperCase()}/?model=x#top`);
    expect(result).toEqual({
      kind: 'conversation',
      conversation: { provider: 'chatgpt', conversationId: ID, canonicalUrl: `https://chatgpt.com/c/${ID}` },
    });
  });

  it('recognizes conversations inside a custom GPT or project', () => {
    const url = `https://chatgpt.com/g/g-p-67ab12cd-research/c/${ID}`;
    expect(classifyUrl(url)).toEqual({
      kind: 'conversation',
      conversation: { provider: 'chatgpt', conversationId: ID, canonicalUrl: url },
    });
  });
});

describe('Claude URL recognition', () => {
  it('recognizes a conversation URL', () => {
    expect(classifyUrl(`https://claude.ai/chat/${ID}?q=1`)).toEqual({
      kind: 'conversation',
      conversation: { provider: 'claude', conversationId: ID, canonicalUrl: `https://claude.ai/chat/${ID}` },
    });
  });
});

describe('conversation versus provider page classification', () => {
  it.each([
    'https://chatgpt.com/',
    'https://chatgpt.com/?temporary-chat=true',
    `https://chatgpt.com/share/${ID}`,
    'https://chatgpt.com/g/g-abc123-writer',
    'https://chatgpt.com/c/',
    'https://chatgpt.com/c/not-a-conversation-id',
    `https://chatgpt.com/c/${ID}/extra`,
    `https://chatgpt.com/x/c/${ID}`,
  ])('treats %s as a ChatGPT page without a recognized conversation', (url) => {
    expect(classifyUrl(url)).toEqual({ kind: 'provider-page', provider: 'chatgpt' });
  });

  it.each([
    'https://claude.ai/',
    'https://claude.ai/new',
    'https://claude.ai/recents',
    `https://claude.ai/project/${ID}`,
    `https://claude.ai/chat/${ID}x`,
  ])('treats %s as a Claude page without a recognized conversation', (url) => {
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
  ])('rejects %s', (url) => {
    expect(classifyUrl(url).kind).not.toBe('conversation');
    expect(classifyUrl(url)).toEqual({ kind: 'unsupported' });
  });
});

describe('configurable rules', () => {
  it('uses the rules it is given, so URL patterns can change without touching the domain', () => {
    const recognizer = createConversationRecognizer([
      { provider: 'claude', origin: 'https://claude.example', conversationPaths: [/^\/t\/(?<id>[a-z]+)$/] },
    ]);
    expect(recognizer.recognize('https://claude.example/t/abc')).toEqual({
      kind: 'conversation',
      conversation: { provider: 'claude', conversationId: 'abc', canonicalUrl: 'https://claude.example/t/abc' },
    });
    expect(recognizer.recognize(`https://claude.ai/chat/${ID}`)).toEqual({ kind: 'unsupported' });
  });
});

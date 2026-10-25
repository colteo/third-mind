import { describe, expect, it } from 'vitest';
import type { ProviderPageReport } from '../ports';
import { inspectProviderPage, providerPageReadiness, type PageEnvironment } from './provider-pages';

const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

/** A fake page: `elements` lists the selectors that match. */
function page(href: string, elements: readonly string[] = [], overrides: Partial<PageEnvironment> = {}): PageEnvironment {
  return {
    href,
    readyState: 'complete',
    visibilityState: 'visible',
    hasElement: (selector) => elements.includes(selector),
    ...overrides,
  };
}

const CHATGPT_COMPOSER = '#prompt-textarea';
const CLAUDE_COMPOSER = 'div.ProseMirror[contenteditable="true"]';

describe('provider-specific readiness detection', () => {
  it('detects a ready ChatGPT conversation by its message box', () => {
    expect(inspectProviderPage(page(`https://chatgpt.com/c/${ID}`, [CHATGPT_COMPOSER]), 'chatgpt')).toEqual({
      ok: true,
      report: {
        provider: 'chatgpt',
        page: { kind: 'conversation', conversationId: ID },
        documentState: 'complete',
        visibility: 'visible',
        composer: 'present',
      },
    });
  });

  it('detects a ready Claude new chat by its message box', () => {
    const inspection = inspectProviderPage(page('https://claude.ai/new', [CLAUDE_COMPOSER]), 'claude');
    expect(inspection).toMatchObject({ ok: true, report: { page: { kind: 'new-chat' }, composer: 'present' } });
  });

  it("does not accept one provider's message box on the other provider's page", () => {
    expect(inspectProviderPage(page('https://claude.ai/new', [CHATGPT_COMPOSER]), 'claude')).toMatchObject({
      ok: true,
      report: { composer: 'absent' },
    });
    expect(inspectProviderPage(page('https://chatgpt.com/', [CLAUDE_COMPOSER]), 'chatgpt')).toMatchObject({
      ok: true,
      report: { composer: 'absent' },
    });
  });

  it('reports hidden tabs and loading documents', () => {
    const inspection = inspectProviderPage(
      page('https://chatgpt.com/', [], { readyState: 'loading', visibilityState: 'hidden' }),
      'chatgpt',
    );
    expect(inspection).toMatchObject({ ok: true, report: { documentState: 'loading', visibility: 'hidden' } });
  });

  it('treats unknown document states as loading and invalid selectors as no match', () => {
    const throwing = page('https://claude.ai/new', [], {
      readyState: 'prerender',
      hasElement: () => {
        throw new SyntaxError('Invalid selector');
      },
    });
    expect(inspectProviderPage(throwing, 'claude')).toMatchObject({
      ok: true,
      report: { documentState: 'loading', composer: 'absent' },
    });
  });

  it('classifies other provider pages as such, never as conversations', () => {
    expect(inspectProviderPage(page('https://chatgpt.com/gpts', [CHATGPT_COMPOSER]), 'chatgpt')).toMatchObject({
      ok: true,
      report: { page: { kind: 'provider-page' } },
    });
  });

  it('refuses pages of the other provider and pages on unsupported origins', () => {
    expect(inspectProviderPage(page(`https://claude.ai/chat/${ID}`), 'chatgpt')).toEqual({
      ok: false,
      reason: 'wrong-provider',
    });
    expect(inspectProviderPage(page(`https://chatgpt.com.example.net/c/${ID}`), 'chatgpt')).toEqual({
      ok: false,
      reason: 'unsupported-page',
    });
    expect(inspectProviderPage(page('http://claude.ai/new'), 'claude')).toEqual({
      ok: false,
      reason: 'unsupported-page',
    });
  });
});

describe('readiness summary', () => {
  const base: ProviderPageReport = {
    provider: 'claude',
    page: { kind: 'new-chat' },
    documentState: 'complete',
    visibility: 'visible',
    composer: 'present',
  };

  it.each<[Partial<ProviderPageReport>, ReturnType<typeof providerPageReadiness>]>([
    [{}, 'ready'],
    [{ documentState: 'interactive' }, 'ready'],
    // Visibility is reported separately; a background tab can still be ready.
    [{ visibility: 'hidden' }, 'ready'],
    [{ documentState: 'loading' }, 'loading'],
    [{ composer: 'absent' }, 'composer-missing'],
    [{ page: { kind: 'provider-page' }, composer: 'present' }, 'not-a-chat-page'],
  ])('%o is %s', (overrides, expected) => {
    expect(providerPageReadiness({ ...base, ...overrides })).toBe(expected);
  });
});

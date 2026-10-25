import { describe, expect, it } from 'vitest';
// Already supplied by WXT's dependency tree; no additional test package needed.
import { parseHTML } from 'linkedom';
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

/** Synthetic fixtures exercise real CSS matching without inspecting a live page. */
function chatgptFixture(markup: string): PageEnvironment {
  const { document } = parseHTML(`<html><body>${markup}</body></html>`);
  return page('https://chatgpt.com/', [], {
    hasElement: (selector) => document.querySelector(selector) !== null,
  });
}

describe('provider-specific readiness detection', () => {
  it.each([
    '<form data-chatgpt-composer=""><div><div contenteditable="true" role="textbox" class="ProseMirror" aria-label="Chiedi a ChatGPT"></div></div></form>',
    '<form data-chatgpt-composer=""><div><div contenteditable="true" role="textbox"></div></div></form>',
  ])('detects the observed ChatGPT composer without requiring a class or localized label: %s', (markup) => {
    expect(inspectProviderPage(chatgptFixture(markup), 'chatgpt')).toMatchObject({
      ok: true,
      report: { page: { kind: 'new-chat' }, composer: 'present' },
    });
  });

  it.each([
    '<textarea id="prompt-textarea"></textarea>',
    '<div id="prompt-textarea" contenteditable="true" role="textbox"></div>',
    '<main><form data-type="unified-composer"><textarea name="prompt-textarea"></textarea></form></main>',
    '<main><form data-type="unified-composer"><div role="textbox" contenteditable="true"></div></form></main>',
    '<main><form data-type="unified-composer"><div data-lexical-editor="true" contenteditable="true"></div></form></main>',
  ])('detects a ChatGPT composer variant: %s', (markup) => {
    const inspection = inspectProviderPage(chatgptFixture(markup), 'chatgpt');
    expect(inspection).toMatchObject({ ok: true, report: { composer: 'present' } });
    if (inspection.ok) expect(providerPageReadiness(inspection.report)).toBe('ready');
  });

  it.each([
    '',
    '<form><div contenteditable="true" role="textbox" class="ProseMirror" aria-label="Chiedi a ChatGPT"></div></form>',
    '<form data-chatgpt-composer=""></form><aside><div contenteditable="true" role="textbox"></div></aside>',
    '<form data-chatgpt-composer=""><div contenteditable="false" role="textbox"></div><div contenteditable="true" role="searchbox"></div></form>',
    '<main><form role="search"><input role="searchbox"><textarea name="search"></textarea><div role="textbox" contenteditable="true"></div></form></main>',
    '<aside><form data-type="unified-composer"><textarea name="prompt-textarea"></textarea><div role="textbox" contenteditable="true"></div></form></aside>',
    '<main><div role="textbox" contenteditable="true"></div><div data-lexical-editor="true" contenteditable="true"></div></main>',
    '<main><form data-type="unified-composer"><input role="searchbox"><textarea name="search"></textarea><div role="textbox" contenteditable="false"></div><div data-lexical-editor="true" contenteditable="false"></div></form></main>',
  ])('keeps a completed page with misleading controls composer-missing: %s', (markup) => {
    const inspection = inspectProviderPage(chatgptFixture(markup), 'chatgpt');
    expect(inspection).toMatchObject({ ok: true, report: { documentState: 'complete', composer: 'absent' } });
    if (inspection.ok) expect(providerPageReadiness(inspection.report)).toBe('composer-missing');
  });

  it('refuses unsupported origins before querying any elements', () => {
    let queries = 0;
    expect(inspectProviderPage(page('https://chatgpt.com.example.net/', [], {
      hasElement: () => { queries += 1; return true; },
    }), 'chatgpt')).toEqual({ ok: false, reason: 'unsupported-page' });
    expect(queries).toBe(0);
  });

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

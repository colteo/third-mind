import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { DebateSession } from '../../domain';
import { WITH_ISSUES, settle, startedSession, step, at } from '../../test-support/fixtures';
import { Results, ResultsView, hasResults, nextResultView, type ResultView } from './Results';

/**
 * Result view tests. They render with react-dom/server (no DOM, no extra
 * dependency) from a session built by the pure engine, so they do not depend
 * on debate orchestration.
 */

function completedSession(): DebateSession {
  return settle(startedSession(), () => WITH_ISSUES);
}

function render(session: DebateSession, view: ResultView): string {
  return renderToStaticMarkup(createElement(ResultsView, { session, view, onViewChange: () => undefined }));
}

function openingTag(html: string, element: 'div' | 'button', idSuffix: string): string {
  const match = new RegExp(`<${element}[^>]*id="[^"]*-${idSuffix}"[^>]*>`).exec(html);
  if (match === null) throw new Error(`No <${element}> with id ending in -${idSuffix}`);
  return match[0];
}

/**
 * Text content of a tab panel: everything after its opening tag up to the
 * opening tag of the next panel (or the end). The search starts after the
 * panel's own opening tag so its own role="tabpanel" is not taken as the end.
 */
function panelText(html: string, view: ResultView): string {
  const tag = openingTag(html, 'div', `panel-${view}`);
  const rest = html.slice(html.indexOf(tag) + tag.length);
  const next = /<div[^>]*role="tabpanel"/.exec(rest);
  return (next === null ? rest : rest.slice(0, next.index)).replace(/<[^>]+>/g, ' ');
}

const isHidden = (html: string, view: ResultView) => / hidden=""/.test(openingTag(html, 'div', `panel-${view}`));
const isSelected = (html: string, view: ResultView) =>
  openingTag(html, 'button', `tab-${view}`).includes('aria-selected="true"');

describe('result views', () => {
  it('shows only the structured report when it is selected', () => {
    const html = render(completedSession(), 'report');
    expect(isSelected(html, 'report')).toBe(true);
    expect(isSelected(html, 'summary')).toBe(false);
    expect(isHidden(html, 'report')).toBe(false);
    expect(isHidden(html, 'summary')).toBe(true);
  });

  it('shows only the conversational summary when it is selected', () => {
    const html = render(completedSession(), 'summary');
    expect(isSelected(html, 'summary')).toBe(true);
    expect(isSelected(html, 'report')).toBe(false);
    expect(isHidden(html, 'summary')).toBe(false);
    expect(isHidden(html, 'report')).toBe(true);
  });

  it('presents the same completed debate in both views, including unresolved disagreements', () => {
    const session = completedSession();
    const report = panelText(render(session, 'report'), 'report');
    const summary = panelText(render(session, 'summary'), 'summary');

    for (const text of [report, summary]) {
      expect(text).toContain('maximum of 4 rounds');
      expect(text).toContain('An issue remains.');
      expect(text).toContain('GPT Simulator');
      expect(text).toContain('Claude Simulator');
    }
    expect(report).toContain('Disagreements');
    // Each panel's text stops at the next panel: the report must not pick up the summary's prose.
    expect(report).not.toContain('still considers this a material issue');
    expect(summary).toContain('over 4 rounds');
    expect(summary).toContain('still considers this a material issue');
  });

  it('opens on the structured report by default', () => {
    const html = renderToStaticMarkup(createElement(Results, { session: completedSession() }));
    expect(isSelected(html, 'report')).toBe(true);
    expect(isHidden(html, 'summary')).toBe(true);
  });

  it('supports keyboard navigation between the two views', () => {
    expect(nextResultView('report', 'ArrowRight')).toBe('summary');
    expect(nextResultView('summary', 'ArrowRight')).toBe('report');
    expect(nextResultView('report', 'ArrowLeft')).toBe('summary');
    expect(nextResultView('summary', 'Home')).toBe('report');
    expect(nextResultView('report', 'End')).toBe('summary');
    expect(nextResultView('report', 'Enter')).toBeNull();
  });

  it('are offered only once the debate has ended, never as an empty result while it runs', () => {
    const running = step(step(startedSession(), at(2)).state, at(3)).state;
    expect(hasResults(running)).toBe(false);
    expect(hasResults({ ...running, status: { kind: 'paused', reason: 'human-request' } })).toBe(false);
    expect(hasResults(completedSession())).toBe(true);
    expect(
      hasResults({ ...running, status: { kind: 'failed', operationId: 'op', participantId: 'gpt', error: 'x' } }),
    ).toBe(true);
  });
});

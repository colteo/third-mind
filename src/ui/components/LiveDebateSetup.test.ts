import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { LivePreflightResult, PreflightTarget, ProviderCapabilities, ProviderPreflight } from '../../application';
import type { ConversationProviderId } from '../../domain';
import { Header } from './Header';
import { LiveDebateSetup, liveStartState, targetDescription } from './LiveDebateSetup';

/** Static render tests (no DOM), like Results.test.ts. */

const available = { status: 'available' } as const;

function provider(
  id: ConversationProviderId,
  capabilities: Partial<ProviderCapabilities> = {},
  target: PreflightTarget | null = { kind: 'conversation', conversationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
): ProviderPreflight {
  const all: ProviderCapabilities = {
    connection: available,
    transport: available,
    submission: available,
    responseAcquisition: available,
    authorization: available,
    ...capabilities,
  };
  const issues = Object.values(all).flatMap((check) => (check.status === 'unavailable' ? [check.issue] : []));
  return {
    provider: id,
    route: { id: `r-${id}`, label: `Route ${id}` },
    capabilities: all,
    technicallyReady: issues.every((issue) => issue.capability === 'authorization'),
    authorized: all.authorization.status === 'available',
    ready: issues.length === 0,
    target,
    binding: null,
    issues,
  };
}

function result(providers: ProviderPreflight[]): LivePreflightResult {
  return {
    checkedAt: '2000-01-01T00:00:00.000Z',
    ready: providers.every((p) => p.ready),
    revisions: { chatgpt: 1, claude: 1 },
    providers,
    issues: providers.flatMap((p) => p.issues),
  };
}

const notAuthorized = provider('chatgpt', {
  submission: {
    status: 'unavailable',
    issue: { provider: 'chatgpt', capability: 'submission', code: 'submission-unavailable', message: 'Submission is not implemented.' },
  },
  authorization: {
    status: 'unavailable',
    issue: { provider: 'chatgpt', capability: 'authorization', code: 'automation-not-authorized', message: 'No authorized route.' },
  },
});

function render(readiness: LivePreflightResult | null, revisions = { chatgpt: 1, claude: 1 }): string {
  return renderToStaticMarkup(
    createElement(LiveDebateSetup, {
      readiness,
      currentRevisions: revisions,
      onCheck: () => undefined,
      onStart: () => undefined,
    }),
  );
}

function text(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
}

describe('live debate setup', () => {
  it('shows no Start Live Debate control and explains every missing capability', () => {
    const html = render(result([notAuthorized, provider('claude')]));
    expect(html).not.toContain('Start Live Debate');
    expect(html).not.toContain('<form');
    const plain = text(html);
    expect(plain).toContain('A live debate cannot start:');
    expect(plain).toContain('ChatGPT, message submission: Submission is not implemented.');
    expect(plain).toContain('ChatGPT, authorized automation route: No authorized route.');
    expect(plain).toContain('Technical readiness: no · Authorization: no');
    expect(plain).toContain('Simulation mode stays available');
  });

  it('shows the control only when both providers are ready for the links shown', () => {
    const ready = result([provider('chatgpt'), provider('claude')]);
    expect(render(ready)).toContain('Start Live Debate');
    // A result for older link revisions is not acted on: the panel asks again instead.
    const stale = render(ready, { chatgpt: 2, claude: 1 });
    expect(stale).not.toContain('Start Live Debate');
    expect(text(stale)).toContain('Checking live readiness');
  });

  it('shows new-chat readiness distinctly from saved-conversation readiness', () => {
    const html = render(result([provider('chatgpt', {}, { kind: 'new-chat' }), provider('claude')]));
    expect(html).toContain('Start Live Debate');
    const plain = text(html);
    expect(plain).toContain('ChatGPT Ready: new chat');
    expect(plain).toContain('Claude Ready: saved conversation');
    expect(plain).toContain('Target: new chat (the debate');
    expect(plain).toContain('Target: saved conversation aaaaaaaa…');
    // No instruction to link a saved conversation first.
    expect(plain).not.toMatch(/must link a saved conversation/i);
    expect(plain).toContain('Each target can be a saved conversation or a new chat');
  });

  it('keeps honest capability failures for a new chat', () => {
    const blockedNewChat = provider(
      'claude',
      {
        responseAcquisition: {
          status: 'unavailable',
          issue: { provider: 'claude', capability: 'responseAcquisition', code: 'response-unavailable', message: 'Responses cannot be read.' },
        },
        authorization: {
          status: 'unavailable',
          issue: { provider: 'claude', capability: 'authorization', code: 'automation-not-authorized', message: 'No authorized route.' },
        },
      },
      { kind: 'new-chat' },
    );
    const plain = text(render(result([provider('chatgpt'), blockedNewChat])));
    expect(plain).toContain('Claude Not ready');
    expect(plain).toContain('Claude, response acquisition: Responses cannot be read.');
    expect(plain).toContain('Claude, authorized automation route: No authorized route.');
    expect(plain).not.toContain('Start Live Debate');
  });

  it('describes targets', () => {
    expect(targetDescription(null)).toBe('none available');
    expect(targetDescription({ kind: 'new-chat' })).toMatch(/^new chat/);
    expect(targetDescription({ kind: 'conversation', conversationId: 'abc' })).toBe('saved conversation abc');
  });

  it('derives the start state', () => {
    expect(liveStartState(null, { chatgpt: 0, claude: 0 })).toBe('checking');
    expect(liveStartState(result([provider('chatgpt'), provider('claude')]), null)).toBe('checking');
    expect(liveStartState(result([notAuthorized, provider('claude')]), { chatgpt: 1, claude: 1 })).toBe('blocked');
    expect(liveStartState(result([provider('chatgpt'), provider('claude')]), { chatgpt: 1, claude: 1 })).toBe('ready');
  });

  it('labels the execution mode in the header', () => {
    const live = renderToStaticMarkup(createElement(Header, { status: null, connection: 'connected', mode: 'live' }));
    expect(live).toContain('Live mode');
    const simulation = renderToStaticMarkup(
      createElement(Header, { status: null, connection: 'connected', mode: 'simulation' }),
    );
    expect(simulation).toContain('Simulation mode');
  });
});

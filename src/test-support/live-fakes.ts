/**
 * Deterministic fakes for live debate tests: a link registry, a page
 * transport and a live provider adapter. Test-only code; excluded from
 * coverage. Nothing here talks to a real provider, and passing tests that
 * use these fakes says nothing about the real ChatGPT or Claude websites.
 */
import type { ConnectionsSnapshot } from '../application';
import {
  EMPTY_CONNECTION_REGISTRY,
  type BrowserTabId,
  type ConnectionRegistry,
  type ConnectionState,
  type ConversationIdentity,
  type ConversationProviderId,
} from '../domain';
import type {
  AutomationAuthorization,
  LiveAdapterCapabilities,
  LiveConversationTarget,
  LiveFailure,
  LiveProviderAdapter,
  LiveSubmission,
  ProviderPageTransport,
  ProviderProbeResult,
  ResponseResult,
  SubmissionReceipt,
  SubmissionResult,
} from '../ports';

export const CHATGPT_CONVERSATION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const CLAUDE_CONVERSATION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const CHATGPT_TAB = 11;
export const CLAUDE_TAB = 22;

const ORIGINS: Readonly<Record<ConversationProviderId, string>> = {
  chatgpt: 'https://chatgpt.com',
  claude: 'https://claude.ai',
};

export interface FakeLinkOptions {
  readonly tabId?: BrowserTabId;
  readonly identity?: ConversationIdentity;
  readonly state?: ConnectionState;
  readonly revision?: number;
}

export function savedIdentity(conversationId: string): ConversationIdentity {
  return { kind: 'saved', conversationId, canonicalUrl: `https://example.invalid/${conversationId}`, source: 'selected' };
}

/** Mutable link registry with the coordinator's `refresh`/`getSnapshot` surface. */
export function createFakeConnections() {
  let registry: ConnectionRegistry = EMPTY_CONNECTION_REGISTRY;
  let discovery: ConnectionsSnapshot['discovery'] = { status: 'ready', tabs: [], unavailableTabCount: 0 };
  let refreshes = 0;
  const api = {
    refresh: () => {
      refreshes += 1;
      return Promise.resolve();
    },
    getSnapshot: (): ConnectionsSnapshot => ({ registry, discovery }),
    get refreshCount() {
      return refreshes;
    },
    link(provider: ConversationProviderId, options: FakeLinkOptions = {}) {
      const current = registry[provider];
      const conversationId = provider === 'chatgpt' ? CHATGPT_CONVERSATION : CLAUDE_CONVERSATION;
      registry = {
        ...registry,
        [provider]: {
          revision: options.revision ?? current.revision + 1,
          link: {
            provider,
            origin: ORIGINS[provider],
            tabId: options.tabId ?? (provider === 'chatgpt' ? CHATGPT_TAB : CLAUDE_TAB),
            identity: options.identity ?? savedIdentity(conversationId),
            state: options.state ?? { kind: 'linked' },
          },
        },
      };
      return api;
    },
    unlink(provider: ConversationProviderId) {
      registry = { ...registry, [provider]: { revision: registry[provider].revision + 1, link: null } };
      return api;
    },
    failDiscovery() {
      discovery = { status: 'failed', reason: 'The open tabs could not be listed.' };
      return api;
    },
  };
  return api;
}

export type FakeConnections = ReturnType<typeof createFakeConnections>;

/** Both providers linked to their saved conversations. */
export function linkedConnections(): FakeConnections {
  return createFakeConnections().link('chatgpt').link('claude');
}

/** Page transport whose answer per tab can be changed between calls. */
export function createFakeTransport() {
  const pages = new Map<BrowserTabId, ProviderProbeResult>();
  let probes = 0;
  const ready = (
    tabId: BrowserTabId,
    provider: ConversationProviderId,
    conversationId: string,
    pageInstanceId: string,
  ): ProviderProbeResult => ({
    ok: true,
    status: {
      provider,
      page: { kind: 'conversation', conversationId },
      documentState: 'complete',
      visibility: 'visible',
      composer: 'present',
      tabId,
      pageInstanceId,
      readiness: 'ready',
    },
  });
  pages.set(CHATGPT_TAB, ready(CHATGPT_TAB, 'chatgpt', CHATGPT_CONVERSATION, 'page-chatgpt-1'));
  pages.set(CLAUDE_TAB, ready(CLAUDE_TAB, 'claude', CLAUDE_CONVERSATION, 'page-claude-1'));

  const transport: ProviderPageTransport & {
    set(tabId: BrowserTabId, result: ProviderProbeResult): void;
    reload(tabId: BrowserTabId, provider: ConversationProviderId, conversationId: string, pageInstanceId: string): void;
    readonly probeCount: number;
  } = {
    probe(tabId) {
      probes += 1;
      return Promise.resolve(
        pages.get(tabId) ?? { ok: false, failure: { kind: 'tab-closed', outcome: 'not-performed' } },
      );
    },
    set(tabId, result) {
      pages.set(tabId, result);
    },
    reload(tabId, provider, conversationId, pageInstanceId) {
      pages.set(tabId, ready(tabId, provider, conversationId, pageInstanceId));
    },
    get probeCount() {
      return probes;
    },
  };
  return transport;
}

export type FakeTransport = ReturnType<typeof createFakeTransport>;

export const ALL_CAPABILITIES: LiveAdapterCapabilities = {
  submission: { status: 'available' },
  responseAcquisition: { status: 'available' },
};

export const AUTHORIZED: AutomationAuthorization = {
  kind: 'authorized',
  basis: 'Test-only fake route. Not a real provider integration.',
};

/**
 * What the fake provider does with a submission:
 * - `{ answer }`: responds with this text;
 * - `{ submitFailure }` / `{ responseFailure }`: reports this failure at that step;
 * - `'hang'`: never responds (until aborted);
 * - `{ mismatch }`: responds, but for another conversation, page or submission.
 */
export type FakeBehavior =
  | { readonly answer: string }
  | { readonly submitFailure: LiveFailure }
  | { readonly responseFailure: LiveFailure }
  | 'hang'
  | { readonly mismatch: 'conversation' | 'page' | 'submission' | 'operation' };

export interface FakeAdapterOptions {
  readonly authorization?: AutomationAuthorization;
  readonly capabilities?: LiveAdapterCapabilities | (() => Promise<LiveAdapterCapabilities>);
  /** Decides the behaviour for each submission. Defaults to an answer that reports no material issues. */
  readonly behave?: (submission: LiveSubmission, index: number) => FakeBehavior;
  /** Called after a submission was accepted and before the response is produced. */
  readonly onSubmitted?: (submission: LiveSubmission) => void;
}

export function assessmentBlock(materialIssues: readonly string[] = []): string {
  return [
    '```thirdmind-assessment',
    JSON.stringify({ materialIssues, openQuestions: [], agreements: ['Shared ground'] }),
    '```',
  ].join('\n');
}

export function createFakeLiveAdapter(provider: ConversationProviderId, options: FakeAdapterOptions = {}) {
  const submissions: { readonly target: LiveConversationTarget; readonly submission: LiveSubmission }[] = [];
  const behaviours = new Map<string, FakeBehavior>();
  let capabilityQueries = 0;

  const adapter: LiveProviderAdapter = {
    provider,
    route: { id: `fake-${provider}`, label: `Fake ${provider} route` },
    authorization: options.authorization ?? AUTHORIZED,
    capabilities() {
      capabilityQueries += 1;
      const { capabilities = ALL_CAPABILITIES } = options;
      return typeof capabilities === 'function' ? capabilities() : Promise.resolve(capabilities);
    },
    submit(target, submission): Promise<SubmissionResult> {
      const behaviour =
        options.behave?.(submission, submissions.length) ??
        ({ answer: `Position of ${provider}.\n${assessmentBlock()}` } satisfies FakeBehavior);
      if (typeof behaviour === 'object' && 'submitFailure' in behaviour) {
        if (behaviour.submitFailure.outcome === 'unknown') {
          submissions.push({ target, submission });
        }
        return Promise.resolve({ ok: false, failure: behaviour.submitFailure });
      }
      submissions.push({ target, submission });
      const submissionId = `submission-${provider}-${submissions.length}`;
      behaviours.set(submissionId, behaviour);
      options.onSubmitted?.(submission);
      return Promise.resolve({
        ok: true,
        receipt: {
          operationId: submission.operationId,
          conversationId: target.conversationId,
          pageInstanceId: target.pageInstanceId,
          submissionId,
        },
      });
    },
    awaitResponse(_target, receipt: SubmissionReceipt, { signal }): Promise<ResponseResult> {
      const behaviour = behaviours.get(receipt.submissionId);
      if (behaviour === 'hang' || behaviour === undefined) {
        return new Promise((resolve) => {
          signal.addEventListener('abort', () => {
            resolve({ ok: false, failure: { kind: 'timeout', outcome: 'unknown', message: 'Aborted.' } });
          });
        });
      }
      if ('responseFailure' in behaviour) {
        return Promise.resolve({ ok: false, failure: behaviour.responseFailure });
      }
      if ('submitFailure' in behaviour) {
        return Promise.resolve({ ok: false, failure: behaviour.submitFailure });
      }
      const response = { ...receipt, content: 'answer' in behaviour ? behaviour.answer : `Late answer.\n${assessmentBlock()}` };
      if ('mismatch' in behaviour) {
        switch (behaviour.mismatch) {
          case 'conversation':
            return Promise.resolve({ ok: true, response: { ...response, conversationId: 'another-conversation' } });
          case 'page':
            return Promise.resolve({ ok: true, response: { ...response, pageInstanceId: 'previous-page' } });
          case 'submission':
            return Promise.resolve({ ok: true, response: { ...response, submissionId: 'another-submission' } });
          case 'operation':
            return Promise.resolve({ ok: true, response: { ...response, operationId: 'another-operation' } });
        }
      }
      return Promise.resolve({ ok: true, response });
    },
  };

  return {
    adapter,
    submissions,
    get capabilityQueries() {
      return capabilityQueries;
    },
  };
}

export type FakeLiveAdapter = ReturnType<typeof createFakeLiveAdapter>;

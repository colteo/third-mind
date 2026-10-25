/**
 * Live orchestration with deterministic fake adapters. These tests verify
 * ThirdMind's own logic (preflight gating, write-ahead dispatch, the new-chat
 * first-message lifecycle, uncertainty, recovery, stale-response rejection).
 * They do not, and cannot, show that any real provider website works: no real
 * provider is involved.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIGURATION,
  type ContributionRequest,
  type ConversationProviderId,
  type DebateSession,
} from '../domain';
import { createConsumerSiteAdapters } from '../infrastructure/live/consumer-site-adapters';
import { createMemoryCheckpointStore } from '../infrastructure/memory-checkpoint-store';
import { createMemoryLiveTargetStore } from '../infrastructure/memory-live-target-store';
import { createSimulatedProviders, type SimulationSetup } from '../infrastructure/simulator';
import type { DebateCheckpoint, LiveAdapterRegistry, LiveFailure, ProviderRegistry } from '../ports';
import { createTestClock, createTestIds } from '../test-support/fixtures';
import {
  CHATGPT_CONVERSATION,
  CHATGPT_TAB,
  CLAUDE_TAB,
  CREATED_CONVERSATIONS,
  ORIGINS,
  TABS,
  assessmentBlock,
  createFakeLiveAdapter,
  createFakeTransport,
  linkedConnections,
  newChatIdentity,
  type FakeAdapterOptions,
  type FakeConnections,
  type FakeTransport,
} from '../test-support/live-fakes';
import { createDebateRunner } from './debate-runner';
import { LIVE_PARTICIPANTS, type LiveDebateSetup, type NewChatBinding } from './execution-mode';
import { createLiveContributionProvider, createLiveProviders, createSubmissionLocks } from './live-contribution-provider';
import { prepareLiveStart, resolveLiveFirstMessage, verifyLiveContinuation } from './live-debate';
import { createLivePreflight } from './live-preflight';
import { ASSESSMENT_FENCE } from './live-response';
import { createLiveTargetTracker, type LiveTargetRecord, type NewChatObservation } from './live-target';

type TestSetup = LiveDebateSetup | ({ readonly mode: 'simulation' } & SimulationSetup);
type LiveStore = ReturnType<typeof createMemoryLiveTargetStore<LiveTargetRecord>>;

interface HarnessOptions {
  readonly chatgpt?: FakeAdapterOptions;
  readonly claude?: FakeAdapterOptions;
  readonly adapters?: LiveAdapterRegistry;
  readonly responseTimeoutMs?: number;
  readonly checkpoint?: DebateCheckpoint<TestSetup>;
  /** Providers linked to a new, empty chat instead of a saved conversation. */
  readonly newChats?: readonly ConversationProviderId[];
  /**
   * When a new chat receives a message, the fake provider moves its tab to the
   * created conversation on the same document, and the link records it, as the
   * real provider and connection coordinator do. Defaults to true.
   */
  readonly transition?: boolean;
  /** Carried over to simulate a service worker restart: the browser and session storage survive it. */
  readonly connections?: FakeConnections;
  readonly transport?: FakeTransport;
  readonly liveStore?: LiveStore;
}

/** The provider's tab moves from the new chat to the conversation the first message created. */
function moveToCreatedConversation(
  connections: FakeConnections,
  transport: FakeTransport,
  provider: ConversationProviderId,
  kind: 'saved' | 'unconfirmed' = 'saved',
  conversationId: string = CREATED_CONVERSATIONS[provider],
): void {
  if (connections.getSnapshot().registry[provider].link?.identity.kind !== 'pending') {
    return;
  }
  transport.navigateWithinDocument(TABS[provider], provider, conversationId);
  connections.link(provider, { identity: newChatIdentity(conversationId, kind) });
}

function harness(options: HarnessOptions = {}) {
  const newChats = options.newChats ?? [];
  const connections = options.connections ?? linkedConnections();
  const transport = options.transport ?? createFakeTransport();
  if (options.connections === undefined) {
    for (const provider of newChats) {
      connections.link(provider, { identity: { kind: 'pending' } });
      transport.showNewChat(TABS[provider], provider, `page-${provider}-new`);
    }
  }
  const withTransition = (provider: ConversationProviderId, base: FakeAdapterOptions = {}): FakeAdapterOptions => ({
    ...base,
    onSubmitted: (submission) => {
      base.onSubmitted?.(submission);
      if (options.transition ?? true) {
        moveToCreatedConversation(connections, transport, provider);
      }
    },
  });
  const chatgpt = createFakeLiveAdapter('chatgpt', withTransition('chatgpt', options.chatgpt));
  const claude = createFakeLiveAdapter('claude', withTransition('claude', options.claude));
  const adapters = options.adapters ?? { chatgpt: chatgpt.adapter, claude: claude.adapter };
  const clock = createTestClock();
  const preflight = createLivePreflight({ connections, transport, adapters, clock });
  const locks = createSubmissionLocks();
  const liveStore = options.liveStore ?? createMemoryLiveTargetStore<LiveTargetRecord>();
  const targets = createLiveTargetTracker(liveStore);
  const checkpoints = createMemoryCheckpointStore<TestSetup>();
  if (options.checkpoint !== undefined) {
    void checkpoints.save(options.checkpoint);
  }
  const created: TestSetup['mode'][] = [];
  const errors: unknown[] = [];
  const runner = createDebateRunner<TestSetup>({
    clock,
    ids: createTestIds(),
    checkpoints,
    createProviders: (setup): ProviderRegistry => {
      created.push(setup.mode);
      return setup.mode === 'simulation'
        ? createSimulatedProviders(setup.scenario, { gptDelayMs: 0, claudeDelayMs: 0 })
        : createLiveProviders(setup, {
            adapters,
            verifyTarget: (binding) => preflight.verifyTarget(binding),
            observeNewChat: (binding) => preflight.observeNewChat(binding),
            targets,
            locks,
            ...(options.responseTimeoutMs === undefined ? {} : { responseTimeoutMs: options.responseTimeoutMs }),
          });
    },
    reportError: (error) => errors.push(error),
  });

  const startLive = async () => {
    const readiness = await preflight.run();
    const gate = await prepareLiveStart(preflight, readiness.revisions);
    if (!gate.ok) {
      return gate;
    }
    return runner.start({
      topic: 'Should the team adopt trunk-based development?',
      constraints: ['Keep releases weekly'],
      participants: LIVE_PARTICIPANTS,
      configuration: DEFAULT_CONFIGURATION,
      setup: gate.setup,
    });
  };

  const liveSetup = (): LiveDebateSetup => {
    const { setup } = runner.getSnapshot();
    if (setup?.mode !== 'live') throw new Error('Expected a live setup');
    return setup;
  };

  const continuation = () => verifyLiveContinuation(preflight, targets, sessionOf(runner).id, liveSetup());

  return {
    runner,
    preflight,
    connections,
    transport,
    chatgpt,
    claude,
    checkpoints,
    liveStore,
    targets,
    created,
    errors,
    startLive,
    liveSetup,
    continuation,
  };
}

type Harness = ReturnType<typeof harness>;

function sessionOf(runner: { getSnapshot(): { session: DebateSession | null } }): DebateSession {
  const { session } = runner.getSnapshot();
  if (session === null) throw new Error('Expected a session');
  return session;
}

function operationOf(h: Harness, participantId: 'gpt' | 'claude') {
  const operation = sessionOf(h.runner).operations.find((candidate) => candidate.participantId === participantId);
  if (operation === undefined) throw new Error(`No operation for ${participantId}`);
  return operation;
}

function storedState(h: Harness, provider: ConversationProviderId) {
  return h.liveStore.peek()?.targets[provider];
}

const withIssues = (text: string) => `${text}\n${assessmentBlock(['An issue remains.'])}`;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function request(overrides: Partial<ContributionRequest> = {}): ContributionRequest {
  return {
    operationId: 'session-1:round-1:gpt:attempt-1',
    sessionId: 'session-1',
    participantId: 'gpt',
    round: 1,
    maximumRounds: 4,
    phase: 'independent-analysis',
    topic: 'T',
    constraints: [],
    priorContributions: [],
    instructions: 'I',
    prompt: 'Prompt',
    ...overrides,
  };
}

describe('live debate orchestration (fake adapters)', () => {
  it('runs a complete multi-round live debate without any manual step', async () => {
    const behave = (_s: unknown, index: number) =>
      index < 3 ? { answer: withIssues(`Round ${index + 1} view.`) } : { answer: `Final view.\n${assessmentBlock()}` };
    const h = harness({ chatgpt: { behave }, claude: { behave } });

    expect(await h.startLive()).toEqual({ ok: true });
    await h.runner.whenIdle();

    const session = sessionOf(h.runner);
    expect(session.status).toEqual({ kind: 'completed', reason: 'maximum-rounds-reached', finalRound: 4 });
    expect(session.contributions).toHaveLength(8);
    expect(session.contributions.every((contribution) => contribution.origin === 'live')).toBe(true);
    // The assessment block is parsed and removed from the stored content.
    expect(session.contributions.every((contribution) => !contribution.content.includes(ASSESSMENT_FENCE))).toBe(true);
    expect(session.contributions.at(-1)?.assessment.materialIssues).toEqual([]);
    // Exactly one submission per operation, each carrying its operation id and the assessment format.
    expect(h.chatgpt.submissions).toHaveLength(4);
    expect(h.claude.submissions).toHaveLength(4);
    const operationIds = session.operations.map((operation) => operation.id);
    expect(h.chatgpt.submissions.map((s) => s.submission.operationId).every((id) => operationIds.includes(id))).toBe(true);
    expect(h.chatgpt.submissions.every((s) => s.submission.text.includes(ASSESSMENT_FENCE))).toBe(true);
    expect(
      h.chatgpt.submissions.every((s) => s.target.kind === 'conversation' && s.target.conversationId === CHATGPT_CONVERSATION),
    ).toBe(true);
    // A saved conversation never needs a target record.
    expect(h.liveStore.peek()).toBeNull();
    expect(h.created).toEqual(['live']);
    expect(h.errors).toEqual([]);
  });

  it('keeps simulation fully operational on the same runner', async () => {
    const h = harness();
    await h.runner.start({
      topic: 'Simulated topic',
      constraints: [],
      participants: LIVE_PARTICIPANTS,
      configuration: DEFAULT_CONFIGURATION,
      setup: { mode: 'simulation', scenario: 'early-convergence', pace: 'standard' },
    });
    await h.runner.whenIdle();
    const session = sessionOf(h.runner);
    expect(session.status).toMatchObject({ kind: 'completed', reason: 'early-convergence' });
    expect(session.contributions.every((contribution) => contribution.origin === 'simulated')).toBe(true);
    expect(h.chatgpt.submissions).toHaveLength(0);
  });

  it('does not start when preflight reports a missing capability', async () => {
    const h = harness();
    h.connections.unlink('claude');
    const result = await h.startLive();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('Nothing is linked for Claude');
    }
    expect(h.runner.getSnapshot().session).toBeNull();
    expect(h.chatgpt.submissions).toHaveLength(0);
    expect(h.created).toEqual([]);
  });

  it('rejects a start command from a stale side panel', async () => {
    const h = harness();
    const shown = await h.preflight.run();
    h.connections.link('chatgpt'); // The link changed after the panel showed it.
    const gate = await prepareLiveStart(h.preflight, shown.revisions);
    expect(gate.ok).toBe(false);
    if (!gate.ok) {
      expect(gate.reason).toContain('changed after this panel last showed it');
      expect(gate.preflight.issues.map((issue) => issue.code)).toEqual(['view-outdated']);
    }
  });

  it('never falls back to simulation when live adapters are unsupported', async () => {
    const h = harness({ adapters: createConsumerSiteAdapters() });
    const gate = await h.startLive();
    expect(gate.ok).toBe(false);

    // Even if a caller bypassed the preflight, no simulator is substituted: the runner refuses to start.
    const bypass = await h.runner.start({
      topic: 'T',
      constraints: [],
      participants: LIVE_PARTICIPANTS,
      configuration: DEFAULT_CONFIGURATION,
      setup: {
        mode: 'live',
        targets: {
          chatgpt: {
            kind: 'conversation',
            provider: 'chatgpt',
            tabId: CHATGPT_TAB,
            conversationId: CHATGPT_CONVERSATION,
            linkRevision: 1,
            source: 'linked',
          },
          claude: {
            kind: 'new-chat',
            provider: 'claude',
            tabId: CLAUDE_TAB,
            origin: ORIGINS.claude,
            pageInstanceId: 'p',
            linkRevision: 1,
          },
        },
      },
    });
    expect(bypass).toEqual({ ok: false, reason: 'No provider is registered for ChatGPT.' });
    expect(h.runner.getSnapshot().session).toBeNull();
    expect(h.created).toEqual(['live']);
  });

  it('keeps the shipped consumer-site adapters unavailable for linked new chats', async () => {
    const h = harness({ adapters: createConsumerSiteAdapters(), newChats: ['chatgpt', 'claude'] });
    const readiness = await h.preflight.run();
    for (const provider of readiness.providers) {
      // The new chat itself is a valid, reachable target...
      expect(provider.capabilities.connection.status).toBe('available');
      expect(provider.capabilities.transport.status).toBe('available');
      expect(provider.target).toEqual({ kind: 'new-chat' });
      // ...but nothing can be submitted to it, read from it, or automated there.
      expect(provider.issues.map((issue) => issue.code)).toEqual([
        'submission-unavailable',
        'response-unavailable',
        'automation-not-authorized',
      ]);
    }
    const gate = await h.startLive();
    expect(gate.ok).toBe(false);
    expect(h.runner.getSnapshot().session).toBeNull();
  });

  it('stops the debate when a provider certainly failed', async () => {
    const h = harness({
      claude: {
        behave: (_s, index) =>
          index === 0
            ? { answer: withIssues('First.') }
            : { submitFailure: { kind: 'provider-error', outcome: 'not-performed', message: 'The provider refused the message.' } },
      },
      chatgpt: { behave: () => ({ answer: withIssues('View.') }) },
    });
    await h.startLive();
    await h.runner.whenIdle();
    const { status } = sessionOf(h.runner);
    expect(status).toMatchObject({ kind: 'failed', participantId: 'claude', error: 'Claude: The provider refused the message.' });
  });

  it('treats a response timeout as uncertain, never retries it, and re-issues only on explicit approval', async () => {
    let hang = true;
    const h = harness({
      responseTimeoutMs: 10,
      chatgpt: { behave: () => (hang ? 'hang' : { answer: withIssues('Recovered.') }) },
      claude: { behave: () => ({ answer: withIssues('View.') }) },
    });
    await h.startLive();
    await h.runner.whenIdle();

    let session = sessionOf(h.runner);
    const gpt = operationOf(h, 'gpt');
    expect(gpt).toMatchObject({ status: 'uncertain', cause: 'unknown-outcome' });
    expect(gpt.status === 'uncertain' && gpt.detail).toContain('may have been delivered');
    expect(session.status).toEqual({ kind: 'paused', reason: 'uncertain-outcome' });
    expect(h.chatgpt.submissions).toHaveLength(1);

    // Resuming is refused while the outcome is unknown; nothing is resent.
    expect((await h.runner.resume(session.id)).ok).toBe(false);
    await h.runner.whenIdle();
    expect(h.chatgpt.submissions).toHaveLength(1);

    // Explicit human approval, after a fresh continuation preflight.
    hang = false;
    expect((await h.continuation()).ok).toBe(true);
    expect(await h.runner.reissueUncertainOperation(gpt.id, session.id)).toEqual({ ok: true });
    expect(await h.runner.resume(session.id)).toEqual({ ok: true });
    await h.runner.whenIdle();
    session = sessionOf(h.runner);
    expect(h.chatgpt.submissions).toHaveLength(5);
    expect(h.chatgpt.submissions[1]?.submission.operationId).toMatch(/:gpt:attempt-2$/);
    expect(session.status.kind).toBe('completed');
  });

  it.each(['conversation', 'page', 'submission', 'operation'] as const)(
    'rejects a response that belongs to another %s',
    async (mismatch) => {
      const h = harness({
        chatgpt: { behave: () => ({ mismatch }) },
        claude: { behave: () => ({ answer: withIssues('View.') }) },
      });
      await h.startLive();
      await h.runner.whenIdle();
      const session = sessionOf(h.runner);
      expect(session.contributions.some((contribution) => contribution.participantId === 'gpt')).toBe(false);
      expect(operationOf(h, 'gpt').status).toBe('uncertain');
      expect(session.status).toEqual({ kind: 'paused', reason: 'uncertain-outcome' });
    },
  );

  it('discards a response when the tab navigated or reloaded while it was awaited', async () => {
    const h = harness({
      chatgpt: {
        behave: () => ({ answer: withIssues('Stale answer.') }),
        onSubmitted: () => {
          h.transport.reload(CHATGPT_TAB, 'chatgpt', CHATGPT_CONVERSATION, 'page-chatgpt-reloaded');
        },
      },
      claude: { behave: () => ({ answer: withIssues('View.') }) },
    });
    await h.startLive();
    await h.runner.whenIdle();
    const gpt = operationOf(h, 'gpt');
    expect(gpt).toMatchObject({ status: 'uncertain', cause: 'unknown-outcome' });
    expect(gpt.status === 'uncertain' && gpt.detail).toContain('tab changed');
  });

  it('records the dispatch before submitting and recovers after a service worker restart without resending', async () => {
    const first = harness({ responseTimeoutMs: 60_000, chatgpt: { behave: () => 'hang' }, claude: { behave: () => 'hang' } });
    await first.startLive();
    // Let both submissions happen; responses never arrive.
    await flush();
    const checkpoint = first.checkpoints.peek();
    expect(checkpoint?.session.operations.map((operation) => operation.status)).toEqual(['dispatched', 'dispatched']);
    expect(first.chatgpt.submissions).toHaveLength(1);
    // Stop the old runner's pending calls (its checkpoint has already been copied above).
    await first.runner.reset();

    // A new worker starts from the checkpoint; the old one is gone together with its in-flight calls.
    const second = harness({ checkpoint: checkpoint!, chatgpt: { behave: () => ({ answer: withIssues('x') }) } });
    await second.runner.initialize();
    await second.runner.whenIdle();
    const session = sessionOf(second.runner);
    expect(session.status).toEqual({ kind: 'paused', reason: 'runtime-restart' });
    expect(session.operations.every((operation) => operation.status === 'uncertain' && operation.cause === 'runtime-restart')).toBe(true);
    expect(second.created).toEqual(['live']);
    expect(second.chatgpt.submissions).toHaveLength(0);
    expect(second.claude.submissions).toHaveLength(0);
    expect((await second.runner.resume(session.id)).ok).toBe(false);

    // Continuing requires the same conversations as before.
    second.connections.link('chatgpt', {
      identity: { kind: 'saved', conversationId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', canonicalUrl: 'x', source: 'selected' },
    });
    const gate = await second.continuation();
    expect(gate.ok).toBe(false);
    if (!gate.ok) {
      expect(gate.reason).toMatch(/^The live debate cannot continue: /);
    }
  });
});

describe('live debate in linked new chats (fake adapters)', () => {
  it.each<ConversationProviderId>(['chatgpt', 'claude'])(
    'starts in a new %s chat, binds the conversation its first message created, and continues there',
    async (provider) => {
      const behave = (_s: unknown, index: number) =>
        index < 1 ? { answer: withIssues('Opening view.') } : { answer: `Settled view.\n${assessmentBlock()}` };
      const h = harness({ newChats: [provider], chatgpt: { behave }, claude: { behave } });
      const readiness = await h.preflight.run();
      expect(readiness.providers.find((p) => p.provider === provider)?.target).toEqual({ kind: 'new-chat' });

      expect(await h.startLive()).toEqual({ ok: true });
      expect(h.liveSetup().targets[provider]).toEqual({
        kind: 'new-chat',
        provider,
        tabId: TABS[provider],
        origin: ORIGINS[provider],
        pageInstanceId: `page-${provider}-new`,
        linkRevision: 2,
      });
      await h.runner.whenIdle();

      const session = sessionOf(h.runner);
      expect(session.status.kind).toBe('completed');
      const fake = provider === 'chatgpt' ? h.chatgpt : h.claude;
      // Exactly one first message, aimed at the approved new-chat document.
      expect(fake.submissions[0]?.target).toEqual({
        kind: 'new-chat',
        provider,
        tabId: TABS[provider],
        origin: ORIGINS[provider],
        pageInstanceId: `page-${provider}-new`,
      });
      expect(fake.submissions.filter((s) => s.target.kind === 'new-chat')).toHaveLength(1);
      // Every later request goes to exactly the conversation the first message created.
      expect(fake.submissions.length).toBeGreaterThan(1);
      expect(
        fake.submissions
          .slice(1)
          .every((s) => s.target.kind === 'conversation' && s.target.conversationId === CREATED_CONVERSATIONS[provider]),
      ).toBe(true);
      expect(storedState(h, provider)).toEqual({
        kind: 'ready',
        binding: {
          kind: 'conversation',
          provider,
          tabId: TABS[provider],
          conversationId: CREATED_CONVERSATIONS[provider],
          linkRevision: 3,
          source: 'first-message',
        },
      });
      // The expected URL change of the first message is not treated as an unrelated navigation.
      expect(session.operations.some((operation) => operation.status === 'uncertain')).toBe(false);
      expect(h.errors).toEqual([]);
    },
  );

  it('binds from the first message even while the link still asks for confirmation, and continues there', async () => {
    const h = harness({
      newChats: ['chatgpt'],
      transition: false,
      chatgpt: {
        onSubmitted: () => {
          // Observation gap on the link side; the live correlation still holds.
          moveToCreatedConversation(h.connections, h.transport, 'chatgpt', 'unconfirmed');
        },
      },
    });
    await h.startLive();
    await h.runner.whenIdle();
    expect(sessionOf(h.runner).status.kind).toBe('completed');
    expect(storedState(h, 'chatgpt')).toMatchObject({ kind: 'ready', binding: { kind: 'conversation', source: 'first-message' } });
    expect(h.chatgpt.submissions.slice(1).every((s) => s.target.kind === 'conversation')).toBe(true);
  });

  it('persists the write-ahead record before the first message is submitted', async () => {
    const seen: unknown[] = [];
    const h = harness({
      newChats: ['claude'],
      claude: {
        onSubmitted: () => {
          seen.push(h.liveStore.peek()?.targets.claude);
        },
      },
    });
    await h.startLive();
    await h.runner.whenIdle();
    expect(seen[0]).toMatchObject({ kind: 'first-message', operationId: expect.stringMatching(/:claude:attempt-1$/) as unknown });
  });

  it('sends nothing when the write-ahead record cannot be written', async () => {
    const h = harness({ newChats: ['chatgpt'] });
    h.liveStore.failNextSave();
    await h.startLive();
    await h.runner.whenIdle();
    expect(h.chatgpt.submissions).toHaveLength(0);
    expect(sessionOf(h.runner).status).toMatchObject({ kind: 'failed', participantId: 'gpt' });
  });

  it('sends nothing to a new chat that was left before the first message (unexpected navigation)', async () => {
    const h = harness({ newChats: ['chatgpt'] });
    const readiness = await h.preflight.run();
    // The human opens an existing conversation in the linked tab after the check.
    h.transport.reload(CHATGPT_TAB, 'chatgpt', CHATGPT_CONVERSATION, 'page-other');
    h.connections.link('chatgpt', { identity: { kind: 'pending' }, state: { kind: 'stale', reason: 'different-conversation' } });
    const gate = await prepareLiveStart(h.preflight, readiness.revisions);
    expect(gate.ok).toBe(false);

    // A session that already started is stopped before anything is sent.
    const started = harness({ newChats: ['chatgpt'] });
    const shown = await started.preflight.run();
    const startGate = await prepareLiveStart(started.preflight, shown.revisions);
    if (!startGate.ok) throw new Error('Expected a ready start');
    started.transport.navigateWithinDocument(CHATGPT_TAB, 'chatgpt', CHATGPT_CONVERSATION);
    started.connections.link('chatgpt', { state: { kind: 'stale', reason: 'different-conversation' }, identity: { kind: 'pending' } });
    await started.runner.start({
      topic: 'T',
      constraints: [],
      participants: LIVE_PARTICIPANTS,
      configuration: DEFAULT_CONFIGURATION,
      setup: startGate.setup,
    });
    await started.runner.whenIdle();
    expect(started.chatgpt.submissions).toHaveLength(0);
    expect(operationOf(started, 'gpt').status).toBe('failed');
    expect(storedState(started, 'chatgpt')).toBeUndefined();
  });

  it('stops safely when the tab moves to an unrelated conversation during the first message', async () => {
    const h = harness({
      newChats: ['chatgpt'],
      transition: false,
      chatgpt: {
        onSubmitted: () => {
          // The coordinator saw that conversation open elsewhere before: an unrelated conversation.
          h.transport.navigateWithinDocument(CHATGPT_TAB, 'chatgpt', CHATGPT_CONVERSATION);
          h.connections.link('chatgpt', { identity: { kind: 'pending' }, state: { kind: 'stale', reason: 'different-conversation' } });
        },
      },
    });
    await h.startLive();
    await h.runner.whenIdle();
    const gpt = operationOf(h, 'gpt');
    expect(gpt).toMatchObject({ status: 'uncertain', cause: 'unknown-outcome' });
    expect(gpt.status === 'uncertain' && gpt.detail).toContain('unrelated page or conversation');
    expect(sessionOf(h.runner).contributions.some((c) => c.participantId === 'gpt')).toBe(false);
    expect(storedState(h, 'chatgpt')).toMatchObject({ kind: 'first-message' });
    const gate = await h.continuation();
    expect(gate.ok).toBe(false);
    expect(gate.preflight.issues.map((issue) => issue.code)).toContain('identity-unresolved');
  });

  it.each<[string, (h: Harness) => void, string]>([
    [
      'the adapter reports a different conversation than the tab shows',
      (h) => moveToCreatedConversation(h.connections, h.transport, 'chatgpt', 'saved', 'ffffffff-ffff-4fff-8fff-ffffffffffff'),
      'differs from the one the response belongs to',
    ],
    [
      'the tab loaded another document',
      (h) => {
        moveToCreatedConversation(h.connections, h.transport, 'chatgpt');
        h.transport.reload(CHATGPT_TAB, 'chatgpt', CREATED_CONVERSATIONS.chatgpt, 'page-chatgpt-reloaded');
      },
      'loaded another page',
    ],
    [
      'the tab was closed',
      (h) => {
        h.connections.link('chatgpt', { identity: { kind: 'pending' }, state: { kind: 'disconnected', reason: 'tab-closed' } });
        h.transport.set(CHATGPT_TAB, { ok: false, failure: { kind: 'tab-closed', outcome: 'not-performed' } });
      },
      'was closed',
    ],
    [
      'the page answers for another provider',
      (h) => {
        moveToCreatedConversation(h.connections, h.transport, 'chatgpt');
        h.transport.showNewChat(CHATGPT_TAB, 'claude', 'page-chatgpt-new');
      },
      'does not show a ChatGPT page',
    ],
    [
      'the tab still shows the new chat',
      () => undefined,
      'still shows the new chat',
    ],
  ])('leaves the first message unresolved when %s', async (_name, afterSubmit, detail) => {
    const h = harness({ newChats: ['chatgpt'], transition: false, chatgpt: { onSubmitted: () => afterSubmit(h) } });
    await h.startLive();
    await h.runner.whenIdle();
    const gpt = operationOf(h, 'gpt');
    expect(gpt).toMatchObject({ status: 'uncertain', cause: 'unknown-outcome' });
    expect(gpt.status === 'uncertain' && gpt.detail).toContain(detail);
    expect(sessionOf(h.runner).status).toEqual({ kind: 'paused', reason: 'uncertain-outcome' });
    expect(storedState(h, 'chatgpt')).toMatchObject({ kind: 'first-message' });
    expect(h.chatgpt.submissions).toHaveLength(1);
  });

  it('keeps an uncertain first submission uncertain and never sends a second first message', async () => {
    const uncertainFailure: LiveFailure = { kind: 'transport-error', outcome: 'unknown', message: 'The connection dropped.' };
    const h = harness({
      newChats: ['chatgpt'],
      transition: false,
      chatgpt: { behave: (_s, index) => (index === 0 ? { submitFailure: uncertainFailure } : { answer: withIssues('Again.') }) },
    });
    await h.startLive();
    await h.runner.whenIdle();
    const session = sessionOf(h.runner);
    const gpt = operationOf(h, 'gpt');
    expect(gpt).toMatchObject({ status: 'uncertain', cause: 'unknown-outcome' });
    expect(storedState(h, 'chatgpt')).toMatchObject({ kind: 'first-message', operationId: gpt.id });

    // The continuation gate refuses, and so does the provider itself if a re-issue bypassed the gate.
    const gate = await h.continuation();
    expect(gate.ok).toBe(false);
    expect(gate.preflight.issues.map((issue) => issue.code)).toEqual(['identity-unresolved']);
    expect(await h.runner.reissueUncertainOperation(gpt.id, session.id)).toEqual({ ok: true });
    expect(await h.runner.resume(session.id)).toEqual({ ok: true });
    await h.runner.whenIdle();
    expect(h.chatgpt.submissions).toHaveLength(1);
    const retried = sessionOf(h.runner).operations.find((operation) => operation.id.endsWith(':gpt:attempt-2'));
    expect(retried?.status).toBe('failed');
    expect(sessionOf(h.runner).status).toMatchObject({ kind: 'failed', participantId: 'gpt' });
    expect(storedState(h, 'chatgpt')).toMatchObject({ kind: 'first-message', operationId: gpt.id });
  });

  it('withdraws the write-ahead record when the first submission was certainly not performed', async () => {
    const refused: LiveFailure = { kind: 'provider-error', outcome: 'not-performed', message: 'The provider refused the message.' };
    const h = harness({ newChats: ['chatgpt'], chatgpt: { behave: () => ({ submitFailure: refused }) } });
    await h.startLive();
    await h.runner.whenIdle();
    expect(sessionOf(h.runner).status).toMatchObject({ kind: 'failed', participantId: 'gpt' });
    expect(storedState(h, 'chatgpt')).toMatchObject({ kind: 'ready', binding: { kind: 'new-chat' } });
  });

  it('does not re-submit the first message after a worker restart, and continues only after explicit recovery', async () => {
    const first = harness({
      newChats: ['chatgpt', 'claude'],
      transition: false,
      responseTimeoutMs: 60_000,
      chatgpt: { behave: () => 'hang' },
      claude: { behave: () => 'hang' },
    });
    await first.startLive();
    await flush();
    expect(first.chatgpt.submissions).toHaveLength(1);
    expect(first.claude.submissions).toHaveLength(1);
    const checkpoint = first.checkpoints.peek();
    expect(storedState(first, 'chatgpt')).toMatchObject({ kind: 'first-message' });
    expect(storedState(first, 'claude')).toMatchObject({ kind: 'first-message' });
    await first.runner.reset();

    // While the worker was gone, Claude saved the first message; the link could not attribute it (observation gap).
    moveToCreatedConversation(first.connections, first.transport, 'claude', 'unconfirmed');

    const second = harness({
      checkpoint: checkpoint!,
      connections: first.connections,
      transport: first.transport,
      liveStore: first.liveStore,
      chatgpt: { behave: () => ({ answer: `Done.\n${assessmentBlock()}` }) },
      claude: { behave: () => ({ answer: `Done.\n${assessmentBlock()}` }) },
    });
    await second.runner.initialize();
    await second.runner.whenIdle();
    const session = sessionOf(second.runner);
    expect(session.status).toEqual({ kind: 'paused', reason: 'runtime-restart' });
    expect(second.chatgpt.submissions).toHaveLength(0);
    expect(second.claude.submissions).toHaveLength(0);

    // Both first messages are unresolved: nothing may continue yet.
    const blocked = await second.continuation();
    expect(blocked.ok).toBe(false);
    expect(blocked.preflight.issues.map((issue) => issue.code)).toEqual(['identity-unresolved', 'identity-unresolved']);

    const resolve = (provider: ConversationProviderId, resolution: Parameters<typeof resolveLiveFirstMessage>[5]) =>
      resolveLiveFirstMessage(second.preflight, second.targets, session.id, second.liveSetup(), provider, resolution);
    // Wrong answers are refused against a fresh observation of the tab.
    expect((await resolve('chatgpt', { kind: 'bind-conversation', conversationId: CREATED_CONVERSATIONS.chatgpt })).ok).toBe(false);
    expect((await resolve('claude', { kind: 'keep-new-chat' })).ok).toBe(false);
    expect(
      (await resolve('claude', { kind: 'bind-conversation', conversationId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' })).ok,
    ).toBe(false);
    // The human's explicit decisions.
    expect(await resolve('chatgpt', { kind: 'keep-new-chat' })).toEqual({ ok: true });
    expect(await resolve('claude', { kind: 'bind-conversation', conversationId: CREATED_CONVERSATIONS.claude })).toEqual({ ok: true });
    expect(second.chatgpt.submissions).toHaveLength(0);
    expect(second.claude.submissions).toHaveLength(0);
    expect((await second.continuation()).ok).toBe(true);

    // Re-issuing remains an explicit, separate action.
    for (const operation of session.operations) {
      expect(await second.runner.reissueUncertainOperation(operation.id, session.id)).toEqual({ ok: true });
    }
    expect(await second.runner.resume(session.id)).toEqual({ ok: true });
    await second.runner.whenIdle();
    expect(second.chatgpt.submissions[0]?.target.kind).toBe('new-chat');
    expect(second.chatgpt.submissions[0]?.submission.operationId).toMatch(/:gpt:attempt-2$/);
    expect(second.claude.submissions[0]?.target).toMatchObject({
      kind: 'conversation',
      conversationId: CREATED_CONVERSATIONS.claude,
    });
    expect(second.claude.submissions.filter((s) => s.target.kind === 'new-chat')).toHaveLength(0);
    expect(storedState(second, 'claude')).toMatchObject({ kind: 'ready', binding: { source: 'recovered' } });
    expect(storedState(second, 'chatgpt')).toMatchObject({ kind: 'ready', binding: { source: 'first-message' } });
    expect(sessionOf(second.runner).status.kind).toBe('completed');
  });

  it('refuses to change a first message while it is still in progress', async () => {
    const h = harness({ newChats: ['chatgpt'], transition: false, responseTimeoutMs: 60_000, chatgpt: { behave: () => 'hang' } });
    await h.startLive();
    await flush();
    const result = await resolveLiveFirstMessage(h.preflight, h.targets, sessionOf(h.runner).id, h.liveSetup(), 'chatgpt', {
      kind: 'keep-new-chat',
    });
    expect(result).toEqual({ ok: false, reason: 'The first message is still in progress. Wait until it completes.' });
    await h.runner.reset();
  });
});

describe('live contribution provider', () => {
  const savedSetup: LiveDebateSetup = {
    mode: 'live',
    targets: {
      chatgpt: {
        kind: 'conversation',
        provider: 'chatgpt',
        tabId: CHATGPT_TAB,
        conversationId: CHATGPT_CONVERSATION,
        linkRevision: 1,
        source: 'linked',
      },
      claude: {
        kind: 'conversation',
        provider: 'claude',
        tabId: CLAUDE_TAB,
        conversationId: 'c',
        linkRevision: 1,
        source: 'linked',
      },
    },
  };
  const newChatBinding: NewChatBinding = {
    kind: 'new-chat',
    provider: 'chatgpt',
    tabId: CHATGPT_TAB,
    origin: ORIGINS.chatgpt,
    pageInstanceId: 'page-chatgpt-new',
    linkRevision: 1,
  };

  function provider(options: FakeAdapterOptions = {}, verify = true, setup: LiveDebateSetup = savedSetup) {
    const fake = createFakeLiveAdapter('chatgpt', options);
    const binding = setup.targets.chatgpt;
    const target =
      binding.kind === 'conversation'
        ? { kind: 'conversation' as const, provider: 'chatgpt' as const, tabId: CHATGPT_TAB, conversationId: binding.conversationId, pageInstanceId: 'page-chatgpt-1' }
        : { kind: 'new-chat' as const, provider: 'chatgpt' as const, tabId: CHATGPT_TAB, origin: binding.origin, pageInstanceId: binding.pageInstanceId };
    const observation: NewChatObservation = {
      kind: 'conversation',
      conversationId: CREATED_CONVERSATIONS.chatgpt,
      pageInstanceId: 'page-chatgpt-new',
      linkRevision: 2,
    };
    const liveStore = createMemoryLiveTargetStore<LiveTargetRecord>();
    const live = createLiveContributionProvider({
      participantId: 'gpt',
      adapter: fake.adapter,
      setup,
      verifyTarget: () =>
        Promise.resolve(
          verify
            ? { ok: true as const, target }
            : {
                ok: false as const,
                issue: { provider: 'chatgpt' as const, capability: 'connection' as const, code: 'link-stale' as const, message: 'The link is stale.' },
              },
        ),
      observeNewChat: () => Promise.resolve(observation),
      targets: createLiveTargetTracker(liveStore),
      locks: createSubmissionLocks(),
      responseTimeoutMs: 50,
    });
    return { live, fake, liveStore };
  }

  it('sends nothing when the target changed before submission', async () => {
    const { live, fake } = provider({}, false);
    const result = await live.requestContribution(request(), { signal: new AbortController().signal });
    expect(result).toEqual({ ok: false, error: { message: 'Nothing was sent to ChatGPT. The link is stale.' }, outcome: 'failed' });
    expect(fake.submissions).toHaveLength(0);
  });

  it('prevents concurrent submissions to the same conversation', async () => {
    const { live, fake } = provider({ behave: () => 'hang' });
    const controller = new AbortController();
    const first = live.requestContribution(request(), { signal: controller.signal });
    await flush();
    const second = await live.requestContribution(request({ operationId: 'other' }), { signal: new AbortController().signal });
    expect(second).toMatchObject({ ok: false, outcome: 'failed' });
    expect(second.ok === false && second.error.message).toContain('still in progress');
    expect(fake.submissions).toHaveLength(1);
    controller.abort();
    expect(await first).toMatchObject({ ok: false, outcome: 'unknown' });
    // The lock is released once the first call settled.
    const third = await live.requestContribution(request({ operationId: 'third' }), { signal: new AbortController().signal });
    expect(third.ok === false && third.error.message).not.toContain('still in progress');
  });

  it('never sends a second first message to a new chat, even concurrently', async () => {
    const setup: LiveDebateSetup = { ...savedSetup, targets: { ...savedSetup.targets, chatgpt: newChatBinding } };
    const { live, fake } = provider({ behave: () => 'hang' }, true, setup);
    const controller = new AbortController();
    const first = live.requestContribution(request(), { signal: controller.signal });
    await flush();
    const concurrent = await live.requestContribution(request({ operationId: 'other' }), { signal: new AbortController().signal });
    expect(concurrent).toMatchObject({ ok: false, outcome: 'failed' });
    controller.abort();
    expect(await first).toMatchObject({ ok: false, outcome: 'unknown' });
    // After the uncertain first message, nothing is sent until it is resolved.
    const later = await live.requestContribution(request({ operationId: 'later' }), { signal: new AbortController().signal });
    expect(later).toMatchObject({ ok: false, outcome: 'failed' });
    expect(later.ok === false && later.error.message).toContain('Resolve it before continuing');
    expect(fake.submissions).toHaveLength(1);
  });

  it('rejects a receipt for the wrong kind of target', async () => {
    const setup: LiveDebateSetup = { ...savedSetup, targets: { ...savedSetup.targets, chatgpt: newChatBinding } };
    const { live, fake } = provider({}, true, setup);
    const submit = fake.adapter.submit.bind(fake.adapter);
    // An adapter that claims the first message went to an existing conversation.
    fake.adapter.submit = async (target, submission, options) => {
      const result = await submit(target, submission, options);
      return result.ok
        ? { ok: true, receipt: { ...result.receipt, kind: 'conversation', conversationId: CHATGPT_CONVERSATION } }
        : result;
    };
    const result = await live.requestContribution(request(), { signal: new AbortController().signal });
    expect(result).toMatchObject({ ok: false, outcome: 'unknown' });
  });

  it('reports an uncertain submission as unknown, not as a failure', async () => {
    const { live } = provider({
      behave: () => ({ submitFailure: { kind: 'transport-error', outcome: 'unknown', message: 'The connection dropped.' } }),
    });
    const result = await live.requestContribution(request(), { signal: new AbortController().signal });
    expect(result).toEqual({ ok: false, error: { message: 'ChatGPT: The connection dropped.' }, outcome: 'unknown' });
  });

  it('refuses to act through an unauthorized route', async () => {
    const { live, fake } = provider({ authorization: { kind: 'not-authorized', reason: 'Not permitted.' } });
    const result = await live.requestContribution(request(), { signal: new AbortController().signal });
    expect(result).toEqual({ ok: false, error: { message: 'Not permitted.' }, outcome: 'failed' });
    expect(fake.submissions).toHaveLength(0);
  });

  it('records a missing structured assessment as a material issue, so it never ends the debate early', async () => {
    const { live } = provider({ behave: () => ({ answer: 'An answer without an assessment.' }) });
    const result = await live.requestContribution(request(), { signal: new AbortController().signal });
    expect(result).toMatchObject({ ok: true, content: 'An answer without an assessment.' });
    expect(result.ok && result.assessment.materialIssues).toHaveLength(1);
  });
});

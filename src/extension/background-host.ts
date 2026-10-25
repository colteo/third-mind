import { browser, type Browser } from 'wxt/browser';
import {
  LIVE_PARTICIPANTS,
  buildConnectionsView,
  createConnectionCoordinator,
  createDebateRunner,
  createLivePreflight,
  createLiveProviders,
  createLiveTargetTracker,
  createSubmissionLocks,
  prepareLiveStart,
  verifyLiveContinuation,
  type ConnectionCoordinator,
  type DebateRunner,
  type LivePreflight,
  type LivePreflightResult,
  type LiveTargetTracker,
  type RunnerResult,
} from '../application';
import { DEFAULT_CONFIGURATION } from '../domain';
import { createConsumerSiteAdapters } from '../infrastructure/live/consumer-site-adapters';
import { SIMULATION_PARTICIPANTS, createSimulatedProviders, delaysForPace } from '../infrastructure/simulator';
import { createConversationRecognizer } from '../infrastructure/conversation-urls';
import { createChromeTabSource, watchTabEvents } from './chrome-tabs';
import { parseDebateSetup, type DebateSetup } from './debate-setup';
import {
  SIDE_PANEL_PORT_NAME,
  isConnectionMessage,
  parseClientMessage,
  type ClientMessage,
  type ConnectionClientMessage,
  type HostMessage,
  type LiveClientMessage,
  type PageCheckClientMessage,
} from './protocol';
import { createProviderTransport, type ProviderTransport } from './provider-transport';
import { randomIds, systemClock } from './runtime-adapters';
import { createSessionCheckpointStore } from './session-checkpoint-store';
import { createSessionConnectionStore } from './session-connection-store';
import { createSessionLiveTargetStore } from './session-live-target-store';

type Port = Browser.runtime.Port;

/** What continuing a live session needs: the preflight and where each participant is bound now. */
interface LiveContinuation {
  readonly preflight: LivePreflight;
  readonly targets: LiveTargetTracker;
}

/**
 * Composition root for the background service worker.
 *
 * The debate lives here rather than in the side panel, so closing or
 * reloading the panel does not interrupt it. The service worker itself may be
 * terminated by Chrome at any time; the session is restored from the
 * checkpoint on the next start (see docs/architecture/runtime-and-recovery.md).
 *
 * It also hosts the conversation link coordinator (Phase 2.1; new chats with
 * pending identities, Phase 2.2A). Links are
 * independent of the debate: the debate runner never sees them, and they are
 * stored under a separate key. Tab events keep links current while the worker
 * runs; because events are lost while it is suspended, links are also
 * reconciled with the open tabs on every start and every panel connection.
 *
 * It also hosts the provider page transport (Phase 2.2B foundation), which
 * talks to the provider content scripts. The transport is independent of the
 * debate and of the link state: a page check never changes a link, and the
 * debate still uses the simulators. See docs/architecture/provider-transport.md.
 *
 * Live debates (live execution foundation) use the same runner. The session
 * setup records the execution mode, and `createProviders` builds simulators
 * for simulation sessions and live providers for live sessions, never one in
 * place of the other. Live providers reach ChatGPT and Claude only through the
 * live adapters registered here. The shipped adapters for the two websites
 * declare that no authorized automation route exists, so the live preflight
 * never reports ready and no live debate can start. See
 * docs/architecture/live-execution.md.
 *
 * All listeners are registered synchronously, as MV3 requires.
 */
export function startBackgroundHost(): void {
  const recognizer = createConversationRecognizer();
  const connections = createConnectionCoordinator({
    tabs: createChromeTabSource(browser.tabs),
    recognizer,
    store: createSessionConnectionStore(recognizer),
    reportError: (error) => {
      // Never include tab URLs or titles here; Chrome and storage errors do not contain them.
      console.error('[ThirdMind] Conversation links:', error);
    },
  });

  const transport = createProviderTransport({
    tabs: browser.tabs,
    extensionId: browser.runtime.id,
    recognizer,
    ids: randomIds,
  });

  // An authorized integration replaces these adapters; nothing else in this file changes.
  const liveAdapters = createConsumerSiteAdapters();
  const preflight = createLivePreflight({ connections, transport, adapters: liveAdapters, clock: systemClock });
  const submissionLocks = createSubmissionLocks();
  // Where each live participant is bound, including the write-ahead record of a new chat's first message.
  const liveTargets = createLiveTargetTracker(createSessionLiveTargetStore());
  const continuation: LiveContinuation = { preflight, targets: liveTargets };

  const runner = createDebateRunner<DebateSetup>({
    clock: systemClock,
    ids: randomIds,
    checkpoints: createSessionCheckpointStore(parseDebateSetup),
    createProviders: (setup) =>
      setup.mode === 'simulation'
        ? createSimulatedProviders(setup.scenario, delaysForPace(setup.pace))
        : createLiveProviders(setup, {
            adapters: liveAdapters,
            verifyTarget: (binding) => preflight.verifyTarget(binding),
            observeNewChat: (binding) => preflight.observeNewChat(binding),
            targets: liveTargets,
            locks: submissionLocks,
          }),
    reportError: (error) => {
      console.error('[ThirdMind]', error);
    },
  });

  const ports = new Set<Port>();
  const ready = runner.initialize().catch((error: unknown) => {
    console.error('[ThirdMind] Failed to restore the debate checkpoint.', error);
  });
  void connections.initialize().catch((error: unknown) => {
    console.error('[ThirdMind] Failed to restore conversation links.', error);
  });

  runner.subscribe(() => {
    const message = snapshotMessage(runner);
    for (const port of ports) {
      post(port, message);
    }
  });

  connections.subscribe(() => {
    const message = connectionsMessage(connections);
    for (const port of ports) {
      post(port, message);
    }
  });

  watchTabEvents(browser.tabs, {
    tabChanged: (tabId, url) => {
      transport.tabChanged(tabId, url);
      void connections.tabChanged(tabId, url);
    },
    tabRemoved: (tabId) => {
      transport.tabRemoved(tabId);
      void connections.tabRemoved(tabId);
    },
    rescan: () => void connections.refresh(),
  });

  // One-off messages come only from the provider content scripts (the panel uses its port). The transport
  // validates the sender of each one; nothing is ever answered, so a page learns nothing from sending.
  browser.runtime.onMessage.addListener((raw: unknown, sender) => {
    transport.receivePageMessage(raw, sender);
    return undefined;
  });

  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== SIDE_PANEL_PORT_NAME || port.sender?.id !== browser.runtime.id) {
      port.disconnect();
      return;
    }
    ports.add(port);
    port.onDisconnect.addListener(() => {
      ports.delete(port);
    });
    port.onMessage.addListener((raw: unknown) => {
      const message = parseClientMessage(raw);
      if (message === null) {
        post(port, { type: 'command-rejected', command: 'unknown', reason: 'The message was not understood.' });
      } else if (message.type === 'check-provider-page') {
        void handlePageCheck(connections, transport, ports, port, message);
      } else if (message.type === 'check-live-readiness' || message.type === 'start-live') {
        void ready.then(() => handleLiveMessage(runner, preflight, ports, port, message));
      } else if (isConnectionMessage(message)) {
        // The coordinator queues commands behind its own initialization.
        void handleConnectionMessage(connections, port, message);
      } else {
        void ready.then(() => handleMessage(runner, continuation, ports, port, message));
      }
    });
    void ready.then(() => {
      post(port, snapshotMessage(runner));
    });
    // Reconcile on every connection: tab events may have been missed while the worker was suspended.
    void connections.refresh().then(() => {
      post(port, connectionsMessage(connections));
    });
  });

  browser.runtime.onInstalled.addListener(() => {
    browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((error: unknown) => {
      console.error('[ThirdMind] Failed to configure the side panel behaviour.', error);
    });
  });
}

type DebateClientMessage = Exclude<ClientMessage, ConnectionClientMessage | PageCheckClientMessage | LiveClientMessage>;

/**
 * Checks the page connection of the provider's linked tab. The links are
 * reconciled first, so the tab is validated against a fresh tab scan, and the
 * transport validates it again before and after its request. The result is
 * diagnostic only: it never changes the link or the debate.
 */
async function handlePageCheck(
  connections: ConnectionCoordinator,
  transport: ProviderTransport,
  ports: ReadonlySet<Port>,
  port: Port,
  message: PageCheckClientMessage,
): Promise<void> {
  try {
    await connections.refresh();
    const link = connections.getSnapshot().registry[message.provider].link;
    if (link?.state.kind !== 'linked') {
      post(port, {
        type: 'command-rejected',
        command: message.type,
        reason: 'Only a linked tab that still shows its conversation or new chat can be checked.',
      });
      post(port, connectionsMessage(connections));
      return;
    }
    const result = await transport.probe(link.tabId, message.provider);
    const reply: HostMessage = { type: 'page-check', check: { provider: message.provider, tabId: link.tabId, result } };
    for (const target of ports) {
      post(target, reply);
    }
  } catch (error) {
    console.error('[ThirdMind] Page check:', error);
    post(port, {
      type: 'command-rejected',
      command: message.type,
      reason: 'An internal error occurred. See the service worker console for details.',
    });
  }
}

/**
 * Live preflight and live start. The preflight runs again for every start, against the link revisions the
 * panel displayed, and its result goes to every panel, so each one shows why a live debate can or cannot start.
 */
async function handleLiveMessage(
  runner: DebateRunner<DebateSetup>,
  preflight: LivePreflight,
  ports: ReadonlySet<Port>,
  port: Port,
  message: LiveClientMessage,
): Promise<void> {
  try {
    if (message.type === 'check-live-readiness') {
      broadcastReadiness(ports, await preflight.run());
      return;
    }
    const gate = await prepareLiveStart(preflight, message.expectedRevisions);
    broadcastReadiness(ports, gate.preflight);
    const result: RunnerResult = gate.ok
      ? await runner.start({
          topic: message.topic,
          constraints: message.constraints,
          participants: LIVE_PARTICIPANTS,
          configuration: DEFAULT_CONFIGURATION,
          setup: gate.setup,
        })
      : gate;
    if (!result.ok) {
      post(port, { type: 'command-rejected', command: message.type, reason: result.reason });
      post(port, snapshotMessage(runner));
    }
  } catch (error) {
    console.error('[ThirdMind] Live debate:', error);
    post(port, {
      type: 'command-rejected',
      command: message.type,
      reason: 'An internal error occurred. See the service worker console for details.',
    });
  }
}

function broadcastReadiness(ports: ReadonlySet<Port>, readiness: LivePreflightResult): void {
  const message: HostMessage = { type: 'live-readiness', readiness };
  for (const target of ports) {
    post(target, message);
  }
}

async function handleMessage(
  runner: DebateRunner<DebateSetup>,
  live: LiveContinuation,
  ports: ReadonlySet<Port>,
  port: Port,
  message: DebateClientMessage,
): Promise<void> {
  let result: RunnerResult;
  try {
    result = await dispatch(runner, live, ports, message);
  } catch (error) {
    console.error('[ThirdMind]', error);
    result = { ok: false, reason: 'An internal error occurred. See the service worker console for details.' };
  }
  if (!result.ok) {
    post(port, { type: 'command-rejected', command: message.type, reason: result.reason });
    // A rejected command usually means the panel acted on an outdated view; re-sync it.
    post(port, snapshotMessage(runner));
  }
}

async function dispatch(
  runner: DebateRunner<DebateSetup>,
  live: LiveContinuation,
  ports: ReadonlySet<Port>,
  message: DebateClientMessage,
): Promise<RunnerResult> {
  switch (message.type) {
    case 'start':
      return runner.start({
        topic: message.topic,
        constraints: message.constraints,
        participants: SIMULATION_PARTICIPANTS,
        configuration: DEFAULT_CONFIGURATION,
        setup: { mode: 'simulation', scenario: message.scenario, pace: message.pace },
      });
    case 'pause':
      return runner.pause(message.sessionId);
    case 'resume':
      return (await liveContinuationBlocked(runner, live, ports, message.sessionId)) ?? runner.resume(message.sessionId);
    case 'add-constraint':
      return runner.addConstraint(message.content, message.sessionId);
    case 'reissue-operation':
      return (
        (await liveContinuationBlocked(runner, live, ports, message.sessionId)) ??
        runner.reissueUncertainOperation(message.operationId, message.sessionId)
      );
    case 'reset':
      return runner.reset(message.sessionId);
  }
}

/**
 * A live session sends messages again when it resumes or re-issues an uncertain operation, so both need a
 * fresh preflight against where its participants are bound now: the saved conversation, the conversation
 * bound from a new chat's first message, or the approved new chat. An unresolved first message blocks both. Returns `null` when the action may proceed:
 * for every simulated session, and for a command aimed at another session (the runner rejects it itself).
 */
async function liveContinuationBlocked(
  runner: DebateRunner<DebateSetup>,
  live: LiveContinuation,
  ports: ReadonlySet<Port>,
  sessionId: string,
): Promise<RunnerResult | null> {
  const { session, setup } = runner.getSnapshot();
  if (setup?.mode !== 'live' || session?.id !== sessionId) {
    return null;
  }
  const gate = await verifyLiveContinuation(live.preflight, live.targets, session.id, setup);
  broadcastReadiness(ports, gate.preflight);
  return gate.ok ? null : gate;
}

async function handleConnectionMessage(
  connections: ConnectionCoordinator,
  port: Port,
  message: ConnectionClientMessage,
): Promise<void> {
  let result: RunnerResult;
  try {
    result = await dispatchConnection(connections, message);
  } catch (error) {
    console.error('[ThirdMind] Conversation links:', error);
    result = { ok: false, reason: 'An internal error occurred. See the service worker console for details.' };
  }
  if (!result.ok) {
    post(port, { type: 'command-rejected', command: message.type, reason: result.reason });
    // The panel acted on an outdated view; re-sync it.
    post(port, connectionsMessage(connections));
  }
}

async function dispatchConnection(
  connections: ConnectionCoordinator,
  message: ConnectionClientMessage,
): Promise<RunnerResult> {
  switch (message.type) {
    case 'refresh-connections':
      await connections.refresh();
      return { ok: true };
    case 'link-conversation':
      return connections.link(message);
    case 'link-new-chat':
      return connections.linkNewChat(message);
    case 'confirm-conversation-identity':
      return connections.confirmIdentity(message);
    case 'reconnect-conversation':
      return connections.reconnect(message);
    case 'disconnect-conversation':
      return connections.disconnect(message);
  }
}

function connectionsMessage(connections: ConnectionCoordinator): HostMessage {
  return { type: 'connections', connections: buildConnectionsView(connections.getSnapshot()) };
}

function snapshotMessage(runner: DebateRunner<DebateSetup>): HostMessage {
  const { session, setup } = runner.getSnapshot();
  return {
    type: 'snapshot',
    snapshot: {
      mode: session === null ? null : (setup?.mode ?? null),
      participants: SIMULATION_PARTICIPANTS,
      liveParticipants: LIVE_PARTICIPANTS,
      session,
      scenario: setup?.mode === 'simulation' ? setup.scenario : null,
      pace: setup?.mode === 'simulation' ? setup.pace : null,
    },
  };
}

function post(port: Port, message: HostMessage): void {
  try {
    port.postMessage(message);
  } catch {
    // The panel disconnected between the check and the post; it re-syncs on reconnect.
  }
}

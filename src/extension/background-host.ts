import { browser, type Browser } from 'wxt/browser';
import {
  buildConnectionsView,
  createConnectionCoordinator,
  createDebateRunner,
  type ConnectionCoordinator,
  type DebateRunner,
  type RunnerResult,
} from '../application';
import { DEFAULT_CONFIGURATION } from '../domain';
import {
  SIMULATION_PARTICIPANTS,
  createSimulatedProviders,
  delaysForPace,
  isSimulationSetup,
  type SimulationSetup,
} from '../infrastructure/simulator';
import { createConversationRecognizer } from '../infrastructure/conversation-urls';
import { createChromeTabSource, watchTabEvents } from './chrome-tabs';
import {
  SIDE_PANEL_PORT_NAME,
  isConnectionMessage,
  parseClientMessage,
  type ClientMessage,
  type ConnectionClientMessage,
  type HostMessage,
} from './protocol';
import { randomIds, systemClock } from './runtime-adapters';
import { createSessionCheckpointStore } from './session-checkpoint-store';
import { createSessionConnectionStore } from './session-connection-store';

type Port = Browser.runtime.Port;

/**
 * Composition root for the background service worker.
 *
 * The debate lives here rather than in the side panel, so closing or
 * reloading the panel does not interrupt it. The service worker itself may be
 * terminated by Chrome at any time; the session is restored from the
 * checkpoint on the next start (see docs/architecture/runtime-and-recovery.md).
 *
 * It also hosts the conversation link coordinator (Phase 2.1). Links are
 * independent of the debate: the debate runner never sees them, and they are
 * stored under a separate key. Tab events keep links current while the worker
 * runs; because events are lost while it is suspended, links are also
 * reconciled with the open tabs on every start and every panel connection.
 *
 * All listeners are registered synchronously, as MV3 requires.
 */
export function startBackgroundHost(): void {
  const runner = createDebateRunner<SimulationSetup>({
    clock: systemClock,
    ids: randomIds,
    checkpoints: createSessionCheckpointStore(isSimulationSetup),
    createProviders: (setup) => createSimulatedProviders(setup.scenario, delaysForPace(setup.pace)),
    reportError: (error) => {
      console.error('[ThirdMind]', error);
    },
  });

  const connections = createConnectionCoordinator({
    tabs: createChromeTabSource(browser.tabs),
    recognizer: createConversationRecognizer(),
    store: createSessionConnectionStore(),
    reportError: (error) => {
      // Never include tab URLs or titles here; Chrome and storage errors do not contain them.
      console.error('[ThirdMind] Conversation links:', error);
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
    tabChanged: (tabId, url) => void connections.tabChanged(tabId, url),
    tabRemoved: (tabId) => void connections.tabRemoved(tabId),
    rescan: () => void connections.refresh(),
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
      } else if (isConnectionMessage(message)) {
        // The coordinator queues commands behind its own initialization.
        void handleConnectionMessage(connections, port, message);
      } else {
        void ready.then(() => handleMessage(runner, port, message));
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

async function handleMessage(
  runner: DebateRunner<SimulationSetup>,
  port: Port,
  message: Exclude<ClientMessage, ConnectionClientMessage>,
): Promise<void> {
  let result: RunnerResult;
  try {
    result = await dispatch(runner, message);
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

function dispatch(
  runner: DebateRunner<SimulationSetup>,
  message: Exclude<ClientMessage, ConnectionClientMessage>,
): Promise<RunnerResult> {
  switch (message.type) {
    case 'start':
      return runner.start({
        topic: message.topic,
        constraints: message.constraints,
        participants: SIMULATION_PARTICIPANTS,
        configuration: DEFAULT_CONFIGURATION,
        setup: { scenario: message.scenario, pace: message.pace },
      });
    case 'pause':
      return runner.pause(message.sessionId);
    case 'resume':
      return runner.resume(message.sessionId);
    case 'add-constraint':
      return runner.addConstraint(message.content, message.sessionId);
    case 'reissue-operation':
      return runner.reissueUncertainOperation(message.operationId, message.sessionId);
    case 'reset':
      return runner.reset(message.sessionId);
  }
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
    case 'reconnect-conversation':
      return connections.reconnect(message);
    case 'disconnect-conversation':
      return connections.disconnect(message);
  }
}

function connectionsMessage(connections: ConnectionCoordinator): HostMessage {
  return { type: 'connections', connections: buildConnectionsView(connections.getSnapshot()) };
}

function snapshotMessage(runner: DebateRunner<SimulationSetup>): HostMessage {
  const { session, setup } = runner.getSnapshot();
  return {
    type: 'snapshot',
    snapshot: {
      mode: 'simulation',
      participants: SIMULATION_PARTICIPANTS,
      session,
      scenario: setup?.scenario ?? null,
      pace: setup?.pace ?? null,
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

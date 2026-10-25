import type { ConnectionsView } from '../application';
import {
  MAX_CONSTRAINT_LENGTH,
  MAX_CONSTRAINTS,
  MAX_TOPIC_LENGTH,
  isConversationId,
  isConversationProviderId,
  isRevision,
  isTabId,
  type ConversationProviderId,
  type DebateSession,
  type Participant,
  type SessionId,
} from '../domain';
import {
  isSimulationPaceId,
  isSimulationScenarioId,
  type SimulationPaceId,
  type SimulationScenarioId,
} from '../infrastructure/simulator/scenarios';
import type { ProviderProbeResult } from '../ports';

/**
 * Typed messages exchanged between the side panel (client) and the background
 * service worker (host) over a long-lived `runtime.Port`.
 *
 * Messages crossing the context boundary are untrusted `unknown` values and
 * are validated with the parsers below before use.
 */
export const SIDE_PANEL_PORT_NAME = 'thirdmind/side-panel';

/**
 * Every command that acts on an existing session names it (`sessionId`). The
 * host rejects commands for any session other than the current one, so a
 * stale panel cannot pause, change or discard a newer session.
 */
export type ClientMessage =
  | {
      readonly type: 'start';
      readonly topic: string;
      readonly constraints: readonly string[];
      readonly scenario: SimulationScenarioId;
      readonly pace: SimulationPaceId;
    }
  | { readonly type: 'pause'; readonly sessionId: SessionId }
  | { readonly type: 'resume'; readonly sessionId: SessionId }
  | { readonly type: 'add-constraint'; readonly sessionId: SessionId; readonly content: string }
  | { readonly type: 'reissue-operation'; readonly sessionId: SessionId; readonly operationId: string }
  | { readonly type: 'reset'; readonly sessionId: SessionId }
  | ConnectionClientMessage
  | PageCheckClientMessage;

/**
 * Conversation link commands (Phase 2.1, new chats Phase 2.2A). They never
 * touch the debate. Each command that changes a link carries the slot
 * `expectedRevision` the panel displayed, so a stale panel cannot overwrite a
 * newer connection state. Tab ids and conversation ids sent by the panel are
 * only claims: the host rechecks them against a fresh tab scan. The panel
 * never sends URLs.
 */
export type ConnectionClientMessage =
  | { readonly type: 'refresh-connections' }
  | {
      readonly type: 'link-conversation';
      readonly provider: ConversationProviderId;
      readonly tabId: number;
      readonly conversationId: string;
      readonly expectedRevision: number;
    }
  | {
      readonly type: 'link-new-chat';
      readonly provider: ConversationProviderId;
      readonly tabId: number;
      readonly expectedRevision: number;
    }
  | {
      /** Accepts the conversation the linked new chat's tab now shows. */
      readonly type: 'confirm-conversation-identity';
      readonly provider: ConversationProviderId;
      readonly tabId: number;
      readonly conversationId: string;
      readonly expectedRevision: number;
    }
  | {
      readonly type: 'reconnect-conversation';
      readonly provider: ConversationProviderId;
      readonly tabId: number;
      readonly expectedRevision: number;
    }
  | { readonly type: 'disconnect-conversation'; readonly provider: ConversationProviderId; readonly expectedRevision: number };

/**
 * Asks the host to check the page connection of the provider's linked tab
 * (Phase 2.2B foundation). The panel names only the provider: the host takes
 * the tab from the current link, so the panel cannot aim the transport at an
 * arbitrary tab, and nothing it sends is ever executed by a page.
 */
export interface PageCheckClientMessage {
  readonly type: 'check-provider-page';
  readonly provider: ConversationProviderId;
}

export type ClientMessageType = ClientMessage['type'];

export function isConnectionMessage(message: ClientMessage): message is ConnectionClientMessage {
  return (
    message.type === 'refresh-connections' ||
    message.type === 'link-conversation' ||
    message.type === 'link-new-chat' ||
    message.type === 'confirm-conversation-identity' ||
    message.type === 'reconnect-conversation' ||
    message.type === 'disconnect-conversation'
  );
}

/** The result of a page check, for the tab that was linked when the check ran. */
export interface PageCheckView {
  readonly provider: ConversationProviderId;
  readonly tabId: number;
  readonly result: ProviderProbeResult;
}

export interface HostSnapshot {
  readonly mode: 'simulation';
  /** Participants a new session will use. */
  readonly participants: readonly Participant[];
  readonly session: DebateSession | null;
  readonly scenario: SimulationScenarioId | null;
  readonly pace: SimulationPaceId | null;
}

/**
 * Debate snapshots and connection views are separate messages: linked
 * conversations are never part of the simulated debate's state.
 */
export type HostMessage =
  | { readonly type: 'snapshot'; readonly snapshot: HostSnapshot }
  | { readonly type: 'connections'; readonly connections: ConnectionsView }
  | { readonly type: 'page-check'; readonly check: PageCheckView }
  | { readonly type: 'command-rejected'; readonly command: ClientMessageType | 'unknown'; readonly reason: string };

export function parseClientMessage(value: unknown): ClientMessage | null {
  if (!isRecord(value)) {
    return null;
  }
  if (value.type === 'start') {
    const { topic, constraints, scenario, pace } = value;
    if (
      typeof topic !== 'string' ||
      topic.length > MAX_TOPIC_LENGTH ||
      !Array.isArray(constraints) ||
      constraints.length > MAX_CONSTRAINTS ||
      !constraints.every((c): c is string => typeof c === 'string' && c.length <= MAX_CONSTRAINT_LENGTH) ||
      !isSimulationScenarioId(scenario) ||
      !isSimulationPaceId(pace)
    ) {
      return null;
    }
    return { type: 'start', topic, constraints, scenario, pace };
  }

  if (value.type === 'check-provider-page') {
    return isConversationProviderId(value.provider) ? { type: 'check-provider-page', provider: value.provider } : null;
  }

  const connectionMessage = parseConnectionMessage(value);
  if (connectionMessage !== undefined) {
    return connectionMessage;
  }

  const { sessionId } = value;
  if (!isNonEmptyString(sessionId)) {
    return null;
  }
  switch (value.type) {
    case 'pause':
      return { type: 'pause', sessionId };
    case 'resume':
      return { type: 'resume', sessionId };
    case 'reset':
      return { type: 'reset', sessionId };
    case 'add-constraint': {
      const { content } = value;
      return typeof content === 'string' && content.length <= MAX_CONSTRAINT_LENGTH
        ? { type: 'add-constraint', sessionId, content }
        : null;
    }
    case 'reissue-operation': {
      const { operationId } = value;
      return isNonEmptyString(operationId) ? { type: 'reissue-operation', sessionId, operationId } : null;
    }
    default:
      return null;
  }
}

/** `undefined`: not a connection message type. `null`: a connection message type with invalid fields. */
function parseConnectionMessage(value: Record<string, unknown>): ConnectionClientMessage | null | undefined {
  const { type, provider, tabId, conversationId, expectedRevision } = value;
  switch (type) {
    case 'refresh-connections':
      return { type: 'refresh-connections' };
    case 'link-conversation':
      return isConversationProviderId(provider) &&
        isTabId(tabId) &&
        isRevision(expectedRevision) &&
        isConversationId(conversationId)
        ? { type: 'link-conversation', provider, tabId, conversationId, expectedRevision }
        : null;
    case 'link-new-chat':
      return isConversationProviderId(provider) && isTabId(tabId) && isRevision(expectedRevision)
        ? { type: 'link-new-chat', provider, tabId, expectedRevision }
        : null;
    case 'confirm-conversation-identity':
      return isConversationProviderId(provider) &&
        isTabId(tabId) &&
        isRevision(expectedRevision) &&
        isConversationId(conversationId)
        ? { type: 'confirm-conversation-identity', provider, tabId, conversationId, expectedRevision }
        : null;
    case 'reconnect-conversation':
      return isConversationProviderId(provider) && isTabId(tabId) && isRevision(expectedRevision)
        ? { type: 'reconnect-conversation', provider, tabId, expectedRevision }
        : null;
    case 'disconnect-conversation':
      return isConversationProviderId(provider) && isRevision(expectedRevision)
        ? { type: 'disconnect-conversation', provider, expectedRevision }
        : null;
    default:
      return undefined;
  }
}

/**
 * Host messages come from this extension's own service worker, so only the
 * envelope is checked; the session payload is trusted as produced by the domain.
 */
export function parseHostMessage(value: unknown): HostMessage | null {
  if (!isRecord(value)) {
    return null;
  }
  const { snapshot } = value;
  if (value.type === 'snapshot' && isRecord(snapshot) && snapshot.mode === 'simulation') {
    return value as unknown as HostMessage;
  }
  const { connections } = value;
  if (value.type === 'connections' && isRecord(connections) && Array.isArray(connections.providers)) {
    return value as unknown as HostMessage;
  }
  const { check } = value;
  if (value.type === 'page-check' && isRecord(check) && isRecord(check.result)) {
    return value as unknown as HostMessage;
  }
  if (value.type === 'command-rejected' && typeof value.reason === 'string') {
    return value as unknown as HostMessage;
  }
  return null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

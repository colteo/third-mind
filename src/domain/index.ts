/**
 * Public API of the ThirdMind domain: the debate engine and conversation links.
 *
 * Pure, deterministic and framework-independent: no Chrome APIs, DOM, React,
 * storage, clocks or random identifiers. Other modules import from this file
 * only, never from individual domain files.
 */
export type * from './types';
export type * from './events';
export type { DebateCommand } from './commands';
export type { ContributionRequest, PriorContribution, RequestConstraint } from './requests';
export type { EvolveResult } from './evolve';
export type { StoppingDecision } from './stopping';
export type { AvailableActions } from './queries';

export {
  DEBATE_PHASES,
  DEFAULT_CONFIGURATION,
  EARLIEST_EARLY_STOP_ROUND,
  HUMAN_PARTICIPANT,
  MAX_CONSTRAINT_LENGTH,
  MAX_CONSTRAINTS,
  MAX_SUPPORTED_ROUNDS,
  MAX_TOPIC_LENGTH,
  PHASE_TITLES,
  phaseForRound,
} from './constants';
export { evolve } from './evolve';
export { decide } from './decide';
export { evaluateStopping } from './stopping';
export { buildContributionRequest, interventionIdsOf } from './requests';
export {
  activeOperation,
  availableActions,
  canDispatchFurtherRequests,
  contributionsInRound,
  dispatchedOperations,
  findOperation,
  findParticipant,
  isCurrentRoundComplete,
  operationIdFor,
  providerParticipants,
  uncertainOperations,
} from './queries';

// Conversation links (Phase 2.1): independent of the debate engine above.
export type {
  BrowserTabId,
  ConnectionChange,
  ConnectionRegistry,
  ConnectionSlot,
  ConnectionState,
  ConversationLink,
  ConversationProviderId,
  ConversationRef,
  DisconnectRequest,
  LinkRequest,
  ObservedTab,
  ReconnectRequest,
  TabClassification,
  TabObservation,
  UrlClassification,
} from './connections';
export {
  CONVERSATION_PROVIDERS,
  EMPTY_CONNECTION_REGISTRY,
  disconnectConversation,
  isConversationProviderId,
  isRevision,
  isSameConversation,
  isTabId,
  linkConversation,
  observeLink,
  parseConnectionRegistry,
  reconcileRegistry,
  reconnectConversation,
  tabShowsLinkedConversation,
} from './connections';

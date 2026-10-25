/** Public API of the application layer: debate orchestration, conversation links and read models. */
export {
  createDebateRunner,
  type DebateRunner,
  type DebateRunnerDependencies,
  type RunnerResult,
  type RunnerSnapshot,
  type SnapshotListener,
  type StartDebateInput,
} from './debate-runner';
export {
  buildConversationalSummary,
  buildDebateReport,
  type AttributedStatement,
  type DebateReport,
  type InterventionSummary,
  type ParticipantPosition,
  type RoundSummary,
} from './report';
export {
  MAX_TAB_TITLE_LENGTH,
  createConnectionCoordinator,
  sanitizeTitle,
  type ConnectionCoordinator,
  type ConnectionCoordinatorDependencies,
  type ConnectionsListener,
  type ConnectionsSnapshot,
  type TabDiscovery,
} from './connection-coordinator';
export {
  buildConnectionsView,
  type CandidateStatus,
  type ConnectionsView,
  type ConversationCandidate,
  type LinkedConversationView,
  type LinkedIdentityView,
  type NewChatCandidate,
  type ProviderConnectionsView,
} from './connection-view';

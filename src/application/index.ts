/** Public API of the application layer: debate orchestration, conversation links, live debate preflight and read models. */
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
export {
  EXECUTION_MODES,
  LIVE_PARTICIPANTS,
  LIVE_PARTICIPANT_PROVIDERS,
  isExecutionMode,
  isLiveDebateSetup,
  type ExecutionMode,
  type LiveDebateSetup,
  type LiveTargetBinding,
  type LiveTargetBindings,
} from './execution-mode';
export {
  CAPABILITY_NAMES,
  TECHNICAL_CAPABILITIES,
  isAuthorized,
  isLiveReady,
  isTechnicallyReady,
  type CapabilityCheck,
  type CapabilityName,
  type PreflightIssue,
  type PreflightIssueCode,
  type ProviderCapabilities,
} from './live-capabilities';
export {
  createLivePreflight,
  describePreflightFailure,
  evaluateConnection,
  type ConnectionEvaluation,
  type LinkRevisions,
  type LivePreflight,
  type LivePreflightDependencies,
  type LivePreflightRequest,
  type LivePreflightResult,
  type ProviderPreflight,
  type TargetVerification,
} from './live-preflight';
export {
  DEFAULT_LIVE_RESPONSE_TIMEOUT_MS,
  createLiveContributionProvider,
  createLiveProviders,
  createSubmissionLocks,
  livePrompt,
  type LiveContributionProviderOptions,
  type LiveProvidersDependencies,
  type SubmissionLocks,
} from './live-contribution-provider';
export {
  ASSESSMENT_FENCE,
  ASSESSMENT_FORMAT_INSTRUCTIONS,
  MISSING_ASSESSMENT_ISSUE,
  parseLiveResponse,
  type ParsedLiveResponse,
} from './live-response';
export { prepareLiveStart, verifyLiveContinuation, type LiveGateResult } from './live-debate';

import {
  CONVERSATION_PROVIDERS,
  HUMAN_PARTICIPANT,
  isConversationId,
  isConversationProviderId,
  isRevision,
  isTabId,
  type BrowserTabId,
  type ConversationProviderId,
  type Participant,
  type ParticipantId,
} from '../domain';

/**
 * How a debate obtains contributions:
 * - `simulation`: deterministic local simulators. Always available;
 * - `live`: the linked ChatGPT and Claude conversations, through live provider
 *   adapters. Only available when preflight confirms every required capability.
 *
 * The mode is fixed when a session starts and recorded in its setup. A live
 * session never falls back to simulation: if a live provider cannot be
 * reached, the operation fails or becomes uncertain.
 */
export type ExecutionMode = 'simulation' | 'live';

export const EXECUTION_MODES: readonly ExecutionMode[] = ['simulation', 'live'];

export function isExecutionMode(value: unknown): value is ExecutionMode {
  return EXECUTION_MODES.some((mode) => mode === value);
}

/**
 * The conversation a live participant was bound to when the debate started.
 * Every live operation re-verifies that the link still points at exactly this
 * tab and conversation. Contains no URLs, titles or content.
 */
export interface LiveTargetBinding {
  readonly provider: ConversationProviderId;
  readonly tabId: BrowserTabId;
  readonly conversationId: string;
  /** Link slot revision at preflight time. */
  readonly linkRevision: number;
}

export type LiveTargetBindings = Readonly<Record<ConversationProviderId, LiveTargetBinding>>;

/** Checkpointed setup of a live session, used to recreate its providers after a restart. */
export interface LiveDebateSetup {
  readonly mode: 'live';
  readonly targets: LiveTargetBindings;
}

/** Participant ids are shared with simulation mode, so read models and reports work unchanged. */
export const LIVE_PARTICIPANT_PROVIDERS: Readonly<Record<ConversationProviderId, ParticipantId>> = {
  chatgpt: 'gpt',
  claude: 'claude',
};

export const LIVE_PARTICIPANTS: readonly Participant[] = [
  HUMAN_PARTICIPANT,
  { id: LIVE_PARTICIPANT_PROVIDERS.chatgpt, displayName: 'ChatGPT', providerType: 'chatgpt-live' },
  { id: LIVE_PARTICIPANT_PROVIDERS.claude, displayName: 'Claude', providerType: 'claude-live' },
];

export function isLiveDebateSetup(value: unknown): value is LiveDebateSetup {
  if (!isRecord(value) || value.mode !== 'live' || !isRecord(value.targets)) {
    return false;
  }
  const { targets } = value;
  return CONVERSATION_PROVIDERS.every((provider) => {
    const target = targets[provider];
    return (
      isRecord(target) &&
      isConversationProviderId(target.provider) &&
      target.provider === provider &&
      isTabId(target.tabId) &&
      isConversationId(target.conversationId) &&
      isRevision(target.linkRevision)
    );
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

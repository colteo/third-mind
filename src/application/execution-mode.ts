import {
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
 * What a live participant is bound to. Contains no URLs, titles or content.
 *
 * - `conversation`: a saved conversation with a known persistent identifier;
 * - `new-chat`: an explicitly linked new chat before its first message, bound
 *   to its provider, its user-approved tab, its exact origin and the document
 *   (page instance) observed by the preflight. It has no conversation
 *   identifier: the provider assigns one when the first message is saved, and
 *   ThirdMind then binds it (see `live-target.ts`). None is ever invented.
 *
 * Every live operation re-verifies that the link and the page still match the binding.
 */
export type LiveTargetBinding = SavedConversationBinding | NewChatBinding;

/**
 * How a saved conversation became the target:
 * - `linked`: it was the linked saved conversation when the debate started;
 * - `first-message`: it was created by the debate's first message to a linked
 *   new chat, and the adapter's report and the page agreed on it;
 * - `recovered`: the human bound it explicitly after the first message's
 *   identity could not be established.
 */
export type BindingSource = 'linked' | 'first-message' | 'recovered';

export interface SavedConversationBinding {
  readonly kind: 'conversation';
  readonly provider: ConversationProviderId;
  readonly tabId: BrowserTabId;
  readonly conversationId: string;
  /** Link slot revision when the binding was made. */
  readonly linkRevision: number;
  readonly source: BindingSource;
}

export interface NewChatBinding {
  readonly kind: 'new-chat';
  readonly provider: ConversationProviderId;
  readonly tabId: BrowserTabId;
  /** Exact provider origin the new chat was approved on. */
  readonly origin: string;
  /** Document observed by the preflight. A reload or a replaced document is a different target. */
  readonly pageInstanceId: string;
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

/**
 * Reads a checkpointed live setup. Bindings written before new chats could be
 * live targets have no `kind`; they are read as saved conversations linked at
 * the start. Anything malformed is rejected.
 */
export function parseLiveDebateSetup(value: unknown): LiveDebateSetup | null {
  if (!isRecord(value) || value.mode !== 'live' || !isRecord(value.targets)) {
    return null;
  }
  const chatgpt = parseLiveTargetBinding(value.targets.chatgpt, 'chatgpt');
  const claude = parseLiveTargetBinding(value.targets.claude, 'claude');
  return chatgpt === null || claude === null ? null : { mode: 'live', targets: { chatgpt, claude } };
}

export function isLiveDebateSetup(value: unknown): value is LiveDebateSetup {
  return parseLiveDebateSetup(value) !== null;
}

/** Strict structural check of one binding. Returns a clean copy, or `null`. */
export function parseLiveTargetBinding(value: unknown, provider: ConversationProviderId): LiveTargetBinding | null {
  if (
    !isRecord(value) ||
    !isConversationProviderId(value.provider) ||
    value.provider !== provider ||
    !isTabId(value.tabId) ||
    !isRevision(value.linkRevision)
  ) {
    return null;
  }
  const { tabId, linkRevision } = value;
  const kind = value.kind ?? 'conversation';
  if (kind === 'conversation') {
    const source = value.source ?? 'linked';
    return isConversationId(value.conversationId) && isBindingSource(source)
      ? { kind, provider, tabId, conversationId: value.conversationId, linkRevision, source }
      : null;
  }
  if (kind === 'new-chat') {
    return isNonEmptyString(value.origin) && isNonEmptyString(value.pageInstanceId)
      ? { kind, provider, tabId, origin: value.origin, pageInstanceId: value.pageInstanceId, linkRevision }
      : null;
  }
  return null;
}

function isBindingSource(value: unknown): value is BindingSource {
  return value === 'linked' || value === 'first-message' || value === 'recovered';
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

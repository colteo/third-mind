import { CONVERSATION_PROVIDERS, type ContributionRequest, type OperationId, type ParticipantId } from '../domain';
import type {
  ContributionProvider,
  LiveAdapterRegistry,
  LiveConversationTarget,
  LiveFailure,
  LiveProviderAdapter,
  LiveResponse,
  ProviderRegistry,
  ProviderResult,
  ResponseResult,
  SubmissionReceipt,
  SubmissionResult,
} from '../ports';
import {
  LIVE_PARTICIPANT_PROVIDERS,
  type LiveDebateSetup,
  type LiveTargetBinding,
  type NewChatBinding,
} from './execution-mode';
import { providerName, type TargetVerification } from './live-preflight';
import { ASSESSMENT_FORMAT_INSTRUCTIONS, parseLiveResponse } from './live-response';
import { reconcileFirstMessage, type LiveTargetTracker, type NewChatObservation, type TargetChange } from './live-target';

/**
 * In-memory exclusive locks per conversation, so two submissions never reach
 * the same conversation concurrently. Locks do not survive a service worker
 * restart, and nothing needs them to: every operation that was in flight is
 * then uncertain and is not re-sent without human approval.
 */
export interface SubmissionLocks {
  /** Returns a release function, or `null` when the key is already held. */
  acquire(key: string): (() => void) | null;
}

export function createSubmissionLocks(): SubmissionLocks {
  const held = new Set<string>();
  return {
    acquire(key) {
      if (held.has(key)) {
        return null;
      }
      held.add(key);
      let released = false;
      return () => {
        if (!released) {
          released = true;
          held.delete(key);
        }
      };
    },
  };
}

/** Generous: a provider may think for minutes. A timeout makes the operation uncertain, never failed. */
export const DEFAULT_LIVE_RESPONSE_TIMEOUT_MS = 5 * 60 * 1000;

/** How live providers check and track their targets. Implemented by the live preflight and the target tracker. */
export interface LiveTargetAccess {
  readonly verifyTarget: (binding: LiveTargetBinding) => Promise<TargetVerification>;
  readonly observeNewChat: (binding: NewChatBinding) => Promise<NewChatObservation>;
  /** Persisted target states. A new chat's first message is recorded here before it is submitted. */
  readonly targets: LiveTargetTracker;
}

export interface LiveContributionProviderOptions extends LiveTargetAccess {
  readonly participantId: ParticipantId;
  readonly adapter: LiveProviderAdapter;
  /** The session's setup: the bindings every participant starts from. */
  readonly setup: LiveDebateSetup;
  readonly locks: SubmissionLocks;
  readonly responseTimeoutMs?: number;
}

/**
 * `ContributionProvider` for one live participant. Every call:
 *
 * 1. reads where the participant is bound now: a saved conversation, or a new
 *    chat before its first message. An unresolved first message blocks it;
 * 2. re-verifies that target (link, tab, page and, for a new chat, the
 *    approved document) — nothing is sent if it changed;
 * 3. takes the target's submission lock;
 * 4. for a new chat only: persists the write-ahead record of the first
 *    message before anything is submitted;
 * 5. submits once through the adapter, with the operation id as idempotency key;
 * 6. waits for the response with a timeout;
 * 7. accepts the response only if it belongs to this operation, submission
 *    and document and, for a saved conversation, to that conversation while
 *    the tab still shows it. For a new chat, the conversation the adapter
 *    reports must be the one the linked tab now shows on the same document;
 *    it is then bound, and every later request goes there.
 *
 * Anything that happens after a submission may have been delivered is
 * reported as `outcome: 'unknown'`: a timeout, a navigation, a mismatched or
 * malformed response, an identity that cannot be established. Only failures
 * that certainly happened before anything was delivered are reported as failures.
 */
export function createLiveContributionProvider(options: LiveContributionProviderOptions): ContributionProvider {
  const { adapter, locks } = options;
  const { provider } = adapter;
  const timeoutMs = options.responseTimeoutMs ?? DEFAULT_LIVE_RESPONSE_TIMEOUT_MS;
  const label = providerName(provider);

  return {
    participantId: options.participantId,
    origin: 'live',
    supportsCancellation: true,
    async requestContribution(request, { signal }) {
      if (signal.aborted) {
        return failed('The request was cancelled before it was sent.');
      }
      if (adapter.authorization.kind !== 'authorized') {
        return failed(adapter.authorization.reason);
      }
      const targets = options.targets.forSession(request.sessionId, options.setup);
      const state = await guard(
        () => targets.current(provider),
        () => null,
      );
      if (state === null) {
        return failed(`Nothing was sent to ${label}: the live target record could not be read.`);
      }
      if (state.kind === 'first-message') {
        return failed(
          `Nothing was sent to ${label}: the first message to the linked new chat may already have been sent, and the conversation it created has not been established. Resolve it before continuing.`,
        );
      }
      const { binding } = state;
      const before = await options.verifyTarget(binding);
      if (!before.ok) {
        return failed(`Nothing was sent to ${label}. ${before.issue.message}`);
      }
      const { target } = before;
      const release = locks.acquire(lockKey(target));
      if (release === null) {
        return failed(`Nothing was sent to ${label}: another message to this conversation is still in progress.`);
      }
      let armed = false;
      try {
        if (binding.kind === 'new-chat') {
          // Write-ahead: after this point a restart finds a first message that may have been sent.
          const recorded = await guard(
            () => targets.armFirstMessage(binding, request.operationId),
            (): TargetChange => ({ ok: false, reason: 'the first message could not be recorded before sending.' }),
          );
          if (!recorded.ok) {
            return failed(`Nothing was sent to ${label}: ${recorded.reason}`);
          }
          armed = true;
        }
        const submitted = await guard(
          () =>
            adapter.submit(
              target,
              { operationId: request.operationId, text: livePrompt(request) },
              { signal },
            ),
          (): SubmissionResult => ({ ok: false, failure: unknownFailure('transport-error', 'The adapter failed while submitting.') }),
        );
        if (!submitted.ok) {
          if (armed && submitted.failure.outcome === 'not-performed') {
            // Certainly not sent: the new chat is still the untouched target. If the record cannot be
            // withdrawn, it stays and the human resolves it; that is safe, only less convenient.
            await guard(
              () => targets.withdrawFirstMessage(provider, request.operationId),
              (): TargetChange => ({ ok: false, reason: 'not withdrawn' }),
            );
          }
          return fromFailure(label, submitted.failure);
        }
        const { receipt } = submitted;
        if (!receiptMatches(receipt, target, request.operationId)) {
          return uncertain(`${label} acknowledged a submission that does not match this request.`);
        }

        const responded = await withTimeout(timeoutMs, signal, (callSignal) =>
          guard(
            () => adapter.awaitResponse(target, receipt, { signal: callSignal }),
            (): ResponseResult => ({ ok: false, failure: unknownFailure('transport-error', 'The adapter failed while waiting for the response.') }),
          ),
        );
        if (responded === 'timeout') {
          return uncertain(
            `No response from ${label} within ${Math.round(timeoutMs / 1000)} seconds. The message may have been delivered.`,
          );
        }
        if (!responded.ok) {
          return fromFailure(label, responded.failure);
        }
        const { response } = responded;

        if (binding.kind === 'new-chat') {
          // The tab is expected to move from the new chat to the conversation the first message created.
          const observation = await options.observeNewChat(binding);
          const reconciled = reconcileFirstMessage(binding, request.operationId, receipt, response, observation);
          if (!reconciled.ok) {
            return uncertain(
              `The first message to the new ${label} chat could not be matched to a conversation, so the response was discarded and nothing more is sent to ${label} until you resolve it. ${reconciled.reason}`,
            );
          }
          const bound = await guard(
            () => targets.bindFirstMessage(request.operationId, reconciled.binding),
            (): TargetChange => ({ ok: false, reason: 'The conversation could not be recorded.' }),
          );
          if (!bound.ok) {
            return uncertain(`The ${label} conversation created by the first message could not be bound. ${bound.reason}`);
          }
        } else {
          if (!responseMatches(response, receipt)) {
            return uncertain(`The response did not belong to this ${label} conversation or page, so it was discarded.`);
          }
          // The tab must still show the same document: an answer from before a navigation or reload is stale.
          const after = await options.verifyTarget(binding);
          if (!after.ok || after.target.pageInstanceId !== receipt.pageInstanceId) {
            return uncertain(`The ${label} tab changed while waiting for the response, so the response was discarded.`);
          }
        }
        const parsed = parseLiveResponse(response.content);
        if (parsed.content.length === 0) {
          return uncertain(`${label} returned an empty response.`);
        }
        return { ok: true, content: parsed.content, assessment: parsed.assessment };
      } finally {
        if (armed) {
          targets.settleFirstMessage(provider);
        }
        release();
      }
    },
  };
}

export interface LiveProvidersDependencies extends LiveTargetAccess {
  readonly adapters: LiveAdapterRegistry;
  readonly locks: SubmissionLocks;
  readonly responseTimeoutMs?: number;
}

/**
 * Providers for a live session. A provider without an authorized adapter is
 * left out, so the runner refuses to start (or fails the operation after a
 * restart). A simulator is never substituted.
 */
export function createLiveProviders(setup: LiveDebateSetup, deps: LiveProvidersDependencies): ProviderRegistry {
  const registry = new Map<ParticipantId, ContributionProvider>();
  for (const provider of CONVERSATION_PROVIDERS) {
    const adapter = deps.adapters[provider];
    if (adapter?.authorization.kind !== 'authorized') {
      continue;
    }
    const participantId = LIVE_PARTICIPANT_PROVIDERS[provider];
    registry.set(
      participantId,
      createLiveContributionProvider({
        participantId,
        adapter,
        setup,
        verifyTarget: deps.verifyTarget,
        observeNewChat: deps.observeNewChat,
        targets: deps.targets,
        locks: deps.locks,
        ...(deps.responseTimeoutMs === undefined ? {} : { responseTimeoutMs: deps.responseTimeoutMs }),
      }),
    );
  }
  return registry;
}

export function livePrompt(request: ContributionRequest): string {
  return `${request.prompt}\n${ASSESSMENT_FORMAT_INSTRUCTIONS}`;
}

function lockKey(target: LiveConversationTarget): string {
  return target.kind === 'conversation'
    ? `${target.provider}:conversation:${target.conversationId}`
    : `${target.provider}:new-chat:${target.tabId}`;
}

function receiptMatches(receipt: SubmissionReceipt, target: LiveConversationTarget, operationId: OperationId): boolean {
  if (receipt.operationId !== operationId || receipt.pageInstanceId !== target.pageInstanceId) {
    return false;
  }
  return target.kind === 'conversation'
    ? receipt.kind === 'conversation' && receipt.conversationId === target.conversationId
    : receipt.kind === 'new-chat';
}

function responseMatches(response: LiveResponse, receipt: SubmissionReceipt): boolean {
  return (
    receipt.kind === 'conversation' &&
    response.operationId === receipt.operationId &&
    response.submissionId === receipt.submissionId &&
    response.conversationId === receipt.conversationId &&
    response.pageInstanceId === receipt.pageInstanceId
  );
}

function failed(message: string): ProviderResult {
  return { ok: false, error: { message }, outcome: 'failed' };
}

function uncertain(message: string): ProviderResult {
  return { ok: false, error: { message }, outcome: 'unknown' };
}

function fromFailure(label: string, failure: LiveFailure): ProviderResult {
  return failure.outcome === 'unknown'
    ? uncertain(`${label}: ${failure.message}`)
    : failed(`${label}: ${failure.message}`);
}

function unknownFailure(kind: LiveFailure['kind'], message: string): LiveFailure {
  return { kind, outcome: 'unknown', message };
}

/** Adapters must not throw; if one does, the outcome is treated as unknown. */
async function guard<T>(call: () => Promise<T>, onThrow: () => T): Promise<T> {
  try {
    return await call();
  } catch {
    return onThrow();
  }
}

/** Runs `call` with a signal that aborts on timeout or when `outer` aborts. */
function withTimeout<T>(
  timeoutMs: number,
  outer: AbortSignal,
  call: (signal: AbortSignal) => Promise<T>,
): Promise<T | 'timeout'> {
  const controller = new AbortController();
  const abort = (): void => {
    controller.abort();
  };
  outer.addEventListener('abort', abort, { once: true });
  return new Promise<T | 'timeout'>((resolve) => {
    const timer = setTimeout(() => {
      controller.abort();
      resolve('timeout');
    }, timeoutMs);
    call(controller.signal).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve('timeout');
      },
    );
  }).finally(() => {
    outer.removeEventListener('abort', abort);
  });
}

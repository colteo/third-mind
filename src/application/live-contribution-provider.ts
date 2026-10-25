import { CONVERSATION_PROVIDERS, type ContributionRequest, type ParticipantId } from '../domain';
import type {
  ContributionProvider,
  LiveAdapterRegistry,
  LiveFailure,
  LiveProviderAdapter,
  ProviderRegistry,
  ProviderResult,
  ResponseResult,
  SubmissionResult,
} from '../ports';
import { LIVE_PARTICIPANT_PROVIDERS, type LiveDebateSetup, type LiveTargetBinding } from './execution-mode';
import { providerName, type TargetVerification } from './live-preflight';
import { ASSESSMENT_FORMAT_INSTRUCTIONS, parseLiveResponse } from './live-response';

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

export interface LiveContributionProviderOptions {
  readonly participantId: ParticipantId;
  readonly adapter: LiveProviderAdapter;
  readonly binding: LiveTargetBinding;
  readonly verifyTarget: (binding: LiveTargetBinding) => Promise<TargetVerification>;
  readonly locks: SubmissionLocks;
  readonly responseTimeoutMs?: number;
}

/**
 * `ContributionProvider` for one live participant. Every call:
 *
 * 1. re-verifies the bound conversation (link, tab, page) — nothing is sent if it changed;
 * 2. takes the conversation's submission lock;
 * 3. submits once through the adapter, with the operation id as idempotency key;
 * 4. waits for the response with a timeout;
 * 5. accepts the response only if it belongs to this operation, submission,
 *    conversation and document, and the tab still shows that conversation.
 *
 * Anything that happens after a submission may have been delivered is
 * reported as `outcome: 'unknown'`: a timeout, a navigation, a mismatched or
 * malformed response. Only failures that certainly happened before anything
 * was delivered are reported as failures.
 */
export function createLiveContributionProvider(options: LiveContributionProviderOptions): ContributionProvider {
  const { adapter, binding, locks } = options;
  const timeoutMs = options.responseTimeoutMs ?? DEFAULT_LIVE_RESPONSE_TIMEOUT_MS;
  const label = providerName(binding.provider);

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
      const before = await options.verifyTarget(binding);
      if (!before.ok) {
        return failed(`Nothing was sent to ${label}. ${before.issue.message}`);
      }
      const { target } = before;
      const release = locks.acquire(`${target.provider}:${target.conversationId}`);
      if (release === null) {
        return failed(`Nothing was sent to ${label}: another message to this conversation is still in progress.`);
      }
      try {
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
          return fromFailure(label, submitted.failure);
        }
        const { receipt } = submitted;
        if (
          receipt.operationId !== request.operationId ||
          receipt.conversationId !== target.conversationId ||
          receipt.pageInstanceId !== target.pageInstanceId
        ) {
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
        if (
          response.operationId !== receipt.operationId ||
          response.submissionId !== receipt.submissionId ||
          response.conversationId !== receipt.conversationId ||
          response.pageInstanceId !== receipt.pageInstanceId
        ) {
          return uncertain(`The response did not belong to this ${label} conversation or page, so it was discarded.`);
        }
        // The tab must still show the same document: an answer from before a navigation or reload is stale.
        const after = await options.verifyTarget(binding);
        if (!after.ok || after.target.pageInstanceId !== receipt.pageInstanceId) {
          return uncertain(`The ${label} tab changed while waiting for the response, so the response was discarded.`);
        }
        const parsed = parseLiveResponse(response.content);
        if (parsed.content.length === 0) {
          return uncertain(`${label} returned an empty response.`);
        }
        return { ok: true, content: parsed.content, assessment: parsed.assessment };
      } finally {
        release();
      }
    },
  };
}

export interface LiveProvidersDependencies {
  readonly adapters: LiveAdapterRegistry;
  readonly verifyTarget: (binding: LiveTargetBinding) => Promise<TargetVerification>;
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
        binding: setup.targets[provider],
        verifyTarget: deps.verifyTarget,
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

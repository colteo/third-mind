import type { ConversationProviderId, SessionId } from '../domain';
import type { LiveDebateSetup, LiveTargetBinding } from './execution-mode';
import {
  describePreflightFailure,
  type LinkRevisions,
  type LivePreflight,
  type LivePreflightResult,
} from './live-preflight';
import type { FirstMessageResolution, LiveTargetTracker, TargetChange } from './live-target';

export type LiveGateResult<T> =
  | ({ readonly ok: true; readonly preflight: LivePreflightResult } & T)
  | { readonly ok: false; readonly reason: string; readonly preflight: LivePreflightResult };

/**
 * Decides whether a live debate may start. `expectedRevisions` are the link
 * revisions of the readiness view the human acted on: if a link changed since,
 * the command is rejected, so a stale panel can never start a debate against
 * conversations the human did not review. Each participant may be bound to a
 * saved conversation or to a linked new chat.
 */
export async function prepareLiveStart(
  preflight: LivePreflight,
  expectedRevisions: LinkRevisions,
): Promise<LiveGateResult<{ readonly setup: LiveDebateSetup }>> {
  const result = await preflight.run({ expectedRevisions });
  const chatgpt = bindingOf(result, 'chatgpt');
  const claude = bindingOf(result, 'claude');
  if (!result.ready || chatgpt === null || claude === null) {
    return { ok: false, reason: describePreflightFailure(result), preflight: result };
  }
  return { ok: true, preflight: result, setup: { mode: 'live', targets: { chatgpt, claude } } };
}

/**
 * Required before a paused live session resumes or re-issues an uncertain
 * operation: every participant must still be bound where the session's
 * target record says (the same saved conversation, the conversation bound
 * from its first message, or the same approved new-chat document), no first
 * message may be unresolved, and every capability must still be available.
 */
export async function verifyLiveContinuation(
  preflight: LivePreflight,
  targets: LiveTargetTracker,
  sessionId: SessionId,
  setup: LiveDebateSetup,
): Promise<LiveGateResult<object>> {
  const expectedTargets = await targets.forSession(sessionId, setup).snapshot();
  const result = await preflight.run({ expectedTargets });
  if (!result.ready) {
    return {
      ok: false,
      reason: describePreflightFailure(result, 'continue'),
      preflight: result,
    };
  }
  return { ok: true, preflight: result };
}

/**
 * Explicit human recovery of a first message whose conversation could not be
 * established. It checks the linked tab again and changes only where the
 * participant is bound; it never sends anything. Re-issuing the uncertain
 * operation stays a separate, explicit action.
 */
export function resolveLiveFirstMessage(
  preflight: LivePreflight,
  targets: LiveTargetTracker,
  sessionId: SessionId,
  setup: LiveDebateSetup,
  provider: ConversationProviderId,
  resolution: FirstMessageResolution,
): Promise<TargetChange> {
  return targets
    .forSession(sessionId, setup)
    .resolveFirstMessage(provider, resolution, (binding) => preflight.observeNewChat(binding));
}

function bindingOf(result: LivePreflightResult, provider: LiveTargetBinding['provider']): LiveTargetBinding | null {
  return result.providers.find((candidate) => candidate.provider === provider)?.binding ?? null;
}

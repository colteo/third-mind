import type { LiveDebateSetup, LiveTargetBinding } from './execution-mode';
import {
  describePreflightFailure,
  type LinkRevisions,
  type LivePreflight,
  type LivePreflightResult,
} from './live-preflight';

export type LiveGateResult<T> =
  | ({ readonly ok: true; readonly preflight: LivePreflightResult } & T)
  | { readonly ok: false; readonly reason: string; readonly preflight: LivePreflightResult };

/**
 * Decides whether a live debate may start. `expectedRevisions` are the link
 * revisions of the readiness view the human acted on: if a link changed since,
 * the command is rejected, so a stale panel can never start a debate against
 * conversations the human did not review.
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
 * operation: both conversations must still be the ones the session was
 * started with, and every capability must still be available.
 */
export async function verifyLiveContinuation(
  preflight: LivePreflight,
  setup: LiveDebateSetup,
): Promise<LiveGateResult<object>> {
  const result = await preflight.run({ expectedTargets: setup.targets });
  if (!result.ready) {
    return {
      ok: false,
      reason: describePreflightFailure(result, 'continue'),
      preflight: result,
    };
  }
  return { ok: true, preflight: result };
}

function bindingOf(result: LivePreflightResult, provider: LiveTargetBinding['provider']): LiveTargetBinding | null {
  return result.providers.find((candidate) => candidate.provider === provider)?.binding ?? null;
}

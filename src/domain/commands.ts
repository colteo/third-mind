import type { OperationDescriptor } from './events';
import type { ContributionRequest } from './requests';
import type { CompletionReason, OperationId } from './types';

/**
 * Work that the engine wants the application shell to perform. `decide`
 * produces commands; the shell executes them and records the resulting events.
 *
 * | Command               | Shell records                         | Side effect                  |
 * | --------------------- | ------------------------------------- | ---------------------------- |
 * | RequestContribution   | ContributionRequested                 | none                         |
 * | DispatchContribution  | ContributionDispatched (persisted)    | provider call, after persist |
 * | AdvanceRound          | RoundAdvanced                         | none                         |
 * | CompleteDebate        | DebateCompleted                       | none                         |
 * | ConfirmPause          | DebatePaused                          | none                         |
 */
export type DebateCommand =
  | { readonly type: 'RequestContribution'; readonly operation: OperationDescriptor }
  | {
      readonly type: 'DispatchContribution';
      readonly operationId: OperationId;
      readonly request: ContributionRequest;
    }
  | { readonly type: 'AdvanceRound'; readonly toRound: number }
  | { readonly type: 'CompleteDebate'; readonly reason: CompletionReason; readonly finalRound: number }
  | { readonly type: 'ConfirmPause' };

# Debate engine

The engine lives in `src/domain/`. It is pure and deterministic. It does not read clocks, generate random identifiers, access storage, call providers, or touch Chrome APIs, the DOM or React. Timestamps and identifiers arrive inside events.

## Core functions

```ts
evolve(state: DebateSession | null, event: DebateEvent): EvolveResult
decide(state: DebateSession | null): readonly DebateCommand[]
```

`evolve` returns one of three outcomes:

| Outcome    | Meaning                                                                                          | State     |
| ---------- | ------------------------------------------------------------------------------------------------ | --------- |
| `applied`  | Event was valid; a new state is returned                                                         | new       |
| `ignored`  | Duplicate, or refers to work that is already settled or superseded; re-delivery is safe          | unchanged |
| `rejected` | Violates a precondition (an invalid transition); the reason is returned                          | unchanged |

This refines the `evolve(state, event) -> state` signature from the brief. Callers need to distinguish an idempotent no-op from an invalid transition.

`decide` looks at a state and returns the work the shell should do next. It returns an empty list while waiting: for provider results, for the human, or because the session is terminal.

The application runner (`src/application/debate-runner.ts`) is the only shell in Phase 1. It loops as follows: `decide`, then turn each command into an event (adding `at` and identifiers), then `evolve`, persist and notify, and repeat until `decide` returns nothing.

## Session status

```text
                 DebateStarted
      idle ───────────────────► running ◄───────────────┐
                                 │  │  │                │ DebateResumed
                PauseRequested   │  │  │ ContributionFailed (no uncertain ops)
                                 ▼  │  ▼                │
                          pausing   │  failed           │
                                 │  │                   │
     DebatePaused (nothing in    │  │ DebateCompleted   │
     flight)                     ▼  ▼                   │
                            paused  completed           │
                              │                         │
                              └─────────────────────────┘

  RuntimeRecovered: running | pausing ──► paused (reason: runtime-restart)
```

`DebateStatus` is a discriminated union, so reason-specific data travels with the state: `paused.reason`, `completed.reason` and `finalRound`, and `failed.operationId`, `participantId` and `error`.

## Rounds and phases

| Round | Phase                  | Requests include                        |
| ----- | ---------------------- | --------------------------------------- |
| 1     | `independent-analysis` | no other contributions                  |
| 2     | `cross-examination`    | all round 1 contributions               |
| 3     | `refinement`           | all contributions from rounds 1–2       |
| 4     | `convergence`          | all contributions from rounds 1–3       |

- A **round** is one logical stage and normally contains one contribution from each provider participant. Individual responses are never counted as rounds.
- Within a round, all provider participants are requested **concurrently**.
- A round only begins once **every** contribution of the previous round has been acknowledged (`isCurrentRoundComplete`).
- `configuration.maximumRounds` must be an integer from 1 to 4. `RoundAdvanced` beyond it is rejected, and `decide` emits `CompleteDebate` instead.

## Events

All events carry `at` (ISO-8601). "Duplicate" below means the event is `ignored`.

| Event | Preconditions | Effects |
| --- | --- | --- |
| `SessionCreated` | No session exists. Topic non-empty (≤ 2000 chars). ≤ 20 constraints (≤ 1000 chars each). Unique participant ids, exactly one human, ≥ 2 providers. `maximumRounds` integer in 1–4. | Creates an `idle` session at round 1 (`independent-analysis`). Trims the topic and drops blank constraints. Duplicate if the same session id already exists. |
| `DebateStarted` | `idle` | → `running`. Duplicate if already `running`. |
| `ContributionRequested` | `running`. Round is the current round. Participant is a provider. No active (non-superseded) operation exists for that participant and round. `id` and `attempt` match `operationIdFor(session, round, participant, attempt)`. | Adds a `pending` operation. Duplicate if the id exists. |
| `ContributionDispatched` | `running`. Operation is `pending`. Every listed intervention exists. | Operation → `dispatched`. Listed interventions → `applied`, and the operation id is appended. Duplicate if the operation has already left `pending`. |
| `ContributionReceived` | Operation is `dispatched` or `uncertain`. Contribution id is unused. | Operation → `acknowledged`; adds a `Contribution`. Allowed in any status, so late results are reconciled. Duplicate if already acknowledged. Ignored if the operation is `failed` or `superseded`. Rejected if it is `pending`. |
| `ContributionFailed` | Operation is `dispatched` or `uncertain`. | Operation → `failed`. Session → `failed` (the first failure wins). Duplicate if already failed. Ignored if the operation is acknowledged or superseded. |
| `RoundAdvanced` | `running`. `toRound = currentRound + 1 ≤ maximumRounds`. Current round complete. Stopping policy says `continue`. | `currentRound` and `phase` advance. Duplicate if `toRound` is already current. |
| `PauseRequested` | `running` | → `pausing`. Duplicate if `pausing` or `paused`. |
| `DebatePaused` | `pausing` and no `dispatched` operations | → `paused` (`human-request`). Duplicate if already `paused`. |
| `HumanConstraintAdded` | `paused`. `allowHumanIntervention`. Content non-empty (≤ 1000 chars). At least one more provider request can still be dispatched (`canDispatchFurtherRequests`): not after the final permitted round is complete, because resuming would complete the debate and the constraint could never be applied. | Adds a `pending` intervention recording `addedDuringRound`. Duplicate if the id exists. |
| `DebateResumed` | `paused` and no `uncertain` operations | → `running`. Duplicate if already `running`. |
| `DebateCompleted` | `running`. `finalRound = currentRound`. Round complete. The stopping policy returns `complete` with the same reason. | → `completed`. Duplicate if already completed. |
| `RuntimeRecovered` | A session exists | Every `dispatched` operation → `uncertain`. `running` or `pausing` → `paused` (`runtime-restart`). Other statuses are unchanged. |
| `UncertainOperationReissued` | `paused`. Operation is `uncertain`. | Operation → `superseded`. After resume, `decide` requests attempt `n + 1`. Duplicate if already superseded. |

## Commands

| Command                | Produced when                                                      | Shell records            | Side effect                    |
| ---------------------- | ------------------------------------------------------------------ | ------------------------ | ------------------------------ |
| `RequestContribution`  | `running`, provider has no active operation in the current round   | `ContributionRequested`  | none                           |
| `DispatchContribution` | `running`, operation is `pending`                                  | `ContributionDispatched` | provider call, **after** persisting |
| `AdvanceRound`         | `running`, round complete, policy says continue                    | `RoundAdvanced`          | none                           |
| `CompleteDebate`       | `running`, round complete, policy says complete                    | `DebateCompleted`        | none                           |
| `ConfirmPause`         | `pausing`, nothing dispatched                                      | `DebatePaused`           | none                           |

`DispatchContribution` carries the full `ContributionRequest`, including the rendered prompt. The request is built **at dispatch time** from the current state, so constraints added while paused reach every request dispatched afterwards. That includes requests registered before the pause but not yet sent.

## Adaptive stopping policy

`evaluateStopping(session)` (`src/domain/stopping.ts`) runs once the current round is complete:

1. If `currentRound ≥ maximumRounds`, it returns **complete** (`maximum-rounds-reached`). This check is always enforced.
2. If the strategy is `fixed`, it returns continue.
3. If `currentRound < 2`, it returns continue. Independent analyses have not been examined by anyone yet.
4. If any human constraint is still `pending` (never sent), it returns continue, so the constraint reaches the participants.
5. If every provider participant's contribution in this round has an empty `assessment.materialIssues`, it returns **complete** (`early-convergence`).
6. Otherwise it returns continue.

The policy reads only the structured assessment attached to each contribution. It does not score reasoning quality or claim semantic understanding. In Phase 1, the assessments are scripted simulation data.

## Provider operations

```text
 pending ──► dispatched ──► acknowledged
               │    │
               │    └────► failed
               ▼
           uncertain ──► acknowledged   (late result reconciled)
               │    └──► failed
               ▼
           superseded                    (human approved a new attempt; late results discarded)
```

- **Stable identifiers.** `operationIdFor(sessionId, round, participantId, attempt)` is deterministic. Re-issuing creates a new attempt with a new id rather than reusing the old one.
- **Write-ahead.** The runner persists `ContributionDispatched` before calling the provider. After a restart, `pending` means the request was never sent and is safe to dispatch. `dispatched` means it may have been sent, so it becomes `uncertain`.
- **No automatic replay.** Uncertain operations block `resume`. The human must explicitly choose **Request again** (`UncertainOperationReissued`), which accepts that a real provider could receive the request twice.
- **No exactly-once claim.** Without an idempotency guarantee from the provider, ThirdMind only guarantees that it never re-sends *automatically*.

## Pause semantics

- `PauseRequested` stops all new scheduling immediately: no new requests, no dispatches, no round advancement.
- Already dispatched operations are not cancelled. Their results are recorded as they arrive.
- `DebatePaused` is confirmed only once nothing is in flight, so a paused session is always consistent.
- `resume` continues exactly where the engine stopped. Pending operations are dispatched with up-to-date prompts, and a completed round advances.

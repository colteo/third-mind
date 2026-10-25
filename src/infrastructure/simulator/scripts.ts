import type { ConvergenceAssessment, DebatePhase } from '../../domain';
import type { SimulationScenarioId } from './scenarios';

/**
 * Scripted viewpoints for the two simulated participants.
 *
 * The scripts are deliberately generic so they read sensibly for any topic.
 * They are test data, not an imitation of how GPT or Claude actually reason.
 */
export type SimulatedPersonaId = 'gpt' | 'claude';

export interface PhaseScript {
  /** `{topic}` is replaced with the (shortened) debate topic. */
  readonly position: string;
  readonly heading: string;
  readonly points: readonly string[];
}

export interface PersonaScript {
  readonly participantId: SimulatedPersonaId;
  readonly displayName: string;
  /** The real model this simulator stands in for. Used only in disclaimers. */
  readonly standsInFor: string;
  readonly phases: Readonly<Record<DebatePhase, PhaseScript>>;
  readonly assessments: Readonly<Record<SimulationScenarioId, Readonly<Record<DebatePhase, ConvergenceAssessment>>>>;
}

export const SHARED_AGREEMENTS = {
  pilot: 'Start with a reversible pilot rather than a full commitment.',
  gates: 'Define explicit success criteria and a rollback path before each stage.',
  review: "Review the pilot's evidence before deciding on wider adoption.",
} as const;

const GPT_ASSESSMENTS: Readonly<Record<DebatePhase, ConvergenceAssessment>> = {
  'independent-analysis': {
    materialIssues: ['No explicit success criteria have been defined yet.'],
    openQuestions: ['Which constraints are hard limits and which are preferences?'],
    agreements: [],
  },
  'cross-examination': {
    materialIssues: ['The opposing analysis does not separate evidenced risks from speculative ones.'],
    openQuestions: [],
    agreements: ['Failure modes must be identified before scaling up.'],
  },
  refinement: {
    materialIssues: ['The evidence threshold for moving beyond the pilot has not been agreed.'],
    openQuestions: [],
    agreements: [SHARED_AGREEMENTS.pilot, SHARED_AGREEMENTS.gates],
  },
  convergence: {
    materialIssues: [],
    openQuestions: ['How long should the pilot run before a decision is made?'],
    agreements: [SHARED_AGREEMENTS.pilot, SHARED_AGREEMENTS.gates, SHARED_AGREEMENTS.review],
  },
};

const CLAUDE_ASSESSMENTS: Readonly<Record<DebatePhase, ConvergenceAssessment>> = {
  'independent-analysis': {
    materialIssues: ['Failure modes and their reversibility have not been assessed.'],
    openQuestions: ['What evidence would change the decision?'],
    agreements: [],
  },
  'cross-examination': {
    materialIssues: ['The incremental plan assumes that early signals are representative of long-term outcomes.'],
    openQuestions: [],
    agreements: ['Waiting for complete certainty is not a viable strategy.'],
  },
  refinement: {
    materialIssues: ['Early metrics may not be sufficient evidence for full adoption.'],
    openQuestions: [],
    agreements: [SHARED_AGREEMENTS.pilot, SHARED_AGREEMENTS.gates],
  },
  convergence: {
    materialIssues: ['The evidence threshold for full adoption remains disputed.'],
    openQuestions: ['Who independently reviews the pilot evidence?'],
    agreements: [SHARED_AGREEMENTS.pilot, SHARED_AGREEMENTS.gates, SHARED_AGREEMENTS.review],
  },
};

const CONVERGED_REFINEMENT: ConvergenceAssessment = {
  materialIssues: [],
  openQuestions: ['How long should the pilot run before a decision is made?'],
  agreements: [SHARED_AGREEMENTS.pilot, SHARED_AGREEMENTS.gates, SHARED_AGREEMENTS.review],
};

export const PERSONA_SCRIPTS: Readonly<Record<SimulatedPersonaId, PersonaScript>> = {
  gpt: {
    participantId: 'gpt',
    displayName: 'GPT Simulator',
    standsInFor: 'GPT',
    phases: {
      'independent-analysis': {
        position:
          'Approach {topic} incrementally: take the smallest reversible step that produces real evidence, then expand deliberately.',
        heading: 'Key considerations',
        points: [
          'Feasibility: prefer options that can be delivered with existing capabilities.',
          'Time to value: a narrow first step surfaces real feedback early.',
          'Measurable checkpoints: agree go/no-go criteria before each expansion.',
        ],
      },
      'cross-examination': {
        position:
          'The risk-focused analysis is right to stress failure modes, but it risks postponing every decision until uncertainty disappears, which rarely happens.',
        heading: 'Challenges',
        points: [
          'Which of the listed risks are supported by evidence rather than conjecture?',
          'A staged rollout already limits the impact of most failure modes.',
        ],
      },
      refinement: {
        position: 'Keep the incremental plan, but add explicit risk gates and a rollback path to every stage.',
        heading: 'Revisions',
        points: [
          'Accepted: each stage needs a pre-agreed rollback path.',
          'Accepted: failure modes are listed before a stage starts, not after.',
          'Rejected: a complete upfront risk assessment before any step is taken.',
        ],
      },
      convergence: {
        position: 'Proceed with a reversible pilot governed by explicit success criteria and risk gates.',
        heading: 'Final recommendation',
        points: [
          'Run a time-boxed pilot with a defined rollback path.',
          'Decide on wider adoption only after reviewing the pilot evidence.',
        ],
      },
    },
    assessments: {
      'full-debate': GPT_ASSESSMENTS,
      'early-convergence': { ...GPT_ASSESSMENTS, refinement: CONVERGED_REFINEMENT },
      'provider-failure': GPT_ASSESSMENTS,
    },
  },
  claude: {
    participantId: 'claude',
    displayName: 'Claude Simulator',
    standsInFor: 'Claude',
    phases: {
      'independent-analysis': {
        position:
          'Treat {topic} as a decision under uncertainty: identify the failure modes and how reversible each option is before committing.',
        heading: 'Key considerations',
        points: [
          'Failure modes: list what could go wrong and how it would be detected.',
          'Reversibility: separate one-way decisions from easily reversible ones.',
          'Evidence quality: distinguish verified facts from assumptions.',
        ],
      },
      'cross-examination': {
        position:
          'The incremental plan is sensible, but it assumes that early signals are representative of long-term outcomes.',
        heading: 'Challenges',
        points: [
          'What would make an early success misleading?',
          'Who bears the cost if a "reversible" step turns out to be hard to undo?',
        ],
      },
      refinement: {
        position:
          'Support a staged approach, provided each stage has a defined rollback and an independent review of its evidence.',
        heading: 'Revisions',
        points: [
          'Accepted: waiting for complete certainty is not a viable strategy.',
          'Accepted: a staged rollout limits the impact of many failure modes.',
          'Rejected: treating early metrics as sufficient evidence for full adoption.',
        ],
      },
      convergence: {
        position:
          'Support a reversible pilot, while flagging that the evidence threshold for full adoption is still disputed.',
        heading: 'Final recommendation',
        points: [
          'Run the pilot with an independent review of its results.',
          'Agree the evidence threshold for full adoption before the pilot ends.',
        ],
      },
    },
    assessments: {
      'full-debate': CLAUDE_ASSESSMENTS,
      'early-convergence': { ...CLAUDE_ASSESSMENTS, refinement: CONVERGED_REFINEMENT },
      'provider-failure': CLAUDE_ASSESSMENTS,
    },
  },
};

/** Scenario-specific failures: which persona fails in which phase. */
export const SCRIPTED_FAILURES: Readonly<
  Record<SimulationScenarioId, { readonly persona: SimulatedPersonaId; readonly phase: DebatePhase } | null>
> = {
  'full-debate': null,
  'early-convergence': null,
  'provider-failure': { persona: 'claude', phase: 'cross-examination' },
};

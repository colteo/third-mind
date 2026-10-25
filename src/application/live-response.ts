import type { ConvergenceAssessment } from '../domain';

/**
 * Live responses are free text. The stopping policy needs a structured
 * assessment, so every live prompt asks the provider to end its answer with a
 * fenced block in this format. The block is removed from the stored content.
 */
export const ASSESSMENT_FENCE = 'thirdmind-assessment';

export const ASSESSMENT_FORMAT_INSTRUCTIONS = [
  '',
  `Finish your answer with exactly one fenced code block labelled ${ASSESSMENT_FENCE} that contains a JSON object with`,
  'three arrays of short strings: "materialIssues", "openQuestions" and "agreements". Example:',
  '```' + ASSESSMENT_FENCE,
  '{"materialIssues": [], "openQuestions": [], "agreements": []}',
  '```',
].join('\n');

/** Recorded when a response has no usable assessment, so a missing block can never end the debate early. */
export const MISSING_ASSESSMENT_ISSUE =
  'The response did not include a valid structured assessment, so convergence cannot be assumed.';

const MAX_ASSESSMENT_ITEMS = 20;
const MAX_ASSESSMENT_ITEM_LENGTH = 1000;

export interface ParsedLiveResponse {
  readonly content: string;
  readonly assessment: ConvergenceAssessment;
  readonly assessmentFound: boolean;
}

/** Pure. Uses the last assessment block in the text; never evaluates anything. */
export function parseLiveResponse(text: string): ParsedLiveResponse {
  const pattern = new RegExp('```' + ASSESSMENT_FENCE + '[^\\n]*\\n([\\s\\S]*?)```', 'g');
  let last: RegExpExecArray | null = null;
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    last = match;
  }
  const assessment = last === null ? null : parseAssessment(last[1] ?? '');
  if (last === null || assessment === null) {
    return {
      content: text.trim(),
      assessment: { materialIssues: [MISSING_ASSESSMENT_ISSUE], openQuestions: [], agreements: [] },
      assessmentFound: false,
    };
  }
  const content = (text.slice(0, last.index) + text.slice(last.index + last[0].length)).trim();
  return { content, assessment, assessmentFound: true };
}

function parseAssessment(json: string): ConvergenceAssessment | null {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const materialIssues = stringList(record.materialIssues);
  const openQuestions = stringList(record.openQuestions);
  const agreements = stringList(record.agreements);
  if (materialIssues === null || openQuestions === null || agreements === null) {
    return null;
  }
  return { materialIssues, openQuestions, agreements };
}

function stringList(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.length > MAX_ASSESSMENT_ITEMS) {
    return null;
  }
  const items: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') {
      return null;
    }
    const trimmed = item.trim();
    if (trimmed.length > 0) {
      items.push(trimmed.slice(0, MAX_ASSESSMENT_ITEM_LENGTH));
    }
  }
  return items;
}

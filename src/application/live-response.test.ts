import { describe, expect, it } from 'vitest';
import { MISSING_ASSESSMENT_ISSUE, parseLiveResponse } from './live-response';

const block = (json: string) => `\`\`\`thirdmind-assessment\n${json}\n\`\`\``;

describe('live response parsing', () => {
  it('extracts the structured assessment and removes it from the content', () => {
    const parsed = parseLiveResponse(
      `My position.\n\n${block('{"materialIssues": ["  Cost  "], "openQuestions": [], "agreements": ["Scope", ""]}')}`,
    );
    expect(parsed).toEqual({
      content: 'My position.',
      assessment: { materialIssues: ['Cost'], openQuestions: [], agreements: ['Scope'] },
      assessmentFound: true,
    });
  });

  it('uses the last assessment block', () => {
    const parsed = parseLiveResponse(
      `${block('{"materialIssues": ["old"], "openQuestions": [], "agreements": []}')}\nText\n${block('{"materialIssues": [], "openQuestions": [], "agreements": []}')}`,
    );
    expect(parsed.assessment.materialIssues).toEqual([]);
  });

  it.each([
    ['no block', 'Just text.'],
    ['invalid JSON', `Text\n${block('{not json')}`],
    ['missing field', `Text\n${block('{"materialIssues": [], "agreements": []}')}`],
    ['non-string item', `Text\n${block('{"materialIssues": [1], "openQuestions": [], "agreements": []}')}`],
  ])('treats a response with %s conservatively', (_name, text) => {
    const parsed = parseLiveResponse(text);
    expect(parsed.assessmentFound).toBe(false);
    expect(parsed.assessment.materialIssues).toEqual([MISSING_ASSESSMENT_ISSUE]);
  });
});

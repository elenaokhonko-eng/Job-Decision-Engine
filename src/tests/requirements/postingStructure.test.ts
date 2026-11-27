import { describe, expect, it } from 'vitest';
import { parsePosting } from '../../requirements/postingStructure.js';
import { classifyPostingItem, detectAlternatives } from '../../requirements/postingItemRequirements.js';
import { requirementOwnText, POSTING_ITEM_EXTRACTION } from '../../requirements/requirementKinds.js';
import { buildRequirementInputText } from '../../embeddings/inputBuilder.js';

describe('parsePosting', () => {
  it('keeps exact text and offsets for bulleted items, with CRLF line endings', () => {
    const text = ['Requirements:', '• Strong SQL', '• Clear communication skills'].join('\r\n');
    const posting = parsePosting(text);
    expect(posting.hasRequirementsSection).toBe(true);
    expect(posting.items.map((i) => i.text)).toEqual(['Strong SQL', 'Clear communication skills']);
    for (const item of posting.items) {
      expect(text.slice(item.start, item.end)).toBe(item.text);
      expect(item.section).toBe('REQUIREMENTS');
    }
  });

  it('reads headings written as markdown or bold and numbered or dashed bullets', () => {
    const text = ['**Responsibilities**', '1. Own the platform roadmap end to end', '## What you bring', '- Experience running large programmes'].join('\n');
    const posting = parsePosting(text);
    expect(posting.items.map((i) => [i.section, i.text])).toEqual([
      ['RESPONSIBILITIES', 'Own the platform roadmap end to end'],
      ['REQUIREMENTS', 'Experience running large programmes'],
    ]);
  });

  it('treats plain sentences inside a section as items but ignores prose before any heading', () => {
    const text = [
      'We are a fast growing company with big ambitions.',
      'Qualifications',
      'You have led delivery of complex data programmes. You communicate clearly with executives.',
    ].join('\n');
    const posting = parsePosting(text);
    expect(posting.items.map((i) => i.text)).toEqual([
      'You have led delivery of complex data programmes.',
      'You communicate clearly with executives.',
    ]);
    for (const item of posting.items) expect(text.slice(item.start, item.end)).toBe(item.text);
  });

  it('flags bullets that sit under no heading as unsectioned so the AI fallback can be considered', () => {
    const posting = parsePosting(['- Build data pipelines', '- Own the delivery roadmap'].join('\n'));
    expect(posting.hasRequirementsSection).toBe(false);
    expect(posting.items.every((i) => i.section === 'UNSECTIONED')).toBe(true);
  });

  it('does not mistake a sentence that starts with a heading word for a heading', () => {
    const posting = parsePosting(['Requirements', 'Preferred experience with Kafka in production environments.'].join('\n'));
    expect(posting.items.map((i) => i.text)).toEqual(['Preferred experience with Kafka in production environments.']);
  });

  it('drops duplicate items and skips company and benefits sections', () => {
    const posting = parsePosting(
      ['Requirements', '- Strong SQL', '- strong sql', 'Benefits', '- Free gym membership', 'Responsibilities', '- Run the weekly planning cycle'].join('\n'),
    );
    expect(posting.items.map((i) => i.text)).toEqual(['Strong SQL', 'Run the weekly planning cycle']);
  });
});

describe('parsePosting on flattened text (no line breaks)', () => {
  const flat =
    'We are hiring a programme lead. Responsibilities: Lead the delivery of the data platform roadmap. Partner with product to set priorities. ' +
    'Requirements: Strong SQL and Python • Experience with cloud platforms • Clear written communication ' +
    'Nice to have: Familiarity with Snowflake. About Us We are a growing company and offer free lunch.';

  it('finds inline headings and glyph bullets and keeps exact offsets into the original text', () => {
    const posting = parsePosting(flat);
    expect(posting.hasRequirementsSection).toBe(true);
    expect(posting.items.map((i) => [i.section, i.text])).toEqual([
      ['RESPONSIBILITIES', 'Lead the delivery of the data platform roadmap.'],
      ['RESPONSIBILITIES', 'Partner with product to set priorities.'],
      ['REQUIREMENTS', 'Strong SQL and Python'],
      ['REQUIREMENTS', 'Experience with cloud platforms'],
      ['REQUIREMENTS', 'Clear written communication'],
      ['NICE_TO_HAVE', 'Familiarity with Snowflake.'],
    ]);
    for (const item of posting.items) expect(flat.slice(item.start, item.end)).toBe(item.text);
  });

  it('stops at an inline company or benefits heading written without a colon', () => {
    const posting = parsePosting(flat);
    expect(posting.items.some((i) => /growing company|free lunch/.test(i.text))).toBe(false);
  });

  it('does not treat a capitalised phrase with a colon in the middle of a sentence as a heading', () => {
    const posting = parsePosting('Requirements: You will use tools such as Python: and SQL daily for reporting work.');
    expect(posting.items.map((i) => i.section)).toEqual(['REQUIREMENTS']);
  });

  it('splits a heading that flattening glued to the next sentence, with exact offsets', () => {
    const text =
      'What We Are Looking ForDeep grounding in model oversight for insurance carriers. ' +
      'Interview ProcessOur process is designed to move fast and is described below in detail.';
    const posting = parsePosting(text);
    expect(posting.hasRequirementsSection).toBe(true);
    expect(posting.items.map((i) => i.text)).toEqual(['Deep grounding in model oversight for insurance carriers.']);
    for (const item of posting.items) expect(text.slice(item.start, item.end)).toBe(item.text);
  });

  it('does not treat a "Location:" line as a company section that hides the role description', () => {
    const text =
      'Globex Principal Engineer Location: Singapore / Remote We are seeking a hands-on engineer to architect and build distributed training pipelines.';
    const posting = parsePosting(text);
    expect(posting.items).toHaveLength(1);
    expect(posting.items[0].text).toContain('We are seeking a hands-on engineer to architect and build distributed training pipelines.');
    expect(text.slice(posting.items[0].start, posting.items[0].end)).toBe(posting.items[0].text);
  });

  it('keeps only requirement-like sentences when there is no heading at all', () => {
    const text =
      'Our company was founded in 2010 and has offices around the world. You will own the data platform roadmap. ' +
      'We love puppies and sunny days at the beach with friends.';
    const posting = parsePosting(text);
    expect(posting.hasRequirementsSection).toBe(false);
    expect(posting.items.map((i) => [i.section, i.text])).toEqual([['UNSECTIONED', 'You will own the data platform roadmap.']]);
  });
});

describe('classifyPostingItem', () => {
  it.each([
    ['5 years of experience in data engineering', 'REQUIREMENTS', 'YEARS'],
    ["Master's degree in a quantitative field", 'REQUIREMENTS', 'DEGREE'],
    ['AWS Certified Solutions Architect', 'REQUIREMENTS', 'CERTIFICATE'],
    ['Strong SQL and Python', 'REQUIREMENTS', 'TOOL'],
    ['Excellent stakeholder management', 'REQUIREMENTS', 'SKILL'],
    ['Lead the delivery of the data roadmap', 'RESPONSIBILITIES', 'RESPONSIBILITY'],
    ['Strong SQL', 'RESPONSIBILITIES', 'RESPONSIBILITY'],
  ] as const)('classifies "%s" in %s as %s', (text, section, expected) => {
    expect(classifyPostingItem(text, section)).toBe(expected);
  });
});

describe('detectAlternatives', () => {
  it('finds equivalent-experience and related-field escape hatches', () => {
    expect(detectAlternatives('Degree in computer science or a related field')).toMatchObject({ related_field: true, equivalent_experience: false });
    expect(detectAlternatives('Bachelor degree or equivalent practical experience')).toMatchObject({ equivalent_experience: true });
    expect(detectAlternatives('Strong SQL')).toEqual({ equivalent_experience: false, related_field: false, options: [] });
  });

  it('splits short "A, B or C" and "A / B" option lists but not long sentences', () => {
    expect(detectAlternatives('Experience with Python, Java or Scala').options).toEqual(['Python', 'Java', 'Scala']);
    expect(detectAlternatives('Terraform / Ansible').options).toEqual(['Terraform', 'Ansible']);
    expect(detectAlternatives('Work closely with the product team or with the design team on the shared roadmap').options).toEqual([]);
  });
});

describe('requirement text used for matching', () => {
  const item = {
    requirement_type: 'CUSTOM',
    requirement_text: 'Strong SQL and Python',
    quote_text: 'Strong SQL and Python',
    structured_value: { extraction: POSTING_ITEM_EXTRACTION, item_class: 'TOOL', section: 'REQUIREMENTS' },
  };

  it('embeds a posting item as its own sentence, with no type label, quote prefix or JSON', () => {
    expect(requirementOwnText(item)).toBe('Strong SQL and Python');
    expect(buildRequirementInputText(item)).toBe('Strong SQL and Python');
  });

  it('keeps the previous composition for older requirements', () => {
    const legacy = {
      requirement_type: 'DOMAIN',
      requirement_text: 'Role includes a target technical domain requirement.',
      quote_text: 'machine learning',
      structured_value: { domain_key: 'MACHINE_LEARNING' },
    };
    expect(requirementOwnText(legacy)).toBeNull();
    expect(buildRequirementInputText(legacy)).toBe(
      'DOMAIN: Role includes a target technical domain requirement. Quote: machine learning Structured: {"domain_key":"MACHINE_LEARNING"}',
    );
  });
});

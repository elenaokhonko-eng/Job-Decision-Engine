import { describe, expect, it } from 'vitest';

import { escapeMarkdownTableCell } from '../../profile/markdownEscaping.js';

describe('escapeMarkdownTableCell', () => {
  it('escapes backslashes, pipes, and inline Markdown delimiters', () => {
    expect(escapeMarkdownTableCell('a\\b|`code`')).toBe('a\\\\b\\|\\`code\\`');
  });

  it('flattens line breaks and encodes raw HTML delimiters', () => {
    expect(escapeMarkdownTableCell('first\nsecond <tag>')).toBe('first second &lt;tag&gt;');
  });
});

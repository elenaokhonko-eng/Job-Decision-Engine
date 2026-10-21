export function escapeMarkdownTableCell(value: string): string {
  return value
    .replace(/[\r\n]+/g, ' ')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/([\\`*_{}\[\]()#+.!|>~-])/g, '\\$1');
}

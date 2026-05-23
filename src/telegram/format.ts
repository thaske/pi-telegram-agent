export interface FormattedTelegramText {
  text: string;
  parseMode?: "HTML";
}

function htmlEscape(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function stash(
  text: string,
  pattern: RegExp,
  replacements: string[],
  render: (...groups: string[]) => string,
): string {
  return text.replace(pattern, (...args) => {
    const groups = args.slice(1, -2) as string[];
    const token = `\u0000${replacements.length}\u0000`;
    replacements.push(render(...groups));
    return token;
  });
}

export function formatTelegramText(text: string): FormattedTelegramText {
  const replacements: string[] = [];
  let formatted = text;

  // Protect code blocks and inline code from further processing
  formatted = stash(
    formatted,
    /```(?:[a-zA-Z0-9_-]+)?\n?([\s\S]*?)```/g,
    replacements,
    (code) => `<pre>${htmlEscape(code.trim())}</pre>`,
  );
  formatted = stash(
    formatted,
    /`([^`\n]+)`/g,
    replacements,
    (code) => `<code>${htmlEscape(code)}</code>`,
  );
  formatted = htmlEscape(formatted);

  // Block-level formatting
  formatted = formatted.replace(
    /^#{1,6}\s+(.+)$/gm,
    (_match, heading: string) => `<b>${heading}</b>`,
  );

  // Links
  formatted = formatted.replace(
    /\[([^\]\n]+)]\((https?:\/\/[^)\s]+)\)/g,
    '<a href="$2">$1</a>',
  );

  // Inline formatting — stash results so subsequent regexes can't corrupt them
  formatted = stash(
    formatted,
    /\*\*([^*\n][\s\S]*?[^*\n])\*\*/g,
    replacements,
    (content) => `<b>${content}</b>`,
  );
  formatted = stash(
    formatted,
    /__([^_\n][\s\S]*?[^_\n])__/g,
    replacements,
    (content) => `<b>${content}</b>`,
  );
  formatted = stash(
    formatted,
    /(^|[^*])\*([^*\n][^*\n]*?[^*\n])\*(?!\*)/g,
    replacements,
    (before, content) => `${before}<i>${content}</i>`,
  );
  formatted = stash(
    formatted,
    /(^|[^_])_([^_\n][^_\n]*?[^_\n])_(?!_)/g,
    replacements,
    (before, content) => `${before}<i>${content}</i>`,
  );

  // Restore all stashed items
  formatted = formatted.replace(/\u0000(\d+)\u0000/g, (_match, index: string) =>
    replacements[Number(index)] ?? "",
  );

  return formatted === text ? { text } : { text: formatted, parseMode: "HTML" };
}

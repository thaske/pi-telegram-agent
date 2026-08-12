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

const TOKEN_PATTERN = /\u0000(\d+)\u0000/g;

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
    /\*\*(?!\s)([\s\S]+?)(?<!\s)\*\*/g,
    replacements,
    (content) => `<b>${content}</b>`,
  );
  formatted = stash(
    formatted,
    /__(?!\s)([\s\S]+?)(?<!\s)__/g,
    replacements,
    (content) => `<b>${content}</b>`,
  );
  formatted = stash(
    formatted,
    /(^|[^*])\*(?!\s)([^*\n]+?)(?<!\s)\*(?!\*)/g,
    replacements,
    (before, content) => `${before}<i>${content}</i>`,
  );
  formatted = stash(
    formatted,
    /(^|[^_\w])_(?!\s)([^_\n]+?)(?<!\s)_(?![\w_])/g,
    replacements,
    (before, content) => `${before}<i>${content}</i>`,
  );

  // Restore all stashed items. Replacements can themselves contain tokens (for
  // example inline code nested inside bold), so expand until none remain.
  for (let pass = 0; pass <= replacements.length; pass++) {
    if (!formatted.includes("\u0000")) break;
    formatted = formatted.replace(TOKEN_PATTERN, (_match, index: string) =>
      replacements[Number(index)] ?? "",
    );
  }

  return formatted === text ? { text } : { text: formatted, parseMode: "HTML" };
}

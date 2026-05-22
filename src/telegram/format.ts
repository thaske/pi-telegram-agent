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

  formatted = formatted.replace(
    /^#{1,6}\s+(.+)$/gm,
    (_match, heading: string) => `<b>${heading}</b>`,
  );
  formatted = formatted.replace(
    /\*\*([^*\n][\s\S]*?[^*\n])\*\*/g,
    "<b>$1</b>",
  );
  formatted = formatted.replace(
    /__([^_\n][\s\S]*?[^_\n])__/g,
    "<b>$1</b>",
  );
  formatted = formatted.replace(
    /(^|[^*])\*([^*\n][^*\n]*?[^*\n])\*(?!\*)/g,
    "$1<i>$2</i>",
  );
  formatted = formatted.replace(
    /(^|[^_])_([^_\n][^_\n]*?[^_\n])_(?!_)/g,
    "$1<i>$2</i>",
  );
  formatted = formatted.replace(
    /\[([^\]\n]+)]\((https?:\/\/[^)\s]+)\)/g,
    '<a href="$2">$1</a>',
  );

  formatted = formatted.replace(/\u0000(\d+)\u0000/g, (_match, index: string) =>
    replacements[Number(index)] ?? "",
  );

  return formatted === text ? { text } : { text: formatted, parseMode: "HTML" };
}

const INLINE_MATH_START = "\\(";
const INLINE_MATH_END = "\\)";
const BLOCK_MATH_START = "\\[";
const BLOCK_MATH_END = "\\]";

/**
 * Telegram rich markdown supports $...$, $$...$$, and rich HTML math tags, but
 * not MathJax's \(...\) / \[...\] delimiters. Convert those delimiters while
 * leaving code spans and fenced code blocks untouched.
 */
export function toTelegramRichMarkdown(text: string): string {
  let output = "";
  let index = 0;

  while (index < text.length) {
    const fencedCodeEnd = getFencedCodeEnd(text, index);
    if (fencedCodeEnd !== undefined) {
      output += text.slice(index, fencedCodeEnd);
      index = fencedCodeEnd;
      continue;
    }

    const inlineCodeEnd = getInlineCodeEnd(text, index);
    if (inlineCodeEnd !== undefined) {
      output += text.slice(index, inlineCodeEnd);
      index = inlineCodeEnd;
      continue;
    }

    if (text.startsWith(BLOCK_MATH_START, index)) {
      const end = text.indexOf(BLOCK_MATH_END, index + BLOCK_MATH_START.length);
      if (end !== -1) {
        output += `<tg-math-block>${escapeMathHtml(
          text.slice(index + BLOCK_MATH_START.length, end),
        )}</tg-math-block>`;
        index = end + BLOCK_MATH_END.length;
        continue;
      }
    }

    if (text.startsWith(INLINE_MATH_START, index)) {
      const end = text.indexOf(INLINE_MATH_END, index + INLINE_MATH_START.length);
      if (end !== -1) {
        output += `<tg-math>${escapeMathHtml(
          text.slice(index + INLINE_MATH_START.length, end),
        )}</tg-math>`;
        index = end + INLINE_MATH_END.length;
        continue;
      }
    }

    output += text[index];
    index += 1;
  }

  return output;
}

function getFencedCodeEnd(text: string, index: number): number | undefined {
  const markerChar = text[index];
  if (markerChar !== "`" && markerChar !== "~") return undefined;

  const markerLength = countRepeated(text, index, markerChar);
  if (markerLength < 3) return undefined;

  const marker = markerChar.repeat(markerLength);
  const close = text.indexOf(marker, index + markerLength);
  return close === -1 ? text.length : close + markerLength;
}

function getInlineCodeEnd(text: string, index: number): number | undefined {
  if (text[index] !== "`") return undefined;

  const markerLength = countRepeated(text, index, "`");
  if (markerLength >= 3) return undefined;

  const marker = "`".repeat(markerLength);
  const close = text.indexOf(marker, index + markerLength);
  return close === -1 ? undefined : close + markerLength;
}

function countRepeated(text: string, index: number, char: string): number {
  let length = 0;
  while (text[index + length] === char) length += 1;
  return length;
}

function escapeMathHtml(expression: string): string {
  return expression
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

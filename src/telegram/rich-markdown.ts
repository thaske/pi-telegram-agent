const INLINE_MATH_START = "\\(";
const INLINE_MATH_END = "\\)";
const BLOCK_MATH_START = "\\[";
const BLOCK_MATH_END = "\\]";
const DOLLAR_ENTITY = "&#36;";

/**
 * Telegram rich markdown supports $...$, $$...$$, and rich HTML math tags, but
 * not MathJax's \(...\) / \[...\] delimiters. Convert those delimiters while
 * leaving code spans and fenced code blocks untouched. Literal currency dollars
 * are encoded as an HTML entity so separate prices cannot become one math span.
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

    if (text[index] === "$") {
      const mathEnd = getDollarMathEnd(text, index);
      if (mathEnd !== undefined) {
        output += text.slice(index, mathEnd);
        index = mathEnd;
      } else {
        const dollarLength = countRepeated(text, index, "$");
        output += DOLLAR_ENTITY.repeat(dollarLength);
        index += dollarLength;
      }
      continue;
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

/**
 * Return the end of a dollar-delimited math expression. A dollar sign before
 * a digit is treated as currency, not math, which covers prices such as
 * `$200` and prevents a later price from closing the expression.
 */
function getDollarMathEnd(text: string, index: number): number | undefined {
  const dollarLength = countRepeated(text, index, "$");
  if (dollarLength >= 2) {
    const close = text.indexOf("$$", index + dollarLength);
    return close === -1 ? undefined : close + 2;
  }

  const first = text[index + 1];
  if (!first || /\s|\d/.test(first)) return undefined;

  for (let cursor = index + 1; cursor < text.length; cursor += 1) {
    if (text[cursor] !== "$" || text[cursor - 1] === "\\") continue;
    if (countRepeated(text, cursor, "$") !== 1) continue;
    if (/\s/.test(text[cursor - 1] ?? "")) continue;
    return cursor + 1;
  }

  return undefined;
}

function escapeMathHtml(expression: string): string {
  return expression
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

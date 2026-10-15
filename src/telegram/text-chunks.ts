import { MAX_MESSAGE_LENGTH } from "../constants";
import { chunkParagraphs } from "../utils";
import { formatTelegramText } from "./format";

/** Each returned chunk fits one physical legacy message, including HTML expansion. */
export function legacyTextChunks(text: string): string[] {
  const chunks: string[] = [];
  for (const rawChunk of chunkParagraphs(text)) {
    let remaining = rawChunk;
    while (remaining) {
      if (formatTelegramText(remaining).text.length <= MAX_MESSAGE_LENGTH) {
        chunks.push(remaining);
        break;
      }
      let low = 1;
      let high = Math.min(remaining.length, MAX_MESSAGE_LENGTH);
      let splitAt = 0;
      while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        if (formatTelegramText(remaining.slice(0, middle)).text.length <= MAX_MESSAGE_LENGTH) {
          splitAt = middle;
          low = middle + 1;
        } else high = middle - 1;
      }
      if (splitAt === 0) splitAt = 1;
      // Never split a UTF-16 surrogate pair across Telegram requests.
      if (/[\uD800-\uDBFF]/.test(remaining[splitAt - 1]) && /[\uDC00-\uDFFF]/.test(remaining[splitAt])) splitAt -= 1;
      chunks.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt);
    }
  }
  return chunks.length ? chunks : [""];
}

import { expect, test } from "bun:test";

import { MAX_MESSAGE_LENGTH } from "../src/constants";
import { formatTelegramText } from "../src/telegram/format";
import { legacyTextChunks } from "../src/telegram/text-chunks";

test("physical text chunks account for HTML expansion without losing visible text", () => {
  const text = "<&>".repeat(4000);
  const chunks = legacyTextChunks(text);
  expect(chunks.join("")).toBe(text);
  expect(chunks.every((chunk) => formatTelegramText(chunk).text.length <= MAX_MESSAGE_LENGTH)).toBe(true);
});

test("physical chunks preserve surrogate pairs at raw and HTML-expanded boundaries", () => {
  for (const text of ["a".repeat(4095) + "😀z", "&".repeat(817) + "😀" + "&".repeat(1000)]) {
    const chunks = legacyTextChunks(text);
    expect(chunks.join("")).toBe(text);
    expect(chunks.every((chunk) => !/[\uD800-\uDFFF]/u.test(chunk))).toBe(true);
    expect(chunks.every((chunk) => formatTelegramText(chunk).text.length <= MAX_MESSAGE_LENGTH)).toBe(true);
  }
});

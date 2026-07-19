import { describe, expect, test } from "bun:test";

import { toTelegramRichMarkdown } from "../src/telegram/rich-markdown";

describe("Telegram rich Markdown conversion", () => {
  test("protects separate currency amounts from math parsing", () => {
    expect(toTelegramRichMarkdown("TMPL costs $200/mo or $215 month-to-month.")).toBe(
      "TMPL costs &#36;200/mo or &#36;215 month-to-month.",
    );
  });

  test("preserves dollar-delimited math", () => {
    expect(toTelegramRichMarkdown("The result is $x^2$ and $$x + y$$.")).toBe(
      "The result is $x^2$ and $$x + y$$.",
    );
  });

  test("does not alter currency inside code", () => {
    expect(toTelegramRichMarkdown("Use `$200` or:\n\n```\n$215\n```"))
      .toBe("Use `$200` or:\n\n```\n$215\n```");
  });
});

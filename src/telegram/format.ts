import { MAX_MESSAGE_LENGTH } from "../constants.js";
import { chunkParagraphs } from "../utils.js";

export interface FormattedTelegramText {
  text: string;
  parseMode?: "HTML";
}

type ParsedTable = {
  end: number;
  rows: string[][];
  align: Array<"left" | "right" | "center">;
};

function htmlEscape(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function looksLikeTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.includes("|") && trimmed.split("|").length >= 3;
}

function splitRow(line: string): string[] {
  const trimmed = line.trim();
  const withoutEdges = trimmed.replace(/^\|/u, "").replace(/\|$/u, "");
  return withoutEdges.split("|").map((cell) => cell.trim());
}

function parseSeparator(line: string): Array<"left" | "right" | "center"> | undefined {
  if (!looksLikeTableRow(line)) return undefined;
  const cells = splitRow(line);
  if (!cells.length) return undefined;
  const align = cells.map((cell) => {
    if (!/^:?-{3,}:?$/u.test(cell.replaceAll(" ", ""))) return undefined;
    const compact = cell.replaceAll(" ", "");
    if (compact.startsWith(":") && compact.endsWith(":")) return "center";
    if (compact.endsWith(":")) return "right";
    return "left";
  });
  if (align.some((value) => value === undefined)) return undefined;
  return align as Array<"left" | "right" | "center">;
}

function parseTable(lines: string[], start: number): ParsedTable | undefined {
  if (!looksLikeTableRow(lines[start] ?? "")) return undefined;
  const align = parseSeparator(lines[start + 1] ?? "");
  if (!align) return undefined;

  const rows = [splitRow(lines[start]!)];
  let end = start + 2;
  while (end < lines.length && looksLikeTableRow(lines[end]!)) {
    rows.push(splitRow(lines[end]!));
    end += 1;
  }
  if (rows.length < 1) return undefined;
  return { end, rows, align };
}

function padCell(
  value: string,
  width: number,
  align: "left" | "right" | "center",
): string {
  const extra = Math.max(0, width - value.length);
  if (align === "right") return `${" ".repeat(extra)}${value}`;
  if (align === "center") {
    const left = Math.floor(extra / 2);
    return `${" ".repeat(left)}${value}${" ".repeat(extra - left)}`;
  }
  return `${value}${" ".repeat(extra)}`;
}

function renderTable(rows: string[][], align: Array<"left" | "right" | "center">): string {
  const columnCount = Math.max(align.length, ...rows.map((row) => row.length));
  const normalizedRows = rows.map((row) =>
    Array.from({ length: columnCount }, (_, index) => row[index] ?? ""),
  );
  const widths = Array.from({ length: columnCount }, (_, index) =>
    Math.max(3, ...normalizedRows.map((row) => row[index]!.length)),
  );
  const normalizedAlign = Array.from(
    { length: columnCount },
    (_, index) => align[index] ?? "left",
  );
  const separator = widths.map((width) => "-".repeat(width));
  const renderedRows = [normalizedRows[0]!, separator, ...normalizedRows.slice(1)].map(
    (row, rowIndex) =>
      `| ${row
        .map((cell, index) =>
          padCell(cell, widths[index]!, rowIndex === 1 ? "left" : normalizedAlign[index]!),
        )
        .join(" | ")} |`,
  );
  return renderedRows.join("\n");
}

export function formatTelegramText(text: string): FormattedTelegramText {
  const lines = text.split("\n");
  const output: string[] = [];
  let changed = false;

  for (let index = 0; index < lines.length; ) {
    const table = parseTable(lines, index);
    if (!table) {
      output.push(htmlEscape(lines[index]!));
      index += 1;
      continue;
    }

    changed = true;
    output.push(`<pre>${htmlEscape(renderTable(table.rows, table.align))}</pre>`);
    index = table.end;
  }

  if (!changed) return { text };
  return { text: output.join("\n"), parseMode: "HTML" };
}

function chunkPreBlock(preBlock: string): FormattedTelegramText[] {
  const content = preBlock.replace(/^<pre>/u, "").replace(/<\/pre>$/u, "");
  const lines = content.split("\n");
  const chunks: FormattedTelegramText[] = [];
  let current: string[] = [];
  const flush = () => {
    if (!current.length) return;
    chunks.push({ text: `<pre>${current.join("\n")}</pre>`, parseMode: "HTML" });
    current = [];
  };
  for (const line of lines) {
    const candidate = [...current, line];
    if (`<pre>${candidate.join("\n")}</pre>`.length <= MAX_MESSAGE_LENGTH) {
      current = candidate;
      continue;
    }
    flush();
    if (`<pre>${line}</pre>`.length <= MAX_MESSAGE_LENGTH) current = [line];
    else {
      for (let start = 0; start < line.length; start += MAX_MESSAGE_LENGTH - 32)
        chunks.push({
          text: `<pre>${line.slice(start, start + MAX_MESSAGE_LENGTH - 32)}</pre>`,
          parseMode: "HTML",
        });
    }
  }
  flush();
  return chunks;
}

export function chunkFormattedTelegramText(text: string): FormattedTelegramText[] {
  const formatted = formatTelegramText(text);
  if (!formatted.parseMode)
    return chunkParagraphs(text).map((chunk) => ({ text: chunk }));
  if (formatted.text.length <= MAX_MESSAGE_LENGTH) return [formatted];

  const chunks: FormattedTelegramText[] = [];
  const preRegex = /<pre>[\s\S]*?<\/pre>/gu;
  let cursor = 0;
  for (const match of formatted.text.matchAll(preRegex)) {
    const index = match.index ?? 0;
    const before = formatted.text.slice(cursor, index);
    if (before.trim())
      chunks.push(
        ...chunkParagraphs(before).map((chunk) => ({
          text: chunk,
          parseMode: "HTML" as const,
        })),
      );
    chunks.push(...chunkPreBlock(match[0]));
    cursor = index + match[0].length;
  }
  const after = formatted.text.slice(cursor);
  if (after.trim())
    chunks.push(
      ...chunkParagraphs(after).map((chunk) => ({
        text: chunk,
        parseMode: "HTML" as const,
      })),
    );
  return chunks.length ? chunks : [formatted];
}

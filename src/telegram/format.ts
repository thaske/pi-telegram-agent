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

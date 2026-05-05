import { BatchUpdateRequest } from "./types";

// Count Unicode code points, not UTF-16 code units.
// Google Docs indexes are code-point offsets; JS .length gives UTF-16 units,
// which differ for supplementary characters (emoji, CJK ext-B, etc.).
function codePointLength(s: string): number {
  return [...s].length;
}

interface InlineStyle {
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
}

interface FormattingSpan {
  start: number;
  end: number;
  style: InlineStyle;
}

// Processes inline markdown within a single line, returning plain text and
// a list of style spans with code-point offsets relative to the start of that text.
// Handles: **bold**, *italic*, ***bold-italic***, `code`, \* escape.
// Nested styles (e.g. **bold *and italic* bold**) are supported one level deep.
function processInlineFormatting(input: string): { text: string; formatting: FormattingSpan[] } {
  const formatting: FormattingSpan[] = [];
  let result = '';
  let i = 0;

  while (i < input.length) {
    // Backslash escape: \* \` \\
    if (input[i] === '\\' && i + 1 < input.length && '*`\\'.includes(input[i + 1])) {
      result += input[i + 1];
      i += 2;
      continue;
    }

    // Bold-italic: ***text***
    if (input[i] === '*' && input[i + 1] === '*' && input[i + 2] === '*') {
      const closeIdx = input.indexOf('***', i + 3);
      if (closeIdx !== -1) {
        const inner = input.slice(i + 3, closeIdx);
        const offset = codePointLength(result);
        const { text: innerText, formatting: innerFmt } = processInlineFormatting(inner);
        result += innerText;
        const end = codePointLength(result);
        formatting.push({ start: offset, end, style: { bold: true, italic: true } });
        for (const f of innerFmt) {
          formatting.push({ start: offset + f.start, end: offset + f.end, style: f.style });
        }
        i = closeIdx + 3;
        continue;
      }
    }

    // Bold: **text**
    if (input[i] === '*' && input[i + 1] === '*') {
      const closeIdx = input.indexOf('**', i + 2);
      if (closeIdx !== -1) {
        const inner = input.slice(i + 2, closeIdx);
        const offset = codePointLength(result);
        const { text: innerText, formatting: innerFmt } = processInlineFormatting(inner);
        result += innerText;
        const end = codePointLength(result);
        formatting.push({ start: offset, end, style: { bold: true } });
        for (const f of innerFmt) {
          formatting.push({ start: offset + f.start, end: offset + f.end, style: f.style });
        }
        i = closeIdx + 2;
        continue;
      }
    }

    // Italic: *text*
    if (input[i] === '*') {
      const closeIdx = input.indexOf('*', i + 1);
      if (closeIdx !== -1) {
        const inner = input.slice(i + 1, closeIdx);
        const offset = codePointLength(result);
        const { text: innerText, formatting: innerFmt } = processInlineFormatting(inner);
        result += innerText;
        const end = codePointLength(result);
        formatting.push({ start: offset, end, style: { italic: true } });
        for (const f of innerFmt) {
          formatting.push({ start: offset + f.start, end: offset + f.end, style: f.style });
        }
        i = closeIdx + 1;
        continue;
      }
    }

    // Code span: `code` — no recursive formatting inside code spans
    if (input[i] === '`') {
      const closeIdx = input.indexOf('`', i + 1);
      if (closeIdx !== -1) {
        const offset = codePointLength(result);
        result += input.slice(i + 1, closeIdx);
        formatting.push({ start: offset, end: codePointLength(result), style: { code: true } });
        i = closeIdx + 1;
        continue;
      }
    }

    result += input[i];
    i++;
  }

  return { text: result, formatting };
}

// Returns true for markdown table separator rows like | --- | :---: | ----: |
function isSeparatorRow(line: string): boolean {
  return /^\|(?:[ \t]*:?-+:?[ \t]*\|)+$/.test(line.trim());
}

function parsePipeRow(line: string): string[] {
  return line.split('|').slice(1, -1).map(cell => cell.trim());
}

// Emit updateTextStyle requests for a set of inline formatting spans.
// Positions are absolute document indices (cellIndex + span offset).
function emitInlineStyleRequests(
  formatting: FormattingSpan[],
  baseIndex: number,
  out: BatchUpdateRequest[]
): void {
  for (const fmt of formatting) {
    const { code, bold, italic } = fmt.style;
    if (code) {
      out.push({
        updateTextStyle: {
          range: { startIndex: baseIndex + fmt.start, endIndex: baseIndex + fmt.end },
          textStyle: { weightedFontFamily: { fontFamily: "Courier New", weight: 400 } },
          fields: "weightedFontFamily",
        },
      });
    } else {
      const textStyle: { bold?: boolean; italic?: boolean } = {};
      const fields: string[] = [];
      if (bold)   { textStyle.bold   = true; fields.push("bold"); }
      if (italic) { textStyle.italic = true; fields.push("italic"); }
      if (fields.length > 0) {
        out.push({
          updateTextStyle: {
            range: { startIndex: baseIndex + fmt.start, endIndex: baseIndex + fmt.end },
            textStyle,
            fields: fields.join(","),
          },
        });
      }
    }
  }
}

// Convert a block of pipe-table lines into batch update requests.
//
// Google Docs table index layout (after insertTable at I, R rows × C cols):
//   I      : newline inserted by the API before the table
//   I+1    : table-start structural marker
//   I+2    : row-0 start marker
//   I+3    : cell(0,0) outer marker
//   I+4    : paragraph-start inside cell(0,0)
//   I+5 + r*(C*2+1) + c*2 : content "\n" of cell(r,c)
//   (rows 1+ have only a 1-position row-start before the first cell)
// Total empty-table size = 5 + R*(2*C+1)
//
// Cells are filled in reverse document order so each insertion is at a
// higher index than all later insertions, keeping base positions stable.
function processTableBlock(
  lines: string[],
  startIndex: number
): { requests: BatchUpdateRequest[]; indexAdvance: number } {
  const rows = lines
    .filter(line => !isSeparatorRow(line))
    .map(line => parsePipeRow(line));

  if (rows.length === 0) return { requests: [], indexAdvance: 0 };

  const numRows = rows.length;
  const numCols = Math.max(...rows.map(r => r.length));

  // Pad all rows to the same column count
  const grid = rows.map(r => {
    const padded = [...r];
    while (padded.length < numCols) padded.push('');
    return padded;
  });

  const requests: BatchUpdateRequest[] = [];

  requests.push({
    insertTable: {
      rows: numRows,
      columns: numCols,
      location: { index: startIndex },
    },
  });

  let totalContentCodePoints = 0;

  for (let r = numRows - 1; r >= 0; r--) {
    for (let c = numCols - 1; c >= 0; c--) {
      const { text: plainText, formatting } = processInlineFormatting(grid[r][c]);
      totalContentCodePoints += codePointLength(plainText);

      if (!plainText) continue;

      const cellIndex = startIndex + 5 + r * (numCols * 2 + 1) + c * 2;

      requests.push({
        insertText: {
          location: { index: cellIndex },
          text: plainText,
        },
      });

      emitInlineStyleRequests(formatting, cellIndex, requests);
    }
  }

  // Empty table occupies 5 + R*(2*C+1) indices (including leading newline); cell content adds on top.
  const indexAdvance = 5 + numRows * (numCols * 2 + 1) + totalContentCodePoints;

  return { requests, indexAdvance };
}

export function markdownToBatchUpdates(text: string, startIndex: number): BatchUpdateRequest[] {
  if (new TextEncoder().encode(text).length > 100 * 1024) {
    throw new Error("Markdown content exceeds 100 KB limit");
  }
  const requests: BatchUpdateRequest[] = [];
  const lines = text.split("\n");
  if (lines.length > 5000) {
    throw new Error("Markdown content exceeds 5000 line limit");
  }
  let currentIndex = startIndex;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // ── Table block: collect all consecutive pipe lines ───────────────────────
    if (line.trimStart().startsWith('|')) {
      const tableLines: string[] = [];
      while (i < lines.length && lines[i].trimStart().startsWith('|')) {
        tableLines.push(lines[i]);
        i++;
      }
      const { requests: tableReqs, indexAdvance } = processTableBlock(tableLines, currentIndex);
      requests.push(...tableReqs);
      currentIndex += indexAdvance;
      continue;
    }

    // ── Normal line ───────────────────────────────────────────────────────────
    let stripped = line;
    let headerLevel = 0;
    let isBullet = false;

    const headerMatch = line.match(/^(#{1,6})\s+(.*)$/);
    const bulletMatch = line.match(/^[-*]\s+(.*)$/);

    if (headerMatch) {
      headerLevel = headerMatch[1].length;
      stripped = headerMatch[2];
    } else if (bulletMatch) {
      isBullet = true;
      stripped = bulletMatch[1];
    }

    const { text: plainText, formatting } = processInlineFormatting(stripped);
    const textToInsert = plainText + "\n";
    const insertedLen = codePointLength(textToInsert);

    requests.push({
      insertText: {
        location: { index: currentIndex },
        text: textToInsert,
      },
    });

    // Always set paragraph style explicitly to prevent inheriting the style
    // of the preceding paragraph (e.g. heading style bleeding into body text).
    requests.push({
      updateParagraphStyle: {
        range: { startIndex: currentIndex, endIndex: currentIndex + 1 },
        paragraphStyle: { namedStyleType: headerLevel > 0 ? `HEADING_${headerLevel}` : "NORMAL_TEXT" },
        fields: "namedStyleType",
      },
    });

    if (isBullet) {
      requests.push({
        createParagraphBullets: {
          range: { startIndex: currentIndex, endIndex: currentIndex + insertedLen },
          bulletPreset: "BULLET_DISC_CIRCLE_SQUARE",
        },
      });
    }

    emitInlineStyleRequests(formatting, currentIndex, requests);

    currentIndex += insertedLen;
    i++;
  }

  return requests;
}

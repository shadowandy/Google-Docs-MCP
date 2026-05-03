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

  for (const line of lines) {
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

    if (headerLevel > 0) {
      requests.push({
        updateParagraphStyle: {
          range: { startIndex: currentIndex, endIndex: currentIndex + 1 },
          paragraphStyle: { namedStyleType: `HEADING_${headerLevel}` },
          fields: "namedStyleType",
        },
      });
    }

    if (isBullet) {
      requests.push({
        createParagraphBullets: {
          range: { startIndex: currentIndex, endIndex: currentIndex + insertedLen },
          bulletPreset: "BULLET_DISC_CIRCLE_SQUARE",
        },
      });
    }

    for (const fmt of formatting) {
      const { code, bold, italic } = fmt.style;
      if (code) {
        requests.push({
          updateTextStyle: {
            range: { startIndex: currentIndex + fmt.start, endIndex: currentIndex + fmt.end },
            textStyle: { weightedFontFamily: { fontFamily: "Courier New", weight: 400 } },
            fields: "weightedFontFamily",
          },
        });
      } else {
        const textStyle: { bold?: boolean; italic?: boolean } = {};
        const fields: string[] = [];
        if (bold) { textStyle.bold = true; fields.push("bold"); }
        if (italic) { textStyle.italic = true; fields.push("italic"); }
        if (fields.length > 0) {
          requests.push({
            updateTextStyle: {
              range: { startIndex: currentIndex + fmt.start, endIndex: currentIndex + fmt.end },
              textStyle,
              fields: fields.join(","),
            },
          });
        }
      }
    }

    currentIndex += insertedLen;
  }

  return requests;
}

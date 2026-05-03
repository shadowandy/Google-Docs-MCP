import { BatchUpdateRequest } from "./types";

// Count Unicode code points, not UTF-16 code units.
// Google Docs indexes are code-point offsets; JS .length gives UTF-16 units,
// which differ for supplementary characters (emoji, CJK ext-B, etc.).
function codePointLength(s: string): number {
  return [...s].length;
}

function processInlineFormatting(input: string): { text: string; formatting: Array<{ start: number; end: number; style: any }> } {
  const formatting: Array<{ start: number; end: number; style: any }> = [];
  let result = '';
  let i = 0;

  while (i < input.length) {
    if (input[i] === '*' && input[i + 1] === '*') {
      const closeIdx = input.indexOf('**', i + 2);
      if (closeIdx !== -1) {
        const start = codePointLength(result);
        result += input.slice(i + 2, closeIdx);
        formatting.push({ start, end: codePointLength(result), style: { bold: true } });
        i = closeIdx + 2;
        continue;
      }
    } else if (input[i] === '*') {
      const closeIdx = input.indexOf('*', i + 1);
      if (closeIdx !== -1) {
        const start = codePointLength(result);
        result += input.slice(i + 1, closeIdx);
        formatting.push({ start, end: codePointLength(result), style: { italic: true } });
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
      requests.push({
        updateTextStyle: {
          range: {
            startIndex: currentIndex + fmt.start,
            endIndex: currentIndex + fmt.end,
          },
          textStyle: fmt.style,
          fields: Object.keys(fmt.style).join(","),
        },
      });
    }

    currentIndex += insertedLen;
  }

  return requests;
}

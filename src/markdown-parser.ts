import { BatchUpdateRequest } from "./types";

function processInlineFormatting(input: string): { text: string; formatting: Array<{ start: number; end: number; style: any }> } {
  const formatting: Array<{ start: number; end: number; style: any }> = [];
  let result = '';
  let i = 0;

  while (i < input.length) {
    if (input[i] === '*' && input[i + 1] === '*') {
      const closeIdx = input.indexOf('**', i + 2);
      if (closeIdx !== -1) {
        const start = result.length;
        result += input.slice(i + 2, closeIdx);
        formatting.push({ start, end: result.length, style: { bold: true } });
        i = closeIdx + 2;
        continue;
      }
    } else if (input[i] === '*') {
      const closeIdx = input.indexOf('*', i + 1);
      if (closeIdx !== -1) {
        const start = result.length;
        result += input.slice(i + 1, closeIdx);
        formatting.push({ start, end: result.length, style: { italic: true } });
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

    const headerMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headerMatch) {
      headerLevel = headerMatch[1].length;
      stripped = headerMatch[2];
    }

    const { text: plainText, formatting } = processInlineFormatting(stripped);
    const textToInsert = plainText + "\n";

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

    currentIndex += textToInsert.length;
  }

  return requests;
}

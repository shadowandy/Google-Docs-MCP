import { GoogleDoc, GoogleDocElement, GoogleTable, ParagraphElement } from "./types";

export function elementsToMarkdown(elements: GoogleDocElement[]): string {
  let markdown = "";
  for (const element of elements) {
    if (element.paragraph) {
      markdown += parseParagraph(element.paragraph);
    } else if (element.table) {
      markdown += parseTable(element.table);
    }
  }
  return markdown;
}

export function docToMarkdown(doc: GoogleDoc): string {
  return `# ${doc.title}\n\n` + elementsToMarkdown(doc.body.content);
}

function parseParagraph(paragraph: NonNullable<GoogleDocElement["paragraph"]>): string {
  let text = "";
  const style = paragraph.paragraphStyle?.namedStyleType ?? "NORMAL_TEXT";

  const content = paragraph.elements.map((el: ParagraphElement) => {
    if (el.textRun) {
      let run = el.textRun.content;
      if (el.textRun.textStyle?.bold) run = `**${run}**`;
      if (el.textRun.textStyle?.italic) run = `*${run}*`;
      return run;
    }
    return "";
  }).join("");

  if (style.startsWith("HEADING_")) {
    const level = parseInt(style.split("_")[1]);
    text = `${"#".repeat(level)} ${content}\n`;
  } else if (paragraph.bullet) {
    text = `* ${content}`;
  } else {
    text = `${content}`;
  }

  return text;
}

function parseTable(table: GoogleTable): string {
  let text = "\n";
  for (const row of table.tableRows) {
    text += "|";
    for (const cell of row.tableCells) {
      const cellText = cell.content.map(c => {
        if (c.paragraph) return c.paragraph.elements.map(el => el.textRun?.content ?? "").join("").trim();
        return "";
      }).join(" ");
      text += ` ${cellText} |`;
    }
    text += "\n";
  }
  text += "\n";
  return text;
}

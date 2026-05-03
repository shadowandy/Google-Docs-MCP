import { describe, it, expect } from "vitest";
import { docToMarkdown } from "../markdown-utils";
import type { GoogleDoc, GoogleDocElement } from "../types";

// ── Helpers ──────────────────────────────────────────────────────────────────

function para(
  text: string,
  style = "NORMAL_TEXT",
  opts: { bold?: boolean; italic?: boolean; bullet?: boolean } = {}
): GoogleDocElement {
  return {
    startIndex: 1,
    endIndex: text.length + 2,
    paragraph: {
      elements: [{
        textRun: {
          content: text,
          textStyle: { bold: opts.bold ?? false, italic: opts.italic ?? false },
        },
      }],
      paragraphStyle: { namedStyleType: style },
      ...(opts.bullet ? { bullet: {} } : {}),
    },
  };
}

function doc(title: string, ...elements: GoogleDocElement[]): GoogleDoc {
  return { documentId: "test-id", title, body: { content: elements } };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("docToMarkdown", () => {
  it("always opens with the document title as H1", () => {
    const md = docToMarkdown(doc("My Doc"));
    expect(md).toMatch(/^# My Doc\n/);
  });

  it("renders a plain NORMAL_TEXT paragraph verbatim", () => {
    const md = docToMarkdown(doc("T", para("hello world")));
    expect(md).toContain("hello world");
  });

  it("wraps bold text in double asterisks", () => {
    const md = docToMarkdown(doc("T", para("strong", "NORMAL_TEXT", { bold: true })));
    expect(md).toContain("**strong**");
  });

  it("wraps italic text in single asterisks", () => {
    const md = docToMarkdown(doc("T", para("em", "NORMAL_TEXT", { italic: true })));
    expect(md).toContain("*em*");
  });

  it("renders H1 heading with one hash", () => {
    const md = docToMarkdown(doc("T", para("Section", "HEADING_1")));
    expect(md).toContain("# Section\n");
  });

  it("renders H3 heading with three hashes", () => {
    const md = docToMarkdown(doc("T", para("Sub", "HEADING_3")));
    expect(md).toContain("### Sub\n");
  });

  it("renders a bulleted paragraph with '* ' prefix", () => {
    const md = docToMarkdown(doc("T", para("item", "NORMAL_TEXT", { bullet: true })));
    expect(md).toContain("* item");
  });

  it("renders a table as a pipe-delimited block", () => {
    const tableElement: GoogleDocElement = {
      startIndex: 1,
      endIndex: 10,
      table: {
        tableRows: [{
          tableCells: [
            { content: [{ paragraph: { elements: [{ textRun: { content: "A" } }] } }] },
            { content: [{ paragraph: { elements: [{ textRun: { content: "B" } }] } }] },
          ],
        }],
      },
    };
    const md = docToMarkdown(doc("T", tableElement));
    expect(md).toContain("| A |");
    expect(md).toContain("| B |");
  });

  it("processes multiple elements in document order", () => {
    const md = docToMarkdown(doc(
      "T",
      para("First", "HEADING_1"),
      para("body text"),
      para("bullet item", "NORMAL_TEXT", { bullet: true }),
    ));
    const h1 = md.indexOf("# First");
    const body = md.indexOf("body text");
    const bullet = md.indexOf("* bullet item");
    expect(h1).toBeLessThan(body);
    expect(body).toBeLessThan(bullet);
  });
});

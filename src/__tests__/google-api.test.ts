import { describe, it, expect } from "vitest";
import { extractDocumentId, listSections } from "../google-api";
import type { GoogleDoc } from "../types";

// ── extractDocumentId ─────────────────────────────────────────────────────────

describe("extractDocumentId", () => {
  const VALID_ID = "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms"; // 44 chars

  it("extracts the ID from a full Google Docs edit URL", () => {
    const url = `https://docs.google.com/document/d/${VALID_ID}/edit`;
    expect(extractDocumentId(url)).toBe(VALID_ID);
  });

  it("extracts the ID from a URL without a trailing path segment", () => {
    expect(extractDocumentId(`https://docs.google.com/document/d/${VALID_ID}`)).toBe(VALID_ID);
  });

  it("returns a raw valid document ID unchanged", () => {
    expect(extractDocumentId(VALID_ID)).toBe(VALID_ID);
  });

  it("trims whitespace from a raw ID", () => {
    expect(extractDocumentId(`  ${VALID_ID}  `)).toBe(VALID_ID);
  });

  it("throws for a too-short string", () => {
    expect(() => extractDocumentId("abc123")).toThrow("Invalid document ID format");
  });

  it("throws for a plain English string", () => {
    expect(() => extractDocumentId("not-a-document-id")).toThrow("Invalid document ID format");
  });

  it("throws for an empty string", () => {
    expect(() => extractDocumentId("")).toThrow("Invalid document ID format");
  });

  it("throws when ID contains disallowed characters", () => {
    const bad = VALID_ID.slice(0, -1) + "!";
    expect(() => extractDocumentId(bad)).toThrow("Invalid document ID format");
  });
});

// ── listSections ──────────────────────────────────────────────────────────────

function makeDoc(...paragraphs: Array<{ text: string; style: string; startIndex: number }>): GoogleDoc {
  return {
    documentId: "test",
    title: "Test",
    body: {
      content: paragraphs.map(p => ({
        startIndex: p.startIndex,
        endIndex: p.startIndex + p.text.length + 1,
        paragraph: {
          elements: [{ textRun: { content: p.text + "\n" } }],
          paragraphStyle: { namedStyleType: p.style },
        },
      })),
    },
  };
}

describe("listSections", () => {
  it("returns an empty array when the document has no headings", () => {
    const doc = makeDoc({ text: "just text", style: "NORMAL_TEXT", startIndex: 1 });
    expect(listSections(doc)).toEqual([]);
  });

  it("returns one entry per heading, ignoring body paragraphs", () => {
    const doc = makeDoc(
      { text: "Intro",   style: "HEADING_1",    startIndex: 1  },
      { text: "body",    style: "NORMAL_TEXT",  startIndex: 8  },
      { text: "Details", style: "HEADING_2",    startIndex: 13 },
    );
    const sections = listSections(doc);
    expect(sections).toHaveLength(2);
  });

  it("correctly reports level from the heading style", () => {
    const doc = makeDoc(
      { text: "H1", style: "HEADING_1", startIndex: 1 },
      { text: "H3", style: "HEADING_3", startIndex: 5 },
    );
    expect(listSections(doc)[0].level).toBe(1);
    expect(listSections(doc)[1].level).toBe(3);
  });

  it("strips the trailing newline from heading text", () => {
    const doc = makeDoc({ text: "Section A", style: "HEADING_2", startIndex: 1 });
    // makeDoc appends '\n' to the content; listSections should strip it
    expect(listSections(doc)[0].text).toBe("Section A");
  });

  it("records the startIndex of each heading element", () => {
    const doc = makeDoc(
      { text: "Alpha", style: "HEADING_1", startIndex: 1  },
      { text: "Beta",  style: "HEADING_1", startIndex: 20 },
    );
    const sections = listSections(doc);
    expect(sections[0].startIndex).toBe(1);
    expect(sections[1].startIndex).toBe(20);
  });

  it("preserves document order", () => {
    const doc = makeDoc(
      { text: "First",  style: "HEADING_1", startIndex: 1  },
      { text: "Second", style: "HEADING_2", startIndex: 10 },
      { text: "Third",  style: "HEADING_1", startIndex: 20 },
    );
    const texts = listSections(doc).map(s => s.text);
    expect(texts).toEqual(["First", "Second", "Third"]);
  });
});

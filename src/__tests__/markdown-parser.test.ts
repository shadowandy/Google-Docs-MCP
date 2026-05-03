import { describe, it, expect } from "vitest";
import { markdownToBatchUpdates } from "../markdown-parser";

describe("markdownToBatchUpdates", () => {
  // ── Basic insertion ────────────────────────────────────────────────────────

  it("inserts a plain line at the given startIndex", () => {
    const [insert] = markdownToBatchUpdates("hello", 5);
    expect(insert.insertText).toEqual({ location: { index: 5 }, text: "hello\n" });
  });

  it("appends a newline to every line", () => {
    const reqs = markdownToBatchUpdates("hi", 0);
    expect(reqs[0].insertText!.text).toBe("hi\n");
  });

  it("advances currentIndex by code-point length between lines", () => {
    const reqs = markdownToBatchUpdates("ab\ncd", 0);
    const inserts = reqs.filter(r => r.insertText);
    expect(inserts[0].insertText!.location.index).toBe(0);
    expect(inserts[1].insertText!.location.index).toBe(3); // 'ab\n' = 3 code points
  });

  it("respects a non-zero startIndex for all positions", () => {
    const reqs = markdownToBatchUpdates("x\ny", 10);
    const inserts = reqs.filter(r => r.insertText);
    expect(inserts[0].insertText!.location.index).toBe(10);
    expect(inserts[1].insertText!.location.index).toBe(12); // 10 + 2 ('x\n')
  });

  // ── Headings ───────────────────────────────────────────────────────────────

  it("produces HEADING_1 for a # line", () => {
    const reqs = markdownToBatchUpdates("# Title", 0);
    const para = reqs.find(r => r.updateParagraphStyle);
    expect(para!.updateParagraphStyle!.paragraphStyle.namedStyleType).toBe("HEADING_1");
  });

  it("produces HEADING_6 for a ###### line", () => {
    const reqs = markdownToBatchUpdates("###### Deep", 0);
    const para = reqs.find(r => r.updateParagraphStyle);
    expect(para!.updateParagraphStyle!.paragraphStyle.namedStyleType).toBe("HEADING_6");
  });

  it("strips the # prefix from the inserted heading text", () => {
    const reqs = markdownToBatchUpdates("## Section", 0);
    const insert = reqs.find(r => r.insertText);
    expect(insert!.insertText!.text).toBe("Section\n");
  });

  it("does not produce a heading request for plain text", () => {
    const reqs = markdownToBatchUpdates("plain", 0);
    expect(reqs.every(r => !r.updateParagraphStyle)).toBe(true);
  });

  // ── Inline formatting ──────────────────────────────────────────────────────

  it("bold: produces updateTextStyle with bold:true and inserts unwrapped text", () => {
    const reqs = markdownToBatchUpdates("**bold**", 0);
    const insert = reqs.find(r => r.insertText);
    expect(insert!.insertText!.text).toBe("bold\n");
    const style = reqs.find(r => r.updateTextStyle);
    expect(style!.updateTextStyle!.textStyle).toEqual({ bold: true });
    expect(style!.updateTextStyle!.fields).toBe("bold");
  });

  it("italic: produces updateTextStyle with italic:true and inserts unwrapped text", () => {
    const reqs = markdownToBatchUpdates("*italic*", 0);
    const insert = reqs.find(r => r.insertText);
    expect(insert!.insertText!.text).toBe("italic\n");
    const style = reqs.find(r => r.updateTextStyle);
    expect(style!.updateTextStyle!.textStyle).toEqual({ italic: true });
  });

  it("inline style range is relative to the line's startIndex", () => {
    // 'pre **bold**' → plain text 'pre bold\n'
    // 'pre ' is 4 code points, so bold starts at startIndex+4
    const reqs = markdownToBatchUpdates("pre **bold**", 10);
    const style = reqs.find(r => r.updateTextStyle);
    expect(style!.updateTextStyle!.range.startIndex).toBe(10 + 4);
    expect(style!.updateTextStyle!.range.endIndex).toBe(10 + 4 + 4); // 'bold' = 4
  });

  // ── Bullet lists ───────────────────────────────────────────────────────────

  it("'* item' produces createParagraphBullets with BULLET_DISC_CIRCLE_SQUARE", () => {
    const reqs = markdownToBatchUpdates("* item", 0);
    const bullet = reqs.find(r => r.createParagraphBullets);
    expect(bullet!.createParagraphBullets!.bulletPreset).toBe("BULLET_DISC_CIRCLE_SQUARE");
  });

  it("'- item' also produces createParagraphBullets", () => {
    const reqs = markdownToBatchUpdates("- item", 0);
    expect(reqs.some(r => r.createParagraphBullets)).toBe(true);
  });

  it("bullet strips the '* ' prefix from the inserted text", () => {
    const reqs = markdownToBatchUpdates("* hello", 0);
    const insert = reqs.find(r => r.insertText);
    expect(insert!.insertText!.text).toBe("hello\n");
  });

  it("bullet range covers the entire inserted paragraph", () => {
    const reqs = markdownToBatchUpdates("* hi", 2);
    const bullet = reqs.find(r => r.createParagraphBullets);
    expect(bullet!.createParagraphBullets!.range.startIndex).toBe(2);
    expect(bullet!.createParagraphBullets!.range.endIndex).toBe(2 + 3); // 'hi\n' = 3
  });

  // ── Unicode ────────────────────────────────────────────────────────────────

  it("counts emoji as one code point when advancing the index", () => {
    // '😀' is 2 UTF-16 units but 1 Unicode code point
    // '😀\n' = 2 code points → next line starts at startIndex + 2
    const reqs = markdownToBatchUpdates("😀\nB", 0);
    const inserts = reqs.filter(r => r.insertText);
    expect(inserts[1].insertText!.location.index).toBe(2);
  });

  it("bold range uses code-point offsets for non-BMP characters", () => {
    // '😀**x**' → plain text '😀x\n'; bold starts at code-point 1 (after emoji)
    const reqs = markdownToBatchUpdates("😀**x**", 0);
    const style = reqs.find(r => r.updateTextStyle);
    expect(style!.updateTextStyle!.range.startIndex).toBe(1);
    expect(style!.updateTextStyle!.range.endIndex).toBe(2);
  });

  // ── Bold-italic (***) ──────────────────────────────────────────────────────

  it("***text*** produces both bold and italic on the same span", () => {
    const reqs = markdownToBatchUpdates("***hi***", 0);
    const styles = reqs.filter(r => r.updateTextStyle);
    // The outer span covers the whole text with bold+italic
    const outer = styles.find(r => r.updateTextStyle!.textStyle.bold && r.updateTextStyle!.textStyle.italic);
    expect(outer).toBeDefined();
    expect(outer!.updateTextStyle!.textStyle).toEqual({ bold: true, italic: true });
  });

  it("***text*** inserts the unwrapped text", () => {
    const reqs = markdownToBatchUpdates("***hi***", 0);
    const insert = reqs.find(r => r.insertText);
    expect(insert!.insertText!.text).toBe("hi\n");
  });

  // ── Escaped asterisk ───────────────────────────────────────────────────────

  it("\\* is treated as a literal asterisk, not a style marker", () => {
    const reqs = markdownToBatchUpdates("\\*not italic\\*", 0);
    const insert = reqs.find(r => r.insertText);
    expect(insert!.insertText!.text).toBe("*not italic*\n");
    expect(reqs.every(r => !r.updateTextStyle)).toBe(true);
  });

  it("\\\\ is treated as a literal backslash", () => {
    const reqs = markdownToBatchUpdates("a\\\\b", 0);
    const insert = reqs.find(r => r.insertText);
    expect(insert!.insertText!.text).toBe("a\\b\n");
  });

  // ── Backtick code spans ────────────────────────────────────────────────────

  it("`code` inserts the unwrapped text", () => {
    const reqs = markdownToBatchUpdates("`hello`", 0);
    const insert = reqs.find(r => r.insertText);
    expect(insert!.insertText!.text).toBe("hello\n");
  });

  it("`code` produces updateTextStyle with weightedFontFamily Courier New", () => {
    const reqs = markdownToBatchUpdates("`hello`", 0);
    const style = reqs.find(r => r.updateTextStyle);
    expect(style!.updateTextStyle!.textStyle.weightedFontFamily?.fontFamily).toBe("Courier New");
    expect(style!.updateTextStyle!.fields).toBe("weightedFontFamily");
  });

  it("`code` range covers exactly the unwrapped text", () => {
    const reqs = markdownToBatchUpdates("`hi`", 5);
    const style = reqs.find(r => r.updateTextStyle);
    expect(style!.updateTextStyle!.range.startIndex).toBe(5);
    expect(style!.updateTextStyle!.range.endIndex).toBe(7); // 'hi' = 2 code points
  });

  // ── Nested formatting ──────────────────────────────────────────────────────

  it("**outer *inner* outer** emits bold for full span and italic for inner", () => {
    const reqs = markdownToBatchUpdates("**outer *inner* outer**", 0);
    const insert = reqs.find(r => r.insertText);
    expect(insert!.insertText!.text).toBe("outer inner outer\n");

    const styles = reqs.filter(r => r.updateTextStyle);
    const boldSpan = styles.find(r => r.updateTextStyle!.textStyle.bold);
    expect(boldSpan!.updateTextStyle!.range.startIndex).toBe(0);
    expect(boldSpan!.updateTextStyle!.range.endIndex).toBe(17); // 'outer inner outer'

    const italicSpan = styles.find(r => r.updateTextStyle!.textStyle.italic);
    expect(italicSpan!.updateTextStyle!.range.startIndex).toBe(6);  // after 'outer '
    expect(italicSpan!.updateTextStyle!.range.endIndex).toBe(11);   // 'inner' = 5 chars
  });

  // ── Input limits ───────────────────────────────────────────────────────────

  it("throws when content exceeds 100 KB", () => {
    expect(() => markdownToBatchUpdates("a".repeat(101 * 1024), 0)).toThrow("100 KB");
  });

  it("throws when content exceeds 5000 lines", () => {
    expect(() => markdownToBatchUpdates("x\n".repeat(5001), 0)).toThrow("5000 line");
  });
});

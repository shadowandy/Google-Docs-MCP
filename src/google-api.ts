import { markdownToBatchUpdates } from "./markdown-parser";
import { GoogleDoc, BatchUpdateRequest, BatchUpdateResponse, DocumentInfo, DriveFileListResponse, SectionInfo } from "./types";

const DOC_ID_RE = /^[a-zA-Z0-9_-]{25,55}$/;

async function extractApiError(response: Response): Promise<string> {
  const ct = response.headers.get("content-type") ?? "";
  try {
    if (ct.includes("application/json")) {
      const body = await response.json() as any;
      const msg = body?.error?.message ?? body?.message ?? JSON.stringify(body);
      return String(msg).slice(0, 300);
    }
  } catch {}
  const text = await response.text();
  return text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
}

export function extractDocumentId(input: string): string {
  const match = input.match(/\/d\/([a-zA-Z0-9_-]+)/);
  const id = match ? match[1] : input.trim();
  if (!DOC_ID_RE.test(id)) {
    throw new Error("Invalid document ID format");
  }
  return id;
}

// ── Document navigation helpers ─────────────────────────────────────────────

function headingLevel(namedStyleType: string): number {
  return parseInt(namedStyleType.split("_")[1]);
}

interface SectionRange {
  /** startIndex of the heading paragraph itself */
  headerStart: number;
  /** endIndex of the heading paragraph (first index of body content) */
  contentStart: number;
  /** startIndex of the next same-or-higher heading, or doc endIndex − 1 */
  contentEnd: number;
}

function findSectionRange(doc: GoogleDoc, headerText: string): SectionRange | null {
  const target = headerText.toLowerCase().trim();
  let found: { level: number; headerStart: number; contentStart: number } | null = null;

  for (const element of doc.body.content) {
    const style = element.paragraph?.paragraphStyle?.namedStyleType ?? "";
    if (!style.startsWith("HEADING_")) continue;

    const level = headingLevel(style);
    const text = element.paragraph!.elements
      .map(e => e.textRun?.content ?? "")
      .join("")
      .trim();

    if (!found) {
      if (text.toLowerCase() === target) {
        found = { level, headerStart: element.startIndex, contentStart: element.endIndex };
      }
    } else if (level <= found.level) {
      return { headerStart: found.headerStart, contentStart: found.contentStart, contentEnd: element.startIndex };
    }
  }

  if (!found) return null;

  const last = doc.body.content[doc.body.content.length - 1];
  return { headerStart: found.headerStart, contentStart: found.contentStart, contentEnd: last.endIndex - 1 };
}

// ── Google Docs API calls ────────────────────────────────────────────────────

export async function getDocumentBody(documentIdOrUrl: string, accessToken: string): Promise<GoogleDoc> {
  const documentId = extractDocumentId(documentIdOrUrl);
  const response = await fetch(`https://docs.googleapis.com/v1/documents/${documentId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new Error(`Google Docs API error (${response.status}): ${await extractApiError(response)}`);
  }

  const text = await response.text();
  if (new TextEncoder().encode(text).length > 10 * 1024 * 1024) {
    throw new Error("Document is too large to process (exceeds 10MB memory safety limit)");
  }

  return JSON.parse(text) as GoogleDoc;
}

export async function createDocument(title: string, accessToken: string): Promise<string> {
  const response = await fetch(`https://docs.googleapis.com/v1/documents`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ title }),
  });
  if (!response.ok) {
    throw new Error(`Google Docs create error (${response.status}): ${await extractApiError(response)}`);
  }
  const data = await response.json() as { documentId: string };
  return data.documentId;
}

export async function batchUpdate(documentIdOrUrl: string, requests: BatchUpdateRequest[], accessToken: string) {
  const documentId = extractDocumentId(documentIdOrUrl);
  const response = await fetch(`https://docs.googleapis.com/v1/documents/${documentId}:batchUpdate`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ requests }),
  });
  if (!response.ok) {
    throw new Error(`Google Docs batch update error (${response.status}): ${await extractApiError(response)}`);
  }
  return response.json();
}

export async function searchDocuments(query: string, accessToken: string) {
  const safe = query.replace(/[()'"\\]/g, "").trim().slice(0, 200);
  if (!safe) throw new Error("Search query is empty after sanitisation");
  const q = `(name contains '${safe}' or fullText contains '${safe}') and mimeType = 'application/vnd.google-apps.document'`;
  const response = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new Error(`Google Drive search error (${response.status}): ${await extractApiError(response)}`);
  }
  return response.json();
}

export function listSections(doc: GoogleDoc): SectionInfo[] {
  return doc.body.content
    .filter(el => el.paragraph?.paragraphStyle?.namedStyleType.startsWith("HEADING_") ?? false)
    .map(el => ({
      level: headingLevel(el.paragraph!.paragraphStyle!.namedStyleType),
      text: el.paragraph!.elements
        .map(e => e.textRun?.content ?? "")
        .join("")
        .replace(/\n$/, ""),
      startIndex: el.startIndex,
    }));
}

export async function getDocumentInfo(documentIdOrUrl: string, accessToken: string) {
  const documentId = extractDocumentId(documentIdOrUrl);
  const fields = "documentId,title,revisionId,documentStyle";
  const response = await fetch(
    `https://docs.googleapis.com/v1/documents/${documentId}?fields=${encodeURIComponent(fields)}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!response.ok) {
    throw new Error(`Google Docs API error (${response.status}): ${await extractApiError(response)}`);
  }
  const data = await response.json() as DocumentInfo;

  const driveFields = "id,name,modifiedTime,size";
  const driveResponse = await fetch(
    `https://www.googleapis.com/drive/v3/files/${documentId}?fields=${encodeURIComponent(driveFields)}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!driveResponse.ok) {
    console.warn(`Drive metadata fetch failed for ${documentId} (${driveResponse.status}) — modifiedTime and size unavailable`);
  } else {
    const drive = await driveResponse.json() as { modifiedTime?: string; size?: string };
    data.modifiedTime = drive.modifiedTime;
    data.size = drive.size;
  }

  return data;
}

export async function findAndReplace(
  documentIdOrUrl: string,
  findText: string,
  replaceText: string,
  matchCase: boolean,
  accessToken: string
): Promise<number> {
  const documentId = extractDocumentId(documentIdOrUrl);
  const requests: BatchUpdateRequest[] = [{
    replaceAllText: {
      containsText: { text: findText, matchCase },
      replaceText,
    },
  }];
  const result = await batchUpdate(documentId, requests, accessToken) as BatchUpdateResponse;
  return result.replies?.[0]?.replaceAllText?.occurrencesChanged ?? 0;
}

export async function listDocuments(accessToken: string, pageSize = 20): Promise<DriveFileListResponse> {
  const q = "mimeType='application/vnd.google-apps.document' and trashed=false";
  const fields = "files(id,name,modifiedTime)";
  const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=${encodeURIComponent(fields)}&orderBy=modifiedTime+desc&pageSize=${pageSize}`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new Error(`Google Drive list error (${response.status}): ${await extractApiError(response)}`);
  }
  return response.json();
}

export async function deleteSection(documentIdOrUrl: string, headerText: string, accessToken: string) {
  const documentId = extractDocumentId(documentIdOrUrl);
  const doc = await getDocumentBody(documentId, accessToken);

  const range = findSectionRange(doc, headerText);
  if (!range) throw new Error(`Section with header "${headerText}" not found.`);

  const requests: BatchUpdateRequest[] = [{
    deleteContentRange: { range: { startIndex: range.headerStart, endIndex: range.contentEnd } },
  }];
  return batchUpdate(documentId, requests, accessToken);
}

export async function replaceSection(
  documentIdOrUrl: string,
  headerText: string,
  newContentMarkdown: string,
  accessToken: string
) {
  const documentId = extractDocumentId(documentIdOrUrl);
  const doc = await getDocumentBody(documentId, accessToken);

  const range = findSectionRange(doc, headerText);
  if (!range) throw new Error(`Section with header "${headerText}" not found.`);

  const requests: BatchUpdateRequest[] = [];
  if (range.contentEnd > range.contentStart) {
    requests.push({
      deleteContentRange: { range: { startIndex: range.contentStart, endIndex: range.contentEnd } },
    });
  }
  requests.push(...markdownToBatchUpdates(newContentMarkdown, range.contentStart));
  return batchUpdate(documentId, requests, accessToken);
}

export async function appendText(documentIdOrUrl: string, newContentMarkdown: string, accessToken: string) {
  const documentId = extractDocumentId(documentIdOrUrl);
  const doc = await getDocumentBody(documentId, accessToken);

  const last = doc.body.content[doc.body.content.length - 1];
  const insertIndex = last.endIndex - 1;

  return batchUpdate(documentId, markdownToBatchUpdates(newContentMarkdown, insertIndex), accessToken);
}

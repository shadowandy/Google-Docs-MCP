import { markdownToBatchUpdates } from "./markdown-parser";
import { GoogleDoc, BatchUpdateRequest } from "./types";

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

export async function getDocument(documentIdOrUrl: string, accessToken: string): Promise<GoogleDoc> {
  const documentId = extractDocumentId(documentIdOrUrl);
  const response = await fetch(`https://docs.googleapis.com/v1/documents/${documentId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new Error(`Google Docs API error (${response.status}): ${await extractApiError(response)}`);
  }
  return response.json() as Promise<GoogleDoc>;
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
  const data = await response.json() as any;
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

// Context-based editing logic
export async function replaceSection(documentIdOrUrl: string, headerText: string, newContentMarkdown: string, accessToken: string) {
  const documentId = extractDocumentId(documentIdOrUrl);
  const doc = await getDocument(documentId, accessToken);

  // 1. Find the content range beneath the header (header itself is preserved)
  let contentStart = -1; // first index after the header paragraph
  let contentEnd = -1;
  let headerLevel = -1;

  for (let i = 0; i < doc.body.content.length; i++) {
    const element = doc.body.content[i];
    if (element.paragraph?.paragraphStyle?.namedStyleType.startsWith("HEADING_")) {
      const text = element.paragraph.elements.map((e: any) => e.textRun?.content || "").join("").trim();

      if (contentStart === -1) {
        if (text.toLowerCase() === headerText.toLowerCase().trim()) {
          contentStart = element.endIndex; // start after the header line
          headerLevel = parseInt(element.paragraph.paragraphStyle.namedStyleType.split("_")[1]);
        }
      } else {
        const currentLevel = parseInt(element.paragraph.paragraphStyle.namedStyleType.split("_")[1]);
        if (currentLevel <= headerLevel) {
          contentEnd = element.startIndex;
          break;
        }
      }
    }
  }

  if (contentStart === -1) {
    throw new Error(`Section with header "${headerText}" not found.`);
  }

  if (contentEnd === -1) {
    const lastElement = doc.body.content[doc.body.content.length - 1];
    contentEnd = lastElement.endIndex - 1;
  }

  // 2. Build requests: delete existing content, then insert new content at the same position
  const requests: any[] = [];
  if (contentEnd > contentStart) {
    requests.push({ deleteContentRange: { range: { startIndex: contentStart, endIndex: contentEnd } } });
  }
  requests.push(...markdownToBatchUpdates(newContentMarkdown, contentStart));

  return batchUpdate(documentId, requests, accessToken);
}

// Append text to the end of the document
export async function appendText(documentIdOrUrl: string, newContentMarkdown: string, accessToken: string) {
  const documentId = extractDocumentId(documentIdOrUrl);
  const doc = await getDocument(documentId, accessToken);
  
  // Find the end of the document
  const lastElement = doc.body.content[doc.body.content.length - 1];
  // In Google Docs, you insert before the very last newline character (endIndex - 1)
  const insertIndex = lastElement.endIndex - 1;

  const insertRequests = markdownToBatchUpdates(newContentMarkdown, insertIndex);
  return batchUpdate(documentId, insertRequests, accessToken);
}

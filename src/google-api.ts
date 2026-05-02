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

export interface SectionInfo {
  level: number;
  text: string;
  startIndex: number;
}

export function listSections(doc: GoogleDoc): SectionInfo[] {
  const sections: SectionInfo[] = [];
  for (const element of doc.body.content) {
    const style = element.paragraph?.paragraphStyle?.namedStyleType ?? "";
    if (style.startsWith("HEADING_")) {
      const level = parseInt(style.split("_")[1]);
      const text = element.paragraph!.elements
        .map((e: any) => e.textRun?.content ?? "")
        .join("")
        .replace(/\n$/, "");
      sections.push({ level, text, startIndex: element.startIndex });
    }
  }
  return sections;
}

export async function getDocumentInfo(documentIdOrUrl: string, accessToken: string) {
  const documentId = extractDocumentId(documentIdOrUrl);
  // Request only the fields we need — avoids fetching the full body
  const fields = "documentId,title,revisionId,documentStyle";
  const response = await fetch(
    `https://docs.googleapis.com/v1/documents/${documentId}?fields=${encodeURIComponent(fields)}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!response.ok) {
    throw new Error(`Google Docs API error (${response.status}): ${await extractApiError(response)}`);
  }
  const data = await response.json() as any;

  // Fetch file metadata (size, modifiedTime) from Drive
  const driveFields = "id,name,modifiedTime,size";
  const driveResponse = await fetch(
    `https://www.googleapis.com/drive/v3/files/${documentId}?fields=${encodeURIComponent(driveFields)}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (driveResponse.ok) {
    const drive = await driveResponse.json() as any;
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
  const requests = [{
    replaceAllText: {
      containsText: { text: findText, matchCase },
      replaceText,
    },
  }];
  const result = await batchUpdate(documentId, requests as any, accessToken) as any;
  return result.replies?.[0]?.replaceAllText?.occurrencesChanged ?? 0;
}

export async function listDocuments(accessToken: string, pageSize = 20) {
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
  const doc = await getDocument(documentId, accessToken);

  let sectionStart = -1; // index of the header paragraph itself
  let sectionEnd = -1;
  let headerLevel = -1;

  for (let i = 0; i < doc.body.content.length; i++) {
    const element = doc.body.content[i];
    const style = element.paragraph?.paragraphStyle?.namedStyleType ?? "";
    if (style.startsWith("HEADING_")) {
      const text = element.paragraph!.elements
        .map((e: any) => e.textRun?.content ?? "")
        .join("")
        .trim();

      if (sectionStart === -1) {
        if (text.toLowerCase() === headerText.toLowerCase().trim()) {
          sectionStart = element.startIndex;
          headerLevel = parseInt(style.split("_")[1]);
        }
      } else {
        const currentLevel = parseInt(style.split("_")[1]);
        if (currentLevel <= headerLevel) {
          sectionEnd = element.startIndex;
          break;
        }
      }
    }
  }

  if (sectionStart === -1) {
    throw new Error(`Section with header "${headerText}" not found.`);
  }

  if (sectionEnd === -1) {
    const last = doc.body.content[doc.body.content.length - 1];
    sectionEnd = last.endIndex - 1;
  }

  const requests = [{
    deleteContentRange: { range: { startIndex: sectionStart, endIndex: sectionEnd } },
  }];
  return batchUpdate(documentId, requests as any, accessToken);
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

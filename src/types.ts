export interface Env {
  TOKENS: KVNamespace;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GOOGLE_REDIRECT_URI: string;
  TOKEN_ENCRYPTION_KEY: string; // base64-encoded 256-bit AES-GCM key; set via `wrangler secret put TOKEN_ENCRYPTION_KEY`
  MCP_SESSION: DurableObjectNamespace;
}

export interface ParagraphElement {
  textRun?: {
    content: string;
    textStyle?: { bold?: boolean; italic?: boolean };
  };
}

export interface GoogleDoc {
  documentId: string;
  title: string;
  body: {
    content: GoogleDocElement[];
  };
}

export interface TableCellContent {
  paragraph?: { elements: ParagraphElement[] };
}

export interface TableCell {
  content: TableCellContent[];
}

export interface TableRow {
  tableCells: TableCell[];
}

export interface GoogleTable {
  tableRows: TableRow[];
}

export interface GoogleDocElement {
  startIndex: number;
  endIndex: number;
  paragraph?: {
    elements: ParagraphElement[];
    paragraphStyle?: { namedStyleType: string };
    bullet?: unknown;
  };
  table?: GoogleTable;
  sectionBreak?: unknown;
}

export interface BatchUpdateRequest {
  insertText?: {
    location: { index: number };
    text: string;
  };
  updateTextStyle?: {
    range: { startIndex: number; endIndex: number };
    textStyle: {
      bold?: boolean;
      italic?: boolean;
      weightedFontFamily?: { fontFamily: string; weight?: number };
    };
    fields: string;
  };
  updateParagraphStyle?: {
    range: { startIndex: number; endIndex: number };
    paragraphStyle: { namedStyleType: string };
    fields: string;
  };
  deleteContentRange?: {
    range: { startIndex: number; endIndex: number };
  };
  replaceAllText?: {
    containsText: { text: string; matchCase: boolean };
    replaceText: string;
  };
  createParagraphBullets?: {
    range: { startIndex: number; endIndex: number };
    bulletPreset: string;
  };
}

export interface SectionInfo {
  level: number;
  text: string;
  startIndex: number;
}

// ── Google API response shapes ────────────────────────────────────────────────

export interface OAuthTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
  // Fields appended after receipt:
  expiry_date?: number;
  createdAt?: number;
  expiresAt?: number;
}

export interface DriveFile {
  id: string;
  name: string;
  modifiedTime: string;
}

export interface DriveFileListResponse {
  files?: DriveFile[];
}

export interface DocumentInfo {
  documentId: string;
  title: string;
  revisionId: string;
  documentStyle: unknown;
  modifiedTime?: string;
  size?: string;
}

export interface BatchUpdateResponse {
  replies?: Array<{
    replaceAllText?: { occurrencesChanged?: number };
  }>;
}

export interface Env {
  TOKENS: KVNamespace;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GOOGLE_REDIRECT_URI: string;
  TOKEN_ENCRYPTION_KEY: string; // base64-encoded 256-bit AES-GCM key; set via `wrangler secret put TOKEN_ENCRYPTION_KEY`
  MCP_SESSION: DurableObjectNamespace;
}

export interface GoogleDoc {
  documentId: string;
  title: string;
  body: {
    content: GoogleDocElement[];
  };
}

export interface GoogleDocElement {
  startIndex: number;
  endIndex: number;
  paragraph?: {
    elements: Array<{
      textRun?: {
        content: string;
        textStyle?: {
          bold?: boolean;
          italic?: boolean;
        };
      };
    }>;
    paragraphStyle?: {
      namedStyleType: string;
    };
  };
  table?: any; // Tables are complex, keeping as any for now but scoped
  sectionBreak?: any;
}

export interface BatchUpdateRequest {
  insertText?: {
    location: { index: number };
    text: string;
  };
  updateTextStyle?: {
    range: { startIndex: number; endIndex: number };
    textStyle: { bold?: boolean; italic?: boolean };
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
}

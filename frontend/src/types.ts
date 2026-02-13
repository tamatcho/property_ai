export type UiState = "idle" | "loading" | "success" | "error";

export type Source = {
  document_id: number;
  property_id?: number;
  chunk_id: string;
  page?: number;
  score?: number;
};

export type DocumentItem = {
  document_id: number;
  property_id: number;
  filename: string;
  uploaded_at?: string | null;
};

export type DocumentStatus = "indexed" | "processing" | "error";

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  sources?: Source[];
  sourceDetails?: Record<string, string>;
};

export type TimelineItem = {
  document_id?: number;
  filename?: string;
  source?: string;
  source_quote?: string | null;
  title: string;
  date_iso: string;
  time_24h?: string | null;
  category: string;
  amount_eur?: number | null;
  description: string;
};

export type Toast = {
  id: string;
  type: "success" | "error" | "warning";
  title: string;
  details?: string;
};

export type ApiStatus = {
  documents_in_db: number;
  chunks_in_db: number;
};

export type AuthUser = {
  id: number;
  email: string;
  created_at?: string | null;
};

export type PropertyItem = {
  id: number;
  user_id: number;
  name: string;
  address_optional?: string | null;
  created_at?: string | null;
};

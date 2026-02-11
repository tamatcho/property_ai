export type UiState = "idle" | "loading" | "success" | "error";

export type Source = {
  document_id: number;
  chunk_id: string;
  score?: number;
};

export type DocumentItem = {
  document_id: number;
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
  title: string;
  date_iso: string;
  time_24h?: string | null;
  category: string;
  amount_eur?: number | null;
  description: string;
};

export type Toast = {
  id: string;
  type: "success" | "error";
  title: string;
  details?: string;
};

export type ApiStatus = {
  documents_in_db: number;
  pdf_files_in_upload_dir: number;
  faiss_index_exists: boolean;
  faiss_meta_entries: number;
  faiss_indexed_documents: number;
  upload_dir: string;
  faiss_dir: string;
};

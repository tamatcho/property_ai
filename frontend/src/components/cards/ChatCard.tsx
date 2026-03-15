import type { KeyboardEvent, RefObject } from "react";
import StatusBanner from "../StatusBanner";
import { ChatMessage, DocumentItem, Source, UiState } from "../../types";

const CL: Record<string, Record<string, string>> = {
  de: {
    title: "Chat über Dokumente", clearHistory: "Verlauf löschen",
    noMessages: "Noch keine Nachrichten", startExample: "Starte mit einer Beispiel-Frage:",
    you: "Du", assistant: "Assistent",
    copyAnswer: "Antwort kopieren", sources: "Quellen", loadSnippet: "Snippet laden",
    sourceLabel: "Quelle:", documentDate: "Stand: Dokument vom", unknown: "unbekannt",
    noDocs: "Noch keine Dokumente für diese Immobilie. Bitte zuerst ein Dokument hochladen.",
    retry: "Erneut versuchen",
    placeholder: "z.B. Welche Zahlungen sind 2026 fällig?",
    send: "Frage senden", sending: "Frage läuft...",
  },
  en: {
    title: "Chat about documents", clearHistory: "Clear history",
    noMessages: "No messages yet", startExample: "Start with an example question:",
    you: "You", assistant: "Assistant",
    copyAnswer: "Copy answer", sources: "Sources", loadSnippet: "Load snippet",
    sourceLabel: "Source:", documentDate: "Document from", unknown: "unknown",
    noDocs: "No documents uploaded yet. Please upload a document first.",
    retry: "Retry",
    placeholder: "e.g. Which payments are due in 2026?",
    send: "Send question", sending: "Asking...",
  },
  fr: {
    title: "Chat sur les documents", clearHistory: "Effacer l'historique",
    noMessages: "Pas encore de messages", startExample: "Commencez avec une question exemple :",
    you: "Vous", assistant: "Assistant",
    copyAnswer: "Copier la réponse", sources: "Sources", loadSnippet: "Charger l'extrait",
    sourceLabel: "Source :", documentDate: "Document du", unknown: "inconnu",
    noDocs: "Aucun document pour cette propriété. Veuillez d'abord télécharger un document.",
    retry: "Réessayer",
    placeholder: "ex. Quels paiements sont dus en 2026 ?",
    send: "Envoyer", sending: "En cours...",
  },
};

type Props = {
  disabled?: boolean;
  language?: string;
  state: UiState;
  message: string;
  details?: string;
  chatHistory: ChatMessage[];
  chatQuestion: string;
  chatPending: boolean;
  hasDocuments: boolean;
  exampleQuestions: string[];
  documentsById: Record<number, DocumentItem>;
  onQuestionChange: (value: string) => void;
  onQuestionKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  onAsk: () => void;
  onRetry: () => void;
  onUseExample: (q: string) => void;
  onLoadSnippet: (messageId: string, source: Source) => void;
  onClearHistory?: () => void;
  historyRef: RefObject<HTMLDivElement>;
};

export default function ChatCard(props: Props) {
  const t = CL[props.language ?? "de"] ?? CL.de;
  const locale = props.language === "en" ? "en-GB" : props.language === "fr" ? "fr-FR" : "de-DE";

  const formatDocumentDate = (value?: string | null) => {
    if (!value) return t.unknown;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return t.unknown;
    return date.toLocaleDateString(locale);
  };

  const copyAnswer = async (text: string) => {
    if (!text.trim()) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // no-op
    }
  };

  return (
    <section id="chatCard" className="card reveal" data-state={props.state}>
      <div className="card-title-row">
        <h2>{t.title}</h2>
        {props.state === "loading" ? <span className="card-title-spinner" aria-hidden="true" /> : null}
        {props.chatHistory.length > 0 && props.onClearHistory ? (
          <button
            className="chip"
            disabled={props.chatPending || props.disabled}
            onClick={props.onClearHistory}
          >
            {t.clearHistory}
          </button>
        ) : null}
      </div>
      <StatusBanner state={props.state} message={props.message} details={props.details} />
      <div id="chatHistory" className="chat-history" ref={props.historyRef}>
        {props.chatHistory.length === 0 ? (
          <div className="chat-empty">
            <div className="empty-state-title">{t.noMessages}</div>
            <div>{t.startExample}</div>
            <div className="empty-actions">
              {props.exampleQuestions.map((q) => (
                <button
                  key={q}
                  className="chip"
                  disabled={props.disabled || props.chatPending || !props.hasDocuments}
                  onClick={() => props.onUseExample(q)}
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        ) : (
          props.chatHistory.map((msg) => (
            <div className={`bubble ${msg.role === "user" ? "bubble-user" : "bubble-assistant"}`} key={msg.id}>
              <div className="bubble-role">{msg.role === "user" ? t.you : t.assistant}</div>
              <div className="bubble-text">{msg.text}</div>
              {msg.role === "assistant" ? (
                <div className="bubble-actions">
                  <button className="chip" disabled={props.chatPending || props.disabled} onClick={() => void copyAnswer(msg.text)}>
                    {t.copyAnswer}
                  </button>
                </div>
              ) : null}
              {msg.role === "assistant" && msg.sources && msg.sources.length > 0 ? (
                <details className="sources">
                  <summary>{t.sources} ({msg.sources.length})</summary>
                  <ul className="sources-list">
                    {msg.sources.map((s) => {
                      const key = `${s.document_id}:${s.chunk_id}`;
                      const doc = props.documentsById[s.document_id];
                      const sourceLabel = doc?.filename || `Dokument ${s.document_id}`;
                      return (
                        <li className="source-row" key={`${msg.id}-${key}`}>
                          <div>{t.sourceLabel} {sourceLabel}</div>
                          <div>{t.documentDate} {formatDocumentDate(doc?.uploaded_at)}</div>
                          {typeof s.page === "number" ? <div>Seite: {s.page}</div> : null}
                          <button className="source-btn" disabled={props.chatPending || props.disabled} onClick={() => props.onLoadSnippet(msg.id, s)}>
                            {t.loadSnippet}
                          </button>
                          {msg.sourceDetails?.[key] ? <div className="source-snippet">{msg.sourceDetails[key]}</div> : null}
                        </li>
                      );
                    })}
                  </ul>
                </details>
              ) : null}
            </div>
          ))
        )}
      </div>
      <div className="col">
        {!props.hasDocuments ? (
          <div className="chat-hint">
            {t.noDocs}
          </div>
        ) : null}
        {props.state === "error" ? (
          <div className="empty-actions">
            <button className="chip" disabled={props.chatPending || props.disabled} onClick={props.onRetry}>
              {t.retry}
            </button>
          </div>
        ) : null}
        <textarea
          rows={3}
          placeholder={t.placeholder}
          value={props.chatQuestion}
          disabled={props.disabled || !props.hasDocuments || props.chatPending}
          onChange={(e) => props.onQuestionChange(e.target.value)}
          onKeyDown={props.onQuestionKeyDown}
        />
        <button className="btn" disabled={props.disabled || !props.hasDocuments || props.chatPending} onClick={props.onAsk}>
          {props.chatPending ? t.sending : t.send}
        </button>
      </div>
    </section>
  );
}

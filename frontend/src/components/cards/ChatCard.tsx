import type { RefObject } from "react";
import StatusBanner from "../StatusBanner";
import { ChatMessage, DocumentItem, Source, UiState } from "../../types";

type Props = {
  state: UiState;
  message: string;
  details?: string;
  chatHistory: ChatMessage[];
  chatQuestion: string;
  chatPending: boolean;
  hasIndexedDocuments: boolean;
  exampleQuestions: string[];
  documentsById: Record<number, DocumentItem>;
  onQuestionChange: (value: string) => void;
  onAsk: () => void;
  onRetry: () => void;
  onUseExample: (q: string) => void;
  onLoadSnippet: (messageId: string, source: Source) => void;
  historyRef: RefObject<HTMLDivElement>;
};

export default function ChatCard(props: Props) {
  const formatDocumentDate = (value?: string | null) => {
    if (!value) return "unbekannt";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "unbekannt";
    return date.toLocaleDateString("de-DE");
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
        <h2>Chat über Dokumente</h2>
        {props.state === "loading" ? <span className="card-title-spinner" aria-hidden="true" /> : null}
      </div>
      <StatusBanner state={props.state} message={props.message} details={props.details} />
      <div id="chatHistory" className="chat-history" ref={props.historyRef}>
        {props.chatHistory.length === 0 ? (
          <div className="chat-empty">
            <div className="empty-state-title">Noch keine Nachrichten</div>
            <div>Starte mit einer Beispiel-Frage:</div>
            <div className="empty-actions">
              {props.exampleQuestions.map((q) => (
                <button key={q} className="chip" disabled={props.chatPending || !props.hasIndexedDocuments} onClick={() => props.onUseExample(q)}>
                  {q}
                </button>
              ))}
            </div>
          </div>
        ) : (
          props.chatHistory.map((msg) => (
            <div className={`bubble ${msg.role === "user" ? "bubble-user" : "bubble-assistant"}`} key={msg.id}>
              <div className="bubble-role">{msg.role === "user" ? "Du" : "Assistant"}</div>
              <div className="bubble-text">{msg.text}</div>
              {msg.role === "assistant" ? (
                <div className="bubble-actions">
                  <button className="chip" disabled={props.chatPending} onClick={() => void copyAnswer(msg.text)}>
                    Antwort kopieren
                  </button>
                </div>
              ) : null}
              {msg.role === "assistant" && msg.sources && msg.sources.length > 0 ? (
                <details className="sources">
                  <summary>Quellen ({msg.sources.length})</summary>
                  <ul className="sources-list">
                    {msg.sources.map((s) => {
                      const key = `${s.document_id}:${s.chunk_id}`;
                      const doc = props.documentsById[s.document_id];
                      const sourceLabel = doc?.filename || `Dokument ${s.document_id}`;
                      return (
                        <li className="source-row" key={`${msg.id}-${key}`}>
                          <div>
                            Quelle: {sourceLabel}
                          </div>
                          <div>
                            Stand: Dokument vom {formatDocumentDate(doc?.uploaded_at)}
                          </div>
                          <div>
                            document_id: {s.document_id}, chunk_id: {s.chunk_id}, score:{" "}
                            {typeof s.score === "number" ? s.score.toFixed(3) : "-"}
                          </div>
                          <button className="source-btn" disabled={props.chatPending} onClick={() => props.onLoadSnippet(msg.id, s)}>
                            Snippet laden
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
        {!props.hasIndexedDocuments ? (
          <div className="chat-hint">
            Keine indexierten Dokumente gefunden. Bitte zuerst mindestens ein Dokument hochladen und verarbeiten.
          </div>
        ) : null}
        {props.state === "error" ? (
          <div className="empty-actions">
            <button className="chip" disabled={props.chatPending} onClick={props.onRetry}>
              Erneut versuchen
            </button>
          </div>
        ) : null}
        <textarea
          rows={3}
          placeholder="z.B. Welche Zahlungen sind 2026 fällig?"
          value={props.chatQuestion}
          disabled={!props.hasIndexedDocuments || props.chatPending}
          onChange={(e) => props.onQuestionChange(e.target.value)}
        />
        <button className="btn" disabled={!props.hasIndexedDocuments || props.chatPending} onClick={props.onAsk}>
          {props.chatPending ? "Frage läuft..." : "Frage senden"}
        </button>
      </div>
    </section>
  );
}

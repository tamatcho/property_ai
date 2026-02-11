import { useRef } from "react";
import StatusBanner from "../StatusBanner";
import { DocumentItem, DocumentStatus, UiState } from "../../types";

type Props = {
  state: UiState;
  message: string;
  details?: string;
  selectedFilesCount: number;
  uploadErrors: string[];
  uploadPending: boolean;
  progressVisible: boolean;
  progressPercent: number;
  progressText: string;
  uploadOutput: string;
  documents: DocumentItem[];
  documentStatuses: Record<number, DocumentStatus>;
  onFiles: (files: File[]) => void;
  onUpload: () => void;
  onRetry: () => void;
  onDeleteDocument: (doc: DocumentItem) => void;
  onReprocessDocument: (doc: DocumentItem) => void;
  actionsPending: boolean;
};

export default function UploadCard(props: Props) {
  const dropRef = useRef<HTMLDivElement | null>(null);
  const statusLabel = (status: DocumentStatus) => {
    if (status === "indexed") return "Indexed";
    if (status === "processing") return "Processing";
    return "Error";
  };

  return (
    <section id="uploadCard" className="card reveal" data-state={props.state}>
      <div className="card-title-row">
        <h2>PDF/ZIP Upload</h2>
        {props.state === "loading" ? <span className="card-title-spinner" aria-hidden="true" /> : null}
      </div>
      <div className="upload-panel-scroll">
        <StatusBanner state={props.state} message={props.message} details={props.details} />
        {props.selectedFilesCount === 0 ? (
          <div className="empty-state">
            <div className="empty-state-title">Keine Datei ausgewählt</div>
            <div>Ziehe PDFs/ZIPs hierher oder klicke auf Dateiauswahl.</div>
          </div>
        ) : null}

        <div
          ref={dropRef}
          className="dropzone"
          onDragOver={(e) => {
            e.preventDefault();
            dropRef.current?.classList.add("drag-over");
          }}
          onDragLeave={() => dropRef.current?.classList.remove("drag-over")}
          onDrop={(e) => {
            e.preventDefault();
            dropRef.current?.classList.remove("drag-over");
            props.onFiles(Array.from(e.dataTransfer.files));
          }}
        >
          <p>Dateien hier ablegen oder auswählen</p>
          <small>PDF oder ZIP (mit PDFs), max. 20 MB pro Datei</small>
          <input
            type="file"
            accept=".pdf,application/pdf,.zip,application/zip,application/x-zip-compressed"
            multiple
            disabled={props.uploadPending}
            onChange={(e) => props.onFiles(Array.from(e.target.files || []))}
          />
        </div>

        <div className="validation-list">
          {props.uploadErrors.map((err, i) => (
            <div className="validation-item" key={`${err}-${i}`}>
              {err}
            </div>
          ))}
        </div>

        <div className="row wrap">
          <button className="btn" disabled={props.uploadPending} onClick={props.onUpload}>
            {props.uploadPending ? "Lade hoch..." : "Ausgewählte hochladen"}
          </button>
          {props.state === "error" && props.selectedFilesCount > 0 ? (
            <button className="chip" disabled={props.uploadPending} onClick={props.onRetry}>
              Erneut versuchen
            </button>
          ) : null}
        </div>

        {props.progressVisible ? (
          <div className="progress-wrap">
            <div className="progress-track">
              <div className="progress-bar" style={{ width: `${props.progressPercent}%` }} />
            </div>
            <div className="progress-text">{props.progressText}</div>
          </div>
        ) : null}

        <pre className="output">{props.uploadOutput}</pre>

        <div className="docs-list-wrap">
          <h3>Hochgeladene Dokumente</h3>
          <div className="doc-caption">Diese Dokumente bilden die Grundlage für Fristen, Zahlungen und Antworten.</div>
          <div className="docs-list">
            {props.documents.length === 0 ? (
              <div className="docs-list-empty">
                <div className="empty-state-title">Noch keine Dokumente</div>
                <div>Lade eine PDF oder ein ZIP mit PDFs hoch, um Chat und Timeline mit Quellen zu nutzen.</div>
              </div>
            ) : (
              props.documents.map((doc) => (
                <div className="doc-item" key={`${doc.document_id}-${doc.filename}`}>
                  <div className="doc-leading" aria-hidden="true">
                    <span className="doc-icon">PDF</span>
                  </div>
                  <div className="doc-main">
                    <div className="doc-name" title={doc.filename}>
                      {doc.filename}
                    </div>
                    <div className="doc-time">Hochgeladen: {doc.uploaded_at ? new Date(doc.uploaded_at).toLocaleString("de-DE") : "-"}</div>
                  </div>
                  <div
                    className={`doc-status-badge status-${props.documentStatuses[doc.document_id] || "indexed"}`}
                    title="Verarbeitungsstatus"
                  >
                    {statusLabel(props.documentStatuses[doc.document_id] || "indexed")}
                  </div>
                  <details className="doc-menu">
                    <summary aria-label={`Aktionen für ${doc.filename}`}>⋯</summary>
                    <div className="doc-menu-popover">
                      <div className="doc-menu-details">
                        <div>ID: {doc.document_id}</div>
                        <div>{doc.uploaded_at ? new Date(doc.uploaded_at).toLocaleString("de-DE") : "-"}</div>
                      </div>
                      <button className="doc-menu-item" disabled={props.actionsPending} onClick={() => props.onReprocessDocument(doc)}>
                        Neu verarbeiten
                      </button>
                      <button className="doc-menu-item danger" disabled={props.actionsPending} onClick={() => props.onDeleteDocument(doc)}>
                        Löschen
                      </button>
                    </div>
                  </details>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

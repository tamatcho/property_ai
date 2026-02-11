import { useEffect, useMemo, useRef, useState } from "react";
import ChatCard from "./components/cards/ChatCard";
import TimelineCard from "./components/cards/TimelineCard";
import UploadCard from "./components/cards/UploadCard";
import ToastContainer from "./components/ToastContainer";
import { apiCall, normalizeApiError, uploadWithProgress } from "./lib/api";
import { ChatMessage, DocumentItem, DocumentStatus, Source, TimelineItem, Toast, UiState } from "./types";

const BASE_KEY = "property_ai_base_url";
const CHAT_HISTORY_KEY = "property_ai_chat_history";
const DEFAULT_API_BASE = (import.meta.env.VITE_API_BASE_URL || "http://127.0.0.1:8000").replace(/\/+$/, "");
const MAX_FILE_SIZE = 20 * 1024 * 1024;
const EXAMPLE_QUESTIONS = [
  "Welche Zahlungen sind 2026 fällig?",
  "Wann ist die nächste Eigentümerversammlung?",
  "Welche Fristen stehen bald an?"
];

function uuid() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function normalizeCategory(category: string) {
  return ["meeting", "payment", "deadline", "info"].includes(category) ? category : "info";
}

function timelinePriority(category: string) {
  const normalized = normalizeCategory(category);
  if (normalized === "deadline") return 0;
  if (normalized === "payment") return 1;
  if (normalized === "meeting") return 2;
  return 3;
}

export default function App() {
  const [apiBase, setApiBase] = useState(
    () => (localStorage.getItem(BASE_KEY) || DEFAULT_API_BASE).replace(/\/+$/, "")
  );

  const [apiState, setApiState] = useState<UiState>("idle");
  const [apiOutput, setApiOutput] = useState("");

  const [uploadState, setUploadState] = useState<UiState>("idle");
  const [uploadMessage, setUploadMessage] = useState("Bereit");
  const [uploadDetails, setUploadDetails] = useState("PDF oder ZIP auswählen und hochladen.");
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [uploadErrors, setUploadErrors] = useState<string[]>([]);
  const [uploadOutput, setUploadOutput] = useState("");
  const [uploadPending, setUploadPending] = useState(false);
  const [progressVisible, setProgressVisible] = useState(false);
  const [progressPercent, setProgressPercent] = useState(0);
  const [progressText, setProgressText] = useState("0%");
  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [documentStatuses, setDocumentStatuses] = useState<Record<number, DocumentStatus>>({});
  const [documentActionsPending, setDocumentActionsPending] = useState(false);

  const [chatState, setChatState] = useState<UiState>("idle");
  const [chatMessage, setChatMessage] = useState("Bereit");
  const [chatDetails, setChatDetails] = useState("Frage zu indexierten Dokumenten stellen.");
  const [chatQuestion, setChatQuestion] = useState("");
  const [chatPending, setChatPending] = useState(false);
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>(() => {
    try {
      const raw = localStorage.getItem(CHAT_HISTORY_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  });

  const [timelineState, setTimelineState] = useState<UiState>("idle");
  const [timelineMessage, setTimelineMessage] = useState("Bereit");
  const [timelineDetails, setTimelineDetails] = useState("Rohtext einfügen und Termine extrahieren.");
  const [timelineInput, setTimelineInput] = useState("");
  const [timelineItems, setTimelineItems] = useState<TimelineItem[]>([]);
  const [timelineSearch, setTimelineSearch] = useState("");
  const [timelineCategory, setTimelineCategory] = useState("");
  const [lastChatQuestion, setLastChatQuestion] = useState("");
  const [lastTimelineAction, setLastTimelineAction] = useState<"raw" | "load" | null>(null);

  const [toasts, setToasts] = useState<Toast[]>([]);
  const chatHistoryRef = useRef<HTMLDivElement>(null);
  const isLocalDev = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";

  useEffect(() => {
    localStorage.setItem(BASE_KEY, apiBase);
  }, [apiBase]);

  useEffect(() => {
    localStorage.setItem(CHAT_HISTORY_KEY, JSON.stringify(chatHistory));
  }, [chatHistory]);

  useEffect(() => {
    if (!chatHistoryRef.current) return;
    chatHistoryRef.current.scrollTop = chatHistoryRef.current.scrollHeight;
  }, [chatHistory]);

  const addToast = (type: Toast["type"], title: string, details?: string) => {
    const id = uuid();
    setToasts((prev) => [...prev, { id, type, title, details }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 3000);
  };

  const loadDocuments = async () => {
    try {
      const { data: docs } = await apiCall<DocumentItem[]>(`${apiBase}/documents`);
      const normalized = Array.isArray(docs) ? docs : [];
      setDocuments(normalized);
      setDocumentStatuses((prev) => {
        const next = { ...prev };
        for (const doc of normalized) {
          if (!next[doc.document_id]) next[doc.document_id] = "indexed";
        }
        return next;
      });
      return normalized;
    } catch {
      // no-op
      return [];
    }
  };

  const runHealthCheck = async (withToast = false) => {
    setApiState("loading");
    try {
      const { data, latencyMs: latency } = await apiCall<{ ok: boolean }>(`${apiBase}/health`, { timeoutMs: 10000 });
      setApiOutput(JSON.stringify(data, null, 2));
      setApiState("success");
      if (withToast) addToast("success", "Backend erreichbar", `${latency} ms`);
    } catch {
      setApiOutput(JSON.stringify({ error: "Backend nicht erreichbar." }, null, 2));
      setApiState("error");
      if (withToast) addToast("error", "Backend nicht erreichbar", "Prüfe URL und Serverstatus, dann erneut versuchen.");
    }
  };

  useEffect(() => {
    const boot = async () => {
      const docs = await loadDocuments();
      if (docs.length > 0) {
        await loadTimelineFromStore(false);
      }
    };
    void boot();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void runHealthCheck(false);
    const timer = window.setInterval(() => {
      void runHealthCheck(false);
    }, 60000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiBase]);

  const runHealth = async () => {
    await runHealthCheck(true);
  };

  const retryChat = async () => {
    if (!lastChatQuestion) return;
    await askChat(lastChatQuestion);
  };

  const retryTimeline = async () => {
    if (lastTimelineAction === "raw") {
      await extractTimeline();
      return;
    }
    await loadTimelineFromStore(true);
  };

  const validateFiles = (files: File[]) => {
    const valid: File[] = [];
    const errors: string[] = [];
    for (const file of files) {
      const isPdfType = file.type === "application/pdf";
      const hasPdfExt = file.name.toLowerCase().endsWith(".pdf");
      const isZipType = ["application/zip", "application/x-zip-compressed"].includes(file.type);
      const hasZipExt = file.name.toLowerCase().endsWith(".zip");
      if ((!isPdfType && !hasPdfExt) && (!isZipType && !hasZipExt)) {
        errors.push(`${file.name}: nur PDF- oder ZIP-Dateien sind erlaubt.`);
        continue;
      }
      if (file.size > MAX_FILE_SIZE) {
        errors.push(`${file.name}: Datei ist größer als 20 MB.`);
        continue;
      }
      valid.push(file);
    }
    return { valid, errors };
  };

  const addFiles = (files: File[]) => {
    const { valid, errors } = validateFiles(files);
    setSelectedFiles((prev) => {
      const map = new Map(prev.map((f) => [`${f.name}:${f.size}`, f]));
      for (const file of valid) map.set(`${file.name}:${file.size}`, file);
      return Array.from(map.values());
    });
    setUploadErrors([...errors, ...(valid.length ? [`${valid.length} Datei(en) hinzugefügt.`] : [])]);
    if (errors.length > 0) {
      setUploadState("error");
      setUploadMessage("Ungültige Dateien erkannt");
      setUploadDetails(`${errors.length} Datei(en) abgelehnt.`);
    } else {
      setUploadState("idle");
      setUploadMessage("Bereit");
      setUploadDetails("PDF oder ZIP auswählen und hochladen.");
    }
  };

  const onUpload = async () => {
    if (!selectedFiles.length) {
      setUploadErrors(["Bitte mindestens eine gültige PDF- oder ZIP-Datei auswählen."]);
      setUploadState("error");
      setUploadMessage("Keine Datei gewählt");
      addToast("error", "Upload fehlgeschlagen", "Bitte gültige PDF- oder ZIP-Dateien wählen.");
      return;
    }

    setUploadPending(true);
    setUploadState("loading");
    setUploadMessage("Upload läuft...");
    setUploadDetails(`${selectedFiles.length} Datei(en)`);
    setUploadOutput("Upload läuft...");
    setProgressVisible(true);
    setProgressPercent(0);
    setProgressText("0%");

    let uploadedDocuments = 0;
    let failedItems = 0;
    const lines: string[] = [];

    for (let i = 0; i < selectedFiles.length; i += 1) {
      const file = selectedFiles[i];
      try {
        const data = await uploadWithProgress(apiBase, file, (loaded, total) => {
          const current = total ? loaded / total : 0;
          const overall = ((i + current) / selectedFiles.length) * 100;
          setProgressPercent(Math.max(0, Math.min(100, overall)));
          setProgressText(`${Math.round(overall)}% (${i + 1}/${selectedFiles.length}) ${file.name}`);
        });
        if (Array.isArray(data.documents)) {
          const processedCount = Number(data.processed_count || 0);
          const failedCount = Number(data.failed_count || 0);
          uploadedDocuments += processedCount;
          failedItems += failedCount;
          lines.push(`ZIP ${data.archive_filename}: ${processedCount} PDF(s) verarbeitet, ${failedCount} fehlgeschlagen`);

          for (const doc of data.documents) {
            lines.push(`OK ${doc.filename} (document_id: ${doc.document_id}, indexed chunks: ${doc.chunks_indexed})`);
            if (typeof doc.document_id === "number") {
              setDocumentStatuses((prev) => ({ ...prev, [doc.document_id]: "indexed" }));
            }
          }
          if (Array.isArray(data.failed_documents)) {
            for (const failedDoc of data.failed_documents) {
              lines.push(`FAIL ${failedDoc.filename}: ${failedDoc.reason}`);
            }
          }
        } else {
          uploadedDocuments += 1;
          lines.push(`OK ${data.filename} (document_id: ${data.document_id}, indexed chunks: ${data.chunks_indexed})`);
          if (typeof data.document_id === "number") {
            setDocumentStatuses((prev) => ({ ...prev, [data.document_id]: "indexed" }));
          }
        }
      } catch (e) {
        failedItems += 1;
        const message = normalizeApiError(e, "Fehler");
        lines.push(`FAIL ${file.name}: ${message}`);
      }
    }

    setUploadOutput(lines.join("\n"));
    setProgressPercent(100);
    setProgressText(`100% abgeschlossen`);

    if (failedItems === 0) {
      setUploadState("success");
      setUploadMessage("Upload erfolgreich");
      setUploadDetails(`${uploadedDocuments} Dokument(e) verarbeitet.`);
      addToast("success", "Upload erfolgreich", `${uploadedDocuments} Dokument(e)`);
    } else if (uploadedDocuments > 0) {
      setUploadState("error");
      setUploadMessage("Teilweise fehlgeschlagen");
      setUploadDetails(`${uploadedDocuments} Dokument(e) verarbeitet, ${failedItems} Fehler.`);
      addToast("error", "Upload teilweise fehlgeschlagen", `${failedItems} Fehler`);
    } else {
      setUploadState("error");
      setUploadMessage("Upload fehlgeschlagen");
      setUploadDetails(`${failedItems} Fehler`);
      addToast("error", "Upload fehlgeschlagen", `${failedItems} Fehler`);
    }

    setUploadPending(false);
    if (failedItems === 0) {
      setSelectedFiles([]);
    }
    window.setTimeout(() => {
      setProgressVisible(false);
      setProgressPercent(0);
      setProgressText("0%");
    }, 600);
    await loadDocuments();
    if (failedItems === 0 && uploadedDocuments > 0) {
      await loadTimelineFromStore(false);
    }
  };

  const askChat = async (question: string) => {
    if (!question.trim()) {
      setChatState("error");
      setChatMessage("Leere Frage");
      addToast("error", "Chat fehlgeschlagen", "Bitte Frage eingeben.");
      return;
    }

    const q = question.trim();
    setLastChatQuestion(q);
    setChatHistory((prev) => [...prev, { id: uuid(), role: "user", text: q }]);
    setChatQuestion("");
    setChatPending(true);
    setChatState("loading");
    setChatMessage("Frage läuft...");

    try {
      const { data } = await apiCall<{ answer: string; sources: Source[] }>(`${apiBase}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q }),
        timeoutMs: 30000
      });
      setChatHistory((prev) => [
        ...prev,
        { id: uuid(), role: "assistant", text: data.answer || "", sources: data.sources || [], sourceDetails: {} }
      ]);
      setChatState("success");
      setChatMessage("Antwort erhalten");
      setChatDetails(`${data.sources?.length || 0} Quellen im Kontext.`);
      addToast("success", "Chat erfolgreich", `${data.sources?.length || 0} Quellen`);
    } catch (e) {
      const message = normalizeApiError(e, "Unbekannter Fehler");
      setChatHistory((prev) => [...prev, { id: uuid(), role: "assistant", text: `Fehler: ${message}` }]);
      setChatState("error");
      setChatMessage("Chat fehlgeschlagen");
      setChatDetails(message);
      addToast("error", "Chat fehlgeschlagen", `${message} - mit Retry erneut senden.`);
    } finally {
      setChatPending(false);
    }
  };

  const loadSourceSnippet = async (messageId: string, source: Source) => {
    try {
      const { data } = await apiCall<{ snippet: string }>(
        `${apiBase}/documents/source?document_id=${encodeURIComponent(source.document_id)}&chunk_id=${encodeURIComponent(
          source.chunk_id
        )}`
      );
      setChatHistory((prev) =>
        prev.map((msg) => {
          if (msg.id !== messageId) return msg;
          const details = { ...(msg.sourceDetails || {}) };
          details[`${source.document_id}:${source.chunk_id}`] = data.snippet || "";
          return { ...msg, sourceDetails: details };
        })
      );
    } catch (e) {
      const message = normalizeApiError(e, "Unbekannter Fehler");
      addToast("error", "Snippet konnte nicht geladen werden", message);
    }
  };

  const extractTimeline = async () => {
    if (!timelineInput.trim()) {
      setTimelineState("error");
      setTimelineMessage("Kein Text");
      addToast("error", "Timeline fehlgeschlagen", "Bitte Text einfügen.");
      return;
    }
    setLastTimelineAction("raw");
    setTimelineState("loading");
    setTimelineMessage("Extraktion läuft...");
    try {
      const { data } = await apiCall<{ items: TimelineItem[] }>(`${apiBase}/timeline/extract`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ raw_text: timelineInput }),
        timeoutMs: 45000
      });
      const items = Array.isArray(data.items) ? data.items : [];
      setTimelineItems(items);
      setTimelineState("success");
      setTimelineMessage("Timeline extrahiert");
      setTimelineDetails(`${items.length} Einträge gefunden.`);
      addToast("success", "Timeline extrahiert", `${items.length} Einträge`);
    } catch (e) {
      const message = normalizeApiError(e, "Unbekannter Fehler");
      setTimelineState("error");
      setTimelineMessage("Extraktion fehlgeschlagen");
      setTimelineDetails(message);
      addToast("error", "Timeline fehlgeschlagen", `${message} - bitte Retry nutzen.`);
    }
  };

  const loadTimelineFromStore = async (validateHasDocuments = true) => {
    if (validateHasDocuments && documents.length === 0) {
      setTimelineState("error");
      setTimelineMessage("Keine Dokumente");
      setTimelineDetails("Bitte zuerst mindestens ein PDF hochladen.");
      addToast("error", "Timeline fehlgeschlagen", "Keine hochgeladenen Dokumente gefunden.");
      return;
    }

    setLastTimelineAction("load");
    setTimelineState("loading");
    setTimelineMessage("Lade gespeicherte Timeline...");
    setTimelineDetails(`${documents.length} Dokument(e) im Bestand.`);
    try {
      const { data } = await apiCall<TimelineItem[]>(`${apiBase}/timeline`, {
        timeoutMs: 15000
      });
      const items = Array.isArray(data) ? data : [];
      setTimelineItems(items);
      setTimelineState("success");
      setTimelineMessage("Timeline geladen");
      setTimelineDetails(`${items.length} Einträge aus persistierter Timeline.`);
      addToast("success", "Timeline geladen", `${items.length} Einträge`);
    } catch (e) {
      const message = normalizeApiError(e, "Unbekannter Fehler");
      setTimelineState("error");
      setTimelineMessage("Timeline laden fehlgeschlagen");
      setTimelineDetails(message);
      addToast("error", "Timeline laden fehlgeschlagen", `${message} - mit Retry erneut versuchen.`);
    }
  };

  const onDeleteDocument = async (doc: DocumentItem) => {
    addToast("error", "Löschen nicht verfügbar", `Kein Delete-Endpoint vorhanden (${doc.filename}).`);
  };

  const onReprocessDocument = async (doc: DocumentItem) => {
    setDocumentActionsPending(true);
    setDocumentStatuses((prev) => ({ ...prev, [doc.document_id]: "processing" }));
    try {
      await apiCall<{
        items: TimelineItem[];
        documents_considered: number;
        documents_processed: number;
        documents_failed: Array<{ document_id: number; filename: string; reason: string }>;
      }>(`${apiBase}/timeline/extract-documents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ document_ids: [doc.document_id] }),
        timeoutMs: 60000
      });
      setDocumentStatuses((prev) => ({ ...prev, [doc.document_id]: "indexed" }));
      addToast("success", "Neu verarbeitet", `${doc.filename} ist wieder indexiert.`);
      await loadTimelineFromStore(false);
    } catch (e) {
      const message = normalizeApiError(e, "Unbekannter Fehler");
      setDocumentStatuses((prev) => ({ ...prev, [doc.document_id]: "error" }));
      addToast("error", "Neuverarbeitung fehlgeschlagen", `${message} - bitte Retry aus dem Menü.`);
    } finally {
      setDocumentActionsPending(false);
    }
  };

  const filteredTimeline = useMemo(() => {
    const sorted = [...timelineItems].sort((a, b) => {
      const da = new Date(a.date_iso).getTime();
      const db = new Date(b.date_iso).getTime();
      if (da !== db) return da - db;
      const pa = timelinePriority(a.category || "info");
      const pb = timelinePriority(b.category || "info");
      if (pa !== pb) return pa - pb;
      return (a.time_24h || "99:99").localeCompare(b.time_24h || "99:99");
    });

    return sorted.filter((item) => {
      const category = normalizeCategory(item.category);
      if (timelineCategory && category !== timelineCategory) return false;
      const q = timelineSearch.trim().toLowerCase();
      if (!q) return true;
      return `${item.title || ""} ${item.description || ""}`.toLowerCase().includes(q);
    });
  }, [timelineItems, timelineCategory, timelineSearch]);

  const timelineCategories = useMemo(
    () => Array.from(new Set(timelineItems.map((x) => normalizeCategory(x.category || "info")))).sort(),
    [timelineItems]
  );

  const timelineCurrentItems = useMemo(() => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const next60 = new Date(start);
    next60.setDate(next60.getDate() + 60);
    const last14 = new Date(start);
    last14.setDate(last14.getDate() - 14);
    const infoNearFuture = new Date(start);
    infoNearFuture.setDate(infoNearFuture.getDate() + 7);

    return filteredTimeline.filter((item) => {
      const dt = new Date(item.date_iso);
      if (Number.isNaN(dt.getTime())) return false;
      const category = normalizeCategory(item.category || "info");
      const isInfo = category === "info";

      const isUpcomingNonInfo = !isInfo && dt >= start;
      const isDeadlineOrPaymentSoon = (category === "deadline" || category === "payment") && dt >= start && dt <= next60;
      const isRecentlyRelevant = dt < start && dt >= last14;
      const isInfoNearFuture = isInfo && dt >= start && dt <= infoNearFuture;

      // Info-only items are moved to archive unless they are very near-term or recently relevant.
      if (isInfo) return isInfoNearFuture || isRecentlyRelevant;

      return isUpcomingNonInfo || isDeadlineOrPaymentSoon || isRecentlyRelevant;
    });
  }, [filteredTimeline]);

  const timelineArchiveItems = useMemo(() => {
    const currentSet = new Set(timelineCurrentItems);
    return filteredTimeline.filter((item) => !currentSet.has(item));
  }, [filteredTimeline, timelineCurrentItems]);

  const groupTimelineByDate = (items: TimelineItem[]) => {
    const map = new Map<string, TimelineItem[]>();
    for (const item of items) {
      const key = item.date_iso || "Unbekannt";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(item);
    }
    return Array.from(map.entries());
  };

  const timelineCurrentGrouped = useMemo(() => groupTimelineByDate(timelineCurrentItems), [timelineCurrentItems]);
  const timelineArchiveGrouped = useMemo(() => groupTimelineByDate(timelineArchiveItems), [timelineArchiveItems]);

  const documentsById = useMemo(
    () =>
      Object.fromEntries(
        documents.map((doc) => [doc.document_id, doc] as const)
      ) as Record<number, DocumentItem>,
    [documents]
  );

  const hasIndexedDocuments = useMemo(
    () => documents.some((doc) => documentStatuses[doc.document_id] === "indexed"),
    [documents, documentStatuses]
  );

  const activeWorkflowStep = useMemo(() => {
    if (uploadPending) return 2;
    if (documents.length > 0) return 3;
    return 1;
  }, [uploadPending, documents.length]);

  const apiIndicator = apiState === "loading" ? "Prüfe Verbindung..." : apiState === "error" ? "Nicht erreichbar" : "Bereit";

  return (
    <>
      <div className="bg-orb orb-a" />
      <div className="bg-orb orb-b" />

      <main className="shell">
        <section className="layout-top reveal">
          <header className="hero hero-compact">
            <div className="hero-topline">
              <p className="eyebrow">Property AI</p>
              <span className={`api-indicator ${apiState === "error" ? "is-offline" : apiState === "loading" ? "is-loading" : "is-ready"}`}>
                {apiIndicator}
              </span>
            </div>
            <h1>Dokumente verstehen. Fragen stellen. Fristen sehen.</h1>
            <p className="sub">Upload links, Timeline rechts, Chat unten.</p>
          </header>
          {isLocalDev ? (
            <details className="dev-details">
              <summary>Entwickler-Details</summary>
              <div className="dev-details-grid">
                <label htmlFor="apiBase">Backend-URL</label>
                <input id="apiBase" value={apiBase} onChange={(e) => setApiBase(e.target.value)} />
                <div className="row wrap">
                  <button className="btn" onClick={() => void runHealth()} disabled={apiState === "loading"}>
                    Verbinden
                  </button>
                </div>
                <pre className="output">{apiOutput}</pre>
              </div>
            </details>
          ) : null}
        </section>

        <section className="workflow-stepper reveal" aria-label="Arbeitsfortschritt">
          <div className={`workflow-step ${activeWorkflowStep === 1 ? "is-active" : ""}`}>
            <span className="workflow-step-index">1</span>
            <span className="workflow-step-label">PDF hochladen</span>
          </div>
          <div className={`workflow-step ${activeWorkflowStep === 2 ? "is-active" : ""}`}>
            <span className="workflow-step-index">2</span>
            <span className="workflow-step-label">Verarbeitet</span>
          </div>
          <div className={`workflow-step ${activeWorkflowStep === 3 ? "is-active" : ""}`}>
            <span className="workflow-step-index">3</span>
            <span className="workflow-step-label">Fristen & Fragen</span>
          </div>
        </section>

        <section className="layout-main">
          <div className="layout-left">
            <UploadCard
              state={uploadState}
              message={uploadMessage}
              details={uploadDetails}
              selectedFilesCount={selectedFiles.length}
              uploadErrors={uploadErrors}
              uploadPending={uploadPending}
              progressVisible={progressVisible}
              progressPercent={progressPercent}
              progressText={progressText}
              uploadOutput={uploadOutput}
              documents={documents}
              documentStatuses={documentStatuses}
              onFiles={addFiles}
              onUpload={() => void onUpload()}
              onRetry={() => void onUpload()}
              onDeleteDocument={(doc) => void onDeleteDocument(doc)}
              onReprocessDocument={(doc) => void onReprocessDocument(doc)}
              actionsPending={documentActionsPending}
            />
          </div>

          <div className="layout-right">
            <TimelineCard
              state={timelineState}
              message={timelineMessage}
              details={timelineDetails}
              hasDocuments={documents.length > 0}
              timelineItems={timelineItems}
              timelineInput={timelineInput}
              timelineSearch={timelineSearch}
              timelineCategory={timelineCategory}
              timelineCategories={timelineCategories}
              timelineCurrentGrouped={timelineCurrentGrouped}
              timelineArchiveGrouped={timelineArchiveGrouped}
              pending={timelineState === "loading"}
              onInputChange={setTimelineInput}
              onExtract={() => void extractTimeline()}
              onExtractDocuments={() => void loadTimelineFromStore(true)}
              onRetry={() => void retryTimeline()}
              onSearchChange={setTimelineSearch}
              onCategoryChange={setTimelineCategory}
              normalizeCategory={normalizeCategory}
            />
          </div>
        </section>

        <section className="layout-bottom">
          <ChatCard
            state={chatState}
            message={chatMessage}
            details={chatDetails}
            chatHistory={chatHistory}
            chatQuestion={chatQuestion}
            chatPending={chatPending}
            hasIndexedDocuments={hasIndexedDocuments}
            exampleQuestions={EXAMPLE_QUESTIONS}
            documentsById={documentsById}
            onQuestionChange={setChatQuestion}
            onAsk={() => void askChat(chatQuestion)}
            onRetry={() => void retryChat()}
            onUseExample={setChatQuestion}
            onLoadSnippet={(messageId, source) => void loadSourceSnippet(messageId, source)}
            historyRef={chatHistoryRef}
          />
        </section>
      </main>

      <ToastContainer toasts={toasts} />
    </>
  );
}

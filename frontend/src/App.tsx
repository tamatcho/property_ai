import type { KeyboardEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import ChatCard from "./components/cards/ChatCard";
import TimelineCard from "./components/cards/TimelineCard";
import UploadCard from "./components/cards/UploadCard";
import ToastContainer from "./components/ToastContainer";
import { ApiError, apiFetch, normalizeApiError, uploadWithProgress } from "./lib/api";
import { AuthUser, ChatMessage, DocumentItem, DocumentStatus, PropertyItem, Source, TimelineItem, Toast, UiState } from "./types";

const BASE_KEY = "ndiah_base_url";
const CHAT_HISTORY_KEY_PREFIX = "ndiah_chat_history";
const ACTIVE_PROPERTY_KEY = "ndiah_active_property_id";
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
  return ["meeting", "payment", "deadline", "info", "tax"].includes(category) ? category : "info";
}

function timelinePriority(category: string) {
  const normalized = normalizeCategory(category);
  if (normalized === "deadline") return 0;
  if (normalized === "payment") return 1;
  if (normalized === "meeting") return 2;
  if (normalized === "info") return 3;
  return 4;
}

export default function App() {
  const [apiBase, setApiBase] = useState(
    () => (localStorage.getItem(BASE_KEY) || DEFAULT_API_BASE).replace(/\/+$/, "")
  );

  const [apiState, setApiState] = useState<UiState>("idle");
  const [apiOutput, setApiOutput] = useState("");
  const [firstHealthChecked, setFirstHealthChecked] = useState(false);
  const [showColdStartBanner, setShowColdStartBanner] = useState(false);
  const [currentUser, setCurrentUser] = useState<AuthUser | null>(null);
  const [authEmail, setAuthEmail] = useState("");
  const [authPending, setAuthPending] = useState(false);
  const [magicLink, setMagicLink] = useState("");
  const [properties, setProperties] = useState<PropertyItem[]>([]);
  const [newPropertyName, setNewPropertyName] = useState("");
  const [propertiesPending, setPropertiesPending] = useState(false);
  const [activePropertyId, setActivePropertyId] = useState<number | null>(() => {
    const raw = localStorage.getItem(ACTIVE_PROPERTY_KEY);
    if (!raw) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  });

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
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([]);

  const [timelineState, setTimelineState] = useState<UiState>("idle");
  const [timelineMessage, setTimelineMessage] = useState("Bereit");
  const [timelineDetails, setTimelineDetails] = useState("Rohtext einfügen und Termine extrahieren.");
  const [timelineInput, setTimelineInput] = useState("");
  const [timelineItems, setTimelineItems] = useState<TimelineItem[]>([]);
  const [timelineRenderSeed, setTimelineRenderSeed] = useState(0);
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
    if (activePropertyId == null) {
      localStorage.removeItem(ACTIVE_PROPERTY_KEY);
    } else {
      localStorage.setItem(ACTIVE_PROPERTY_KEY, String(activePropertyId));
    }
  }, [activePropertyId]);

  useEffect(() => {
    if (!activePropertyId) return;
    localStorage.setItem(`${CHAT_HISTORY_KEY_PREFIX}:${activePropertyId}`, JSON.stringify(chatHistory));
  }, [chatHistory, activePropertyId]);

  useEffect(() => {
    if (!activePropertyId) {
      setChatHistory([]);
      return;
    }
    try {
      const raw = localStorage.getItem(`${CHAT_HISTORY_KEY_PREFIX}:${activePropertyId}`);
      const parsed = raw ? JSON.parse(raw) : [];
      setChatHistory(Array.isArray(parsed) ? parsed : []);
    } catch {
      setChatHistory([]);
    }
  }, [activePropertyId]);

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

  const loadMe = async () => {
    try {
      const { data } = await apiFetch<AuthUser>(`${apiBase}/auth/me`);
      setCurrentUser(data);
      return data;
    } catch {
      setCurrentUser(null);
      return null;
    }
  };

  const loadProperties = async () => {
    try {
      const { data } = await apiFetch<PropertyItem[]>(`${apiBase}/properties`);
      const list = Array.isArray(data) ? data : [];
      setProperties(list);
      if (!list.some((p) => p.id === activePropertyId)) {
        setActivePropertyId(list[0]?.id ?? null);
      }
      return list;
    } catch (e) {
      setProperties([]);
      setActivePropertyId(null);
      addToast("error", "Properties konnten nicht geladen werden", normalizeApiError(e));
      return [];
    }
  };

  const requestMagicLink = async () => {
    const email = authEmail.trim();
    if (!email) {
      addToast("error", "E-Mail fehlt", "Bitte E-Mail eingeben.");
      return;
    }
    setAuthPending(true);
    setMagicLink("");
    try {
      const { data } = await apiFetch<{ magic_link?: string }>(`${apiBase}/auth/request-link`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email })
      });
      if (data.magic_link) {
        setMagicLink(data.magic_link);
      }
      addToast("success", "Login-Link angefordert", data.magic_link ? "DEV-Link verfügbar." : "Prüfe dein E-Mail-Postfach.");
    } catch (e) {
      addToast("error", "Login-Link fehlgeschlagen", normalizeApiError(e));
    } finally {
      setAuthPending(false);
    }
  };

  const verifyMagicLink = async () => {
    if (!magicLink) return;
    setAuthPending(true);
    try {
      await apiFetch<{ user: AuthUser }>(`${apiBase}${magicLink}`);
      const me = await loadMe();
      if (me) {
        addToast("success", "Eingeloggt", me.email);
        await loadProperties();
      }
    } catch (e) {
      addToast("error", "Verifizierung fehlgeschlagen", normalizeApiError(e));
    } finally {
      setAuthPending(false);
    }
  };

  const logout = async () => {
    setAuthPending(true);
    try {
      await apiFetch<{ ok: boolean }>(`${apiBase}/auth/logout`, { method: "POST" });
    } finally {
      setCurrentUser(null);
      setProperties([]);
      setActivePropertyId(null);
      setDocuments([]);
      setTimelineItems([]);
      setAuthPending(false);
    }
  };

  const createProperty = async () => {
    const name = newPropertyName.trim();
    if (!name) {
      addToast("error", "Property-Name fehlt");
      return;
    }
    setPropertiesPending(true);
    try {
      const { data } = await apiFetch<PropertyItem>(`${apiBase}/properties`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name })
      });
      setProperties((prev) => [data, ...prev]);
      setActivePropertyId(data.id);
      setNewPropertyName("");
      addToast("success", "Property erstellt", data.name);
    } catch (e) {
      addToast("error", "Property konnte nicht erstellt werden", normalizeApiError(e));
    } finally {
      setPropertiesPending(false);
    }
  };

  const loadDocuments = async () => {
    if (!currentUser || !activePropertyId) {
      setDocuments([]);
      return [];
    }
    try {
      const { data: docs } = await apiFetch<DocumentItem[]>(
        `${apiBase}/documents?property_id=${encodeURIComponent(activePropertyId)}`
      );
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
    } catch (e: any) {
      if (e?.status === 401) {
        setCurrentUser(null);
        setProperties([]);
        setActivePropertyId(null);
      }
      return [];
    }
  };

  const runHealthCheck = async (withToast = false) => {
    setApiState("loading");
    try {
      const { data, latencyMs: latency } = await apiFetch<{ ok: boolean }>(`${apiBase}/health`, { timeoutMs: 10000 });
      setApiOutput(JSON.stringify(data, null, 2));
      setApiState("success");
      setShowColdStartBanner(false);
      if (!firstHealthChecked) setFirstHealthChecked(true);
      if (withToast) addToast("success", "Backend erreichbar", `${latency} ms`);
    } catch (e) {
      setApiOutput(JSON.stringify({ error: "Backend nicht erreichbar." }, null, 2));
      setApiState("error");
      if (!firstHealthChecked) {
        if (e instanceof ApiError && (e.isTimeout || !e.status || e.status >= 500)) {
          setShowColdStartBanner(true);
        }
        setFirstHealthChecked(true);
      }
      if (withToast) addToast("error", "Backend nicht erreichbar", "Prüfe URL und Serverstatus, dann erneut versuchen.");
    }
  };

  useEffect(() => {
    const boot = async () => {
      const me = await loadMe();
      if (!me) return;
      const props = await loadProperties();
      const targetPropertyId = activePropertyId && props.some((p) => p.id === activePropertyId) ? activePropertyId : props[0]?.id ?? null;
      if (targetPropertyId != null && targetPropertyId !== activePropertyId) {
        setActivePropertyId(targetPropertyId);
      }
    };
    void boot();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiBase]);

  useEffect(() => {
    void runHealthCheck(false);
    const timer = window.setInterval(() => {
      void runHealthCheck(false);
    }, 60000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiBase]);

  useEffect(() => {
    const syncPropertyData = async () => {
      if (!currentUser || !activePropertyId) {
        setDocuments([]);
        setTimelineItems([]);
        return;
      }
      const docs = await loadDocuments();
      if (docs.length > 0) {
        await loadTimelineFromStore(false);
      } else {
        setTimelineItems([]);
      }
    };
    void syncPropertyData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser?.id, activePropertyId, apiBase]);

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
    await rebuildTimeline();
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

  const pollBackgroundZipProcessing = async (initialDocCount: number) => {
    if (!activePropertyId) return;
    const maxAttempts = 12;
    const waitMs = 2500;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, waitMs));
      if (!activePropertyId) return;

      try {
        const latest = await loadDocuments();
        if (latest.length > initialDocCount) {
          setUploadState("success");
          setUploadMessage("Hintergrundverarbeitung abgeschlossen");
          setUploadDetails(`${latest.length - initialDocCount} neue(s) Dokument(e) verfügbar.`);
          addToast("success", "ZIP-Verarbeitung abgeschlossen", `${latest.length - initialDocCount} neue(s) Dokument(e).`);
          await rebuildTimeline(true);
          return;
        }
      } catch {
        // Continue polling; user can still refresh manually if needed.
      }
    }

    addToast("warning", "ZIP-Verarbeitung läuft noch", "Dokumente werden weiter im Hintergrund verarbeitet.");
  };

  const onUpload = async () => {
    if (!activePropertyId) {
      setUploadState("error");
      setUploadMessage("Keine Property gewählt");
      setUploadDetails("Bitte zuerst eine Property auswählen oder erstellen.");
      addToast("error", "Upload fehlgeschlagen", "Keine Property ausgewählt.");
      return;
    }
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
    let queuedJobs = 0;
    const initialDocCount = documents.length;
    const lines: string[] = [];

    for (let i = 0; i < selectedFiles.length; i += 1) {
      const file = selectedFiles[i];
      try {
        const data = await uploadWithProgress(apiBase, activePropertyId, file, (loaded, total) => {
          const current = total ? loaded / total : 0;
          const overall = ((i + current) / selectedFiles.length) * 100;
          setProgressPercent(Math.max(0, Math.min(100, overall)));
          setProgressText(`${Math.round(overall)}% (${i + 1}/${selectedFiles.length}) ${file.name}`);
        });
        if (data.queued) {
          queuedJobs += 1;
          lines.push(`IN ARBEIT ${file.name}: Hintergrundverarbeitung gestartet.`);
          addToast("warning", "ZIP wird verarbeitet", data.message || "Bitte in Kürze erneut prüfen.");
          continue;
        }
        if (Array.isArray(data.documents)) {
          const processedCount = Number(data.processed_count || 0);
          const failedCount = Number(data.failed_count || 0);
          uploadedDocuments += processedCount;
          failedItems += failedCount;
          lines.push(`ZIP ${data.archive_filename}: ${processedCount} PDF(s) verarbeitet, ${failedCount} fehlgeschlagen`);

          for (const doc of data.documents) {
            lines.push(`OK ${doc.filename} (document_id: ${doc.document_id}, indexed chunks: ${doc.chunks_indexed})`);
            addToast("success", `Dokument verarbeitet: ${doc.filename}`);
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
          if (data.filename) {
            addToast("success", `Dokument verarbeitet: ${data.filename}`);
          }
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

    if (failedItems === 0 && queuedJobs > 0 && uploadedDocuments === 0) {
      setUploadState("loading");
      setUploadMessage("ZIP wird im Hintergrund verarbeitet");
      setUploadDetails("Dokumente erscheinen automatisch, sobald die Verarbeitung fertig ist.");
      addToast("warning", "Verarbeitung gestartet", "Die Dokumentliste wird automatisch aktualisiert.");
    } else if (failedItems === 0) {
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
    if (uploadedDocuments > 0) {
      await rebuildTimeline(true);
    }
    if (queuedJobs > 0) {
      void pollBackgroundZipProcessing(initialDocCount);
    }
  };

  const askChat = async (question: string) => {
    if (!activePropertyId) {
      setChatState("error");
      setChatMessage("Keine Property gewählt");
      setChatDetails("Bitte zuerst eine Property auswählen.");
      addToast("error", "Chat fehlgeschlagen", "Keine Property ausgewählt.");
      return;
    }
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
      const { data } = await apiFetch<{ answer: string; sources: Source[] }>(`${apiBase}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q, property_id: activePropertyId }),
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
      const { data } = await apiFetch<{ snippet: string }>(
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

  const onChatQuestionKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter") return;
    if (e.shiftKey) return;
    e.preventDefault();
    if (chatPending) return;
    void askChat(chatQuestion);
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
      const { data } = await apiFetch<{ items: TimelineItem[] }>(`${apiBase}/timeline/extract`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ raw_text: timelineInput }),
        timeoutMs: 45000
      });
      const items = Array.isArray(data.items) ? data.items : [];
      setTimelineItems(items);
      setTimelineRenderSeed((prev) => prev + 1);
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
    if (!activePropertyId) {
      setTimelineState("error");
      setTimelineMessage("Keine Property gewählt");
      setTimelineDetails("Bitte zuerst eine Property auswählen.");
      return;
    }
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
      const { data } = await apiFetch<TimelineItem[]>(
        `${apiBase}/timeline?property_id=${encodeURIComponent(activePropertyId)}`,
        {
        timeoutMs: 15000
        }
      );
      const items = Array.isArray(data) ? data : [];
      setTimelineItems(items);
      setTimelineRenderSeed((prev) => prev + 1);
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

  const rebuildTimeline = async (fromUpload = false) => {
    if (!activePropertyId) {
      setTimelineState("error");
      setTimelineMessage("Keine Property gewählt");
      setTimelineDetails("Bitte zuerst eine Property auswählen.");
      return;
    }
    if (documents.length === 0) {
      setTimelineState("error");
      setTimelineMessage("Keine Dokumente");
      setTimelineDetails("Bitte zuerst mindestens ein PDF hochladen.");
      return;
    }

    setLastTimelineAction("load");
    setTimelineState("loading");
    setTimelineMessage("Timeline wird aktualisiert...");
    try {
      const { data } = await apiFetch<{ items_count: number; updated_at: string }>(
        `${apiBase}/timeline/rebuild?property_id=${encodeURIComponent(activePropertyId)}`,
        {
          method: "POST",
          timeoutMs: 60000
        }
      );
      const { data: list } = await apiFetch<TimelineItem[]>(
        `${apiBase}/timeline?property_id=${encodeURIComponent(activePropertyId)}`,
        { timeoutMs: 15000 }
      );
      const items = Array.isArray(list) ? list : [];
      setTimelineItems(items);
      setTimelineRenderSeed((prev) => prev + 1);
      setTimelineState("success");
      setTimelineMessage("Timeline aktualisiert");
      setTimelineDetails(`${data.items_count} neu berechnet, ${items.length} sichtbar.`);
      if (fromUpload) {
        addToast("success", "Timeline automatisch aktualisiert", `${data.items_count} Items neu berechnet`);
      } else {
        addToast("success", "Timeline aktualisiert", `${data.items_count} Items neu berechnet`);
      }
      return true;
    } catch (e) {
      const message = normalizeApiError(e, "Unbekannter Fehler");
      if (fromUpload) {
        addToast("warning", "Timeline konnte nicht automatisch aktualisiert werden", message);
      } else {
        setTimelineState("error");
        setTimelineMessage("Timeline-Aktualisierung fehlgeschlagen");
        setTimelineDetails(message);
        addToast("error", "Timeline fehlgeschlagen", message);
      }
      return false;
    }
  };

  const onDeleteDocument = async (doc: DocumentItem) => {
    if (!activePropertyId) {
      addToast("error", "Löschen fehlgeschlagen", "Keine Property ausgewählt.");
      return;
    }
    const confirmed = window.confirm(`Dokument wirklich löschen?\n\n${doc.filename}`);
    if (!confirmed) return;

    setDocumentActionsPending(true);
    try {
      await apiFetch<{ ok: boolean }>(
        `${apiBase}/documents/${encodeURIComponent(doc.document_id)}?property_id=${encodeURIComponent(activePropertyId)}`,
        { method: "DELETE", timeoutMs: 30000 }
      );
      setDocumentStatuses((prev) => {
        const next = { ...prev };
        delete next[doc.document_id];
        return next;
      });
      const remainingDocs = await loadDocuments();
      if (remainingDocs.length > 0) {
        await loadTimelineFromStore(false);
      } else {
        setTimelineItems([]);
        setTimelineState("idle");
        setTimelineMessage("Bereit");
        setTimelineDetails("Rohtext einfügen und Termine extrahieren.");
      }
      addToast("success", "Dokument gelöscht", doc.filename);
    } catch (e) {
      addToast("error", "Löschen fehlgeschlagen", normalizeApiError(e));
    } finally {
      setDocumentActionsPending(false);
    }
  };

  const onDeleteAllDocuments = async () => {
    if (!activePropertyId) {
      addToast("error", "Löschen fehlgeschlagen", "Keine Property ausgewählt.");
      return;
    }
    if (documents.length === 0) {
      addToast("warning", "Keine Dokumente", "Es gibt nichts zu löschen.");
      return;
    }

    const confirmed = window.confirm(
      `Wirklich alle Dokumente in dieser Property löschen?\n\nAnzahl: ${documents.length}`
    );
    if (!confirmed) return;

    setDocumentActionsPending(true);
    try {
      const toDelete = [...documents];
      await Promise.all(
        toDelete.map((doc) =>
          apiFetch<{ ok: boolean }>(
            `${apiBase}/documents/${encodeURIComponent(doc.document_id)}?property_id=${encodeURIComponent(activePropertyId)}`,
            { method: "DELETE", timeoutMs: 30000 }
          )
        )
      );
      setDocumentStatuses((prev) => {
        const next = { ...prev };
        for (const doc of toDelete) {
          delete next[doc.document_id];
        }
        return next;
      });
      await loadDocuments();
      setTimelineItems([]);
      setTimelineState("idle");
      setTimelineMessage("Bereit");
      setTimelineDetails("Rohtext einfügen und Termine extrahieren.");
      addToast("success", "Alle Dokumente gelöscht", `${toDelete.length} Dokument(e) entfernt.`);
    } catch (e) {
      addToast("error", "Massen-Löschen fehlgeschlagen", normalizeApiError(e));
    } finally {
      setDocumentActionsPending(false);
    }
  };

  const onReprocessDocument = async (doc: DocumentItem) => {
    if (!activePropertyId) {
      addToast("error", "Neuverarbeitung fehlgeschlagen", "Keine Property ausgewählt.");
      return;
    }
    setDocumentActionsPending(true);
    setDocumentStatuses((prev) => ({ ...prev, [doc.document_id]: "processing" }));
    try {
      await apiFetch<{
        items: TimelineItem[];
        documents_considered: number;
        documents_processed: number;
        documents_failed: Array<{ document_id: number; filename: string; reason: string }>;
      }>(`${apiBase}/timeline/extract-documents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ property_id: activePropertyId, document_ids: [doc.document_id] }),
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
      const pa = timelinePriority(a.category || "info");
      const pb = timelinePriority(b.category || "info");
      if (pa !== pb) return pa - pb;
      const da = new Date(a.date_iso).getTime();
      const db = new Date(b.date_iso).getTime();
      if (da !== db) return da - db;
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

  const hasDocuments = documents.length > 0;

  const apiIndicator = apiState === "loading" ? "Prüfe Verbindung..." : apiState === "error" ? "Nicht erreichbar" : "Bereit";
  const selectedProperty = properties.find((p) => p.id === activePropertyId) || null;
  const canWork = Boolean(currentUser && activePropertyId);
  const activeWorkflowStep = useMemo(() => {
    if (!canWork) return 1;
    if (uploadPending) return 2;
    if (documents.length > 0) return 3;
    return 1;
  }, [canWork, uploadPending, documents.length]);

  return (
    <>
      <div className="bg-orb orb-a" />
      <div className="bg-orb orb-b" />

      <main className="shell">
        {showColdStartBanner ? (
          <section className="coldstart-banner" role="status" aria-live="polite">
            <div className="coldstart-banner-text">
              Der Server startet ggf. gerade (Free Hosting). Bitte versuche es in 10–20 Sekunden erneut.
            </div>
            <button className="chip" onClick={() => void runHealth()} disabled={apiState === "loading"}>
              Erneut versuchen
            </button>
          </section>
        ) : null}
        {!currentUser ? (
          <section className="layout-top reveal">
            <header className="hero hero-compact">
              <div className="hero-topline">
                <p className="eyebrow">NDIAH</p>
                <span className={`api-indicator ${apiState === "error" ? "is-offline" : apiState === "loading" ? "is-loading" : "is-ready"}`}>
                  {apiIndicator}
                </span>
              </div>
              <h1>Dokumente verstehen. Fragen stellen. Fristen sehen.</h1>
              <p className="sub">Melde dich an, um deine Properties, Uploads, Timeline und Chat zu nutzen.</p>
              <div className="col">
                <div className="row wrap">
                  <input
                    placeholder="E-Mail für Magic Link"
                    value={authEmail}
                    onChange={(e) => setAuthEmail(e.target.value)}
                    disabled={authPending}
                  />
                  <button className="btn" onClick={() => void requestMagicLink()} disabled={authPending}>
                    Link anfordern
                  </button>
                </div>
                <div className="timeline-hint">
                  Nach dem Login kannst du eine Immobilie anlegen und Dokumente hochladen.
                </div>
                {magicLink ? (
                  <div className="row wrap">
                    <code>{magicLink}</code>
                    <button className="chip" onClick={() => void verifyMagicLink()} disabled={authPending}>
                      DEV Link verifizieren
                    </button>
                  </div>
                ) : null}
              </div>
            </header>
          </section>
        ) : properties.length === 0 ? (
          <section className="layout-top reveal">
            <header className="hero hero-compact">
              <div className="hero-topline">
                <p className="eyebrow">NDIAH</p>
                <span className={`api-indicator ${apiState === "error" ? "is-offline" : apiState === "loading" ? "is-loading" : "is-ready"}`}>
                  {apiIndicator}
                </span>
              </div>
              <div className="row wrap">
                <span>Eingeloggt als: <strong>{currentUser.email}</strong></span>
                <button className="chip" onClick={() => void logout()} disabled={authPending}>
                  Logout
                </button>
              </div>
              <h1>Lege deine erste Immobilie an</h1>
              <p className="sub">
                Dokumente, Timeline und Chat sind immer an eine Immobilie gebunden. Starte mit einem Namen für deine erste Immobilie.
              </p>
              <div className="row wrap">
                <input
                  placeholder="Name der Immobilie"
                  value={newPropertyName}
                  onChange={(e) => setNewPropertyName(e.target.value)}
                  disabled={propertiesPending}
                />
                <button className="btn" onClick={() => void createProperty()} disabled={propertiesPending}>
                  Immobilie anlegen
                </button>
              </div>
            </header>
          </section>
        ) : (
          <>
            <section className="layout-top reveal">
              <header className="hero hero-compact">
                <div className="hero-topline">
                  <p className="eyebrow">NDIAH</p>
                  <span className={`api-indicator ${apiState === "error" ? "is-offline" : apiState === "loading" ? "is-loading" : "is-ready"}`}>
                    {apiIndicator}
                  </span>
                </div>
                <h1>Dokumente verstehen. Fragen stellen. Fristen sehen.</h1>
                <p className="sub">Upload links, Timeline rechts, Chat unten.</p>
                <div className="col">
                  <div className="row wrap">
                    <span>Eingeloggt als: <strong>{currentUser.email}</strong></span>
                    <button className="chip" onClick={() => void logout()} disabled={authPending}>
                      Logout
                    </button>
                  </div>
                  <div className="row wrap">
                    <select
                      value={activePropertyId ?? ""}
                      onChange={(e) => setActivePropertyId(e.target.value ? Number(e.target.value) : null)}
                      disabled={propertiesPending}
                    >
                      <option value="">Property wählen...</option>
                      {properties.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                    <input
                      placeholder="Neue Property"
                      value={newPropertyName}
                      onChange={(e) => setNewPropertyName(e.target.value)}
                      disabled={propertiesPending}
                    />
                    <button className="chip" onClick={() => void createProperty()} disabled={propertiesPending}>
                      Property erstellen
                    </button>
                  </div>
                  <div>Aktive Property: {selectedProperty ? `${selectedProperty.name} (#${selectedProperty.id})` : "keine"}</div>
                </div>
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
                  disabled={!canWork}
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
                  onDeleteAllDocuments={() => void onDeleteAllDocuments()}
                  onDeleteDocument={(doc) => void onDeleteDocument(doc)}
                  onReprocessDocument={(doc) => void onReprocessDocument(doc)}
                  actionsPending={documentActionsPending}
                />
              </div>

              <div className="layout-right">
                <TimelineCard
                  disabled={!canWork}
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
                animationSeed={timelineRenderSeed}
                pending={timelineState === "loading"}
                  onInputChange={setTimelineInput}
                  onExtract={() => void extractTimeline()}
                  onExtractDocuments={() => void rebuildTimeline()}
                  onRetry={() => void retryTimeline()}
                  onSearchChange={setTimelineSearch}
                  onCategoryChange={setTimelineCategory}
                  normalizeCategory={normalizeCategory}
                />
              </div>
            </section>

            <section className="layout-bottom">
              <ChatCard
                disabled={!canWork}
                state={chatState}
                message={chatMessage}
                details={chatDetails}
                chatHistory={chatHistory}
                chatQuestion={chatQuestion}
                chatPending={chatPending}
                hasDocuments={hasDocuments}
                exampleQuestions={EXAMPLE_QUESTIONS}
                documentsById={documentsById}
                onQuestionChange={setChatQuestion}
                onQuestionKeyDown={onChatQuestionKeyDown}
                onAsk={() => void askChat(chatQuestion)}
                onRetry={() => void retryChat()}
                onUseExample={setChatQuestion}
                onLoadSnippet={(messageId, source) => void loadSourceSnippet(messageId, source)}
                historyRef={chatHistoryRef}
              />
            </section>
          </>
        )}
      </main>

      <ToastContainer toasts={toasts} />
    </>
  );
}

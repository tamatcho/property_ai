import { useEffect, useState } from "react";
import StatusBanner from "../StatusBanner";
import { TimelineItem, UiState } from "../../types";

type Props = {
  disabled?: boolean;
  language?: string;
  state: UiState;
  message: string;
  details?: string;
  hasDocuments: boolean;
  timelineItems: TimelineItem[];
  timelineInput: string;
  timelineSearch: string;
  timelineCategory: string;
  timelineCategories: string[];
  timelineCurrentGrouped: [string, TimelineItem[]][];
  timelineArchiveGrouped: [string, TimelineItem[]][];
  animationSeed: number;
  pending: boolean;
  onInputChange: (value: string) => void;
  onExtract: () => void;
  onExtractDocuments: () => void;
  onLoadFromStore: () => void;
  onRetry: () => void;
  onSearchChange: (value: string) => void;
  onCategoryChange: (value: string) => void;
  normalizeCategory: (category: string) => string;
};

const TL: Record<string, Record<string, string>> = {
  de: {
    title: "Timeline Extraktion", noResult: "Kein Timeline-Ergebnis", noResultSub: "Aktualisiere die Timeline aus deinen hochgeladenen Dokumenten.",
    load: "Timeline laden", reExtract: "Neu extrahieren", exportCsv: "CSV exportieren", retry: "Erneut versuchen",
    noDocs: "Keine hochgeladenen Dokumente. Bitte zuerst ein PDF hochladen.",
    searchPlaceholder: "Suche in Titel/Beschreibung...", allCategories: "Alle Kategorien",
    advanced: "Erweitert", rawTextPlaceholder: "Dokumenttext einfügen...", extractRaw: "Aus Rohtext extrahieren",
    upcoming: "Aktuell & Bald", noUpcoming: "Keine aktuellen oder bald relevanten Einträge.",
    archive: "Archiv (Vergangene Ereignisse)", show: "Anzeigen", hide: "Ausblenden",
    noFilter: "Keine Einträge für den aktuellen Filter.", noTimeline: "Noch keine Timeline",
    noTimelineSub: "Text eingeben und Extraktion starten.",
    noTitle: "Ohne Titel", dateLabel: "Datum:", timeLabel: "Zeit:", sourceLabel: "Quelle:",
    evidence: "Beleg", evidenceLabel: "Beleg:", rawSource: "Rohtext-Extraktion",
    catDeadline: "Frist", catPayment: "Zahlung", catMeeting: "Termin", catInfo: "Info", catTax: "Steuer",
    csvHeaders: "Datum;Uhrzeit;Titel;Kategorie;Betrag (EUR);Beschreibung;Quelle;Beleg",
  },
  en: {
    title: "Timeline", noResult: "No timeline results", noResultSub: "Load the timeline from your uploaded documents.",
    load: "Load timeline", reExtract: "Re-extract", exportCsv: "Export CSV", retry: "Retry",
    noDocs: "No documents uploaded. Please upload a PDF first.",
    searchPlaceholder: "Search title/description...", allCategories: "All categories",
    advanced: "Advanced", rawTextPlaceholder: "Paste document text...", extractRaw: "Extract from raw text",
    upcoming: "Upcoming", noUpcoming: "No current or upcoming entries.",
    archive: "Archive (Past Events)", show: "Show", hide: "Hide",
    noFilter: "No entries match the current filter.", noTimeline: "No timeline yet",
    noTimelineSub: "Enter text and start extraction.",
    noTitle: "No title", dateLabel: "Date:", timeLabel: "Time:", sourceLabel: "Source:",
    evidence: "Evidence", evidenceLabel: "Evidence:", rawSource: "Raw text extraction",
    catDeadline: "Deadline", catPayment: "Payment", catMeeting: "Meeting", catInfo: "Info", catTax: "Tax",
    csvHeaders: "Date;Time;Title;Category;Amount (EUR);Description;Source;Evidence",
  },
  fr: {
    title: "Chronologie", noResult: "Aucun résultat", noResultSub: "Chargez la chronologie depuis vos documents.",
    load: "Charger", reExtract: "Ré-extraire", exportCsv: "Exporter CSV", retry: "Réessayer",
    noDocs: "Aucun document. Veuillez d'abord télécharger un PDF.",
    searchPlaceholder: "Rechercher titre/description...", allCategories: "Toutes les catégories",
    advanced: "Avancé", rawTextPlaceholder: "Coller le texte du document...", extractRaw: "Extraire du texte brut",
    upcoming: "À venir", noUpcoming: "Aucune entrée actuelle ou à venir.",
    archive: "Archives (Événements passés)", show: "Afficher", hide: "Masquer",
    noFilter: "Aucune entrée ne correspond au filtre.", noTimeline: "Pas encore de chronologie",
    noTimelineSub: "Entrez du texte et lancez l'extraction.",
    noTitle: "Sans titre", dateLabel: "Date :", timeLabel: "Heure :", sourceLabel: "Source :",
    evidence: "Justificatif", evidenceLabel: "Justificatif :", rawSource: "Extraction brute",
    catDeadline: "Échéance", catPayment: "Paiement", catMeeting: "Réunion", catInfo: "Info", catTax: "Taxe",
    csvHeaders: "Date;Heure;Titre;Catégorie;Montant (EUR);Description;Source;Justificatif",
  },
};

export default function TimelineCard(props: Props) {
  const t = TL[props.language ?? "de"] ?? TL.de;
  const locale = props.language === "en" ? "en-GB" : props.language === "fr" ? "fr-FR" : "de-DE";

  const [archiveMounted, setArchiveMounted] = useState(false);
  const [archiveClosing, setArchiveClosing] = useState(false);
  const [lastAnimatedSeed, setLastAnimatedSeed] = useState<number | null>(null);
  const [openQuoteId, setOpenQuoteId] = useState<string | null>(null);
  const formatGroupDate = (dateIso: string) => {
    const date = new Date(dateIso);
    if (Number.isNaN(date.getTime())) return dateIso;
    return date.toLocaleDateString(locale);
  };

  const shorten = (value: string, maxLen = 180) => {
    const clean = (value || "").trim();
    if (!clean) return "-";
    if (clean.length <= maxLen) return clean;
    return `${clean.slice(0, maxLen - 1)}…`;
  };

  const categoryRank = (category: string) => {
    const normalized = props.normalizeCategory(category || "info");
    if (normalized === "deadline") return 0;
    if (normalized === "payment") return 1;
    if (normalized === "meeting") return 2;
    if (normalized === "info") return 3;
    return 4; // tax
  };

  const categoryLabel: Record<string, string> = {
    deadline: t.catDeadline,
    payment: t.catPayment,
    meeting: t.catMeeting,
    info: t.catInfo,
    tax: t.catTax,
  };

  const shouldAnimateBatch =
    lastAnimatedSeed !== props.animationSeed &&
    !((window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) ?? false);
  useEffect(() => {
    if (lastAnimatedSeed !== props.animationSeed) {
      setLastAnimatedSeed(props.animationSeed);
    }
  }, [lastAnimatedSeed, props.animationSeed]);

  const renderGroupedCards = (grouped: [string, TimelineItem[]][], withAnimation = false, archived = false) => {
    let animatedCardsCount = 0;
    return grouped.map(([dateIso, items]) => {
      const sortedItems = [...items].sort((a, b) => {
        const pa = categoryRank(a.category || "info");
        const pb = categoryRank(b.category || "info");
        if (pa !== pb) return pa - pb;
        return (a.time_24h || "99:99").localeCompare(b.time_24h || "99:99");
      });

      const hasAnimatedCardInGroup = withAnimation && shouldAnimateBatch && animatedCardsCount < 5;

      return (
        <section className={`timeline-group ${hasAnimatedCardInGroup ? "timeline-group-animated" : ""}`} key={dateIso}>
          <div className="timeline-group-date">{formatGroupDate(dateIso)}</div>
          <div className="timeline-cards">
            {sortedItems.map((item, idx) => {
              const shouldAnimateCard = withAnimation && shouldAnimateBatch && animatedCardsCount < 5;
              if (shouldAnimateCard) animatedCardsCount += 1;
              const cardId = `${item.document_id ?? "doc"}-${dateIso}-${idx}`;
              const quote = (item.source_quote || "").trim();
              const hasQuote = quote.length > 0;
              const isQuoteOpen = openQuoteId === cardId;
              return (
                <article
                  className={`timeline-card ${archived ? "timeline-card-archived" : ""} timeline-card-priority-${props.normalizeCategory(
                    item.category || "info"
                  )} ${
                    shouldAnimateCard ? "timeline-card-animated" : ""
                  }`}
                  key={cardId}
                >
                  <div className="timeline-card-head">
                    <div className="timeline-title">{item.title || t.noTitle}</div>
                    <span className={`badge badge-${props.normalizeCategory(item.category || "info")}`}>
                      {categoryLabel[props.normalizeCategory(item.category || "info")] ?? props.normalizeCategory(item.category || "info")}
                    </span>
                  </div>
                  <div className="timeline-meta">
                    <span>{t.dateLabel} {item.date_iso || "-"}</span>
                    {item.time_24h ? <span>{t.timeLabel} {item.time_24h}</span> : null}
                  </div>
                  <div className="timeline-desc">{shorten(item.description || "")}</div>
                  {typeof item.amount_eur === "number" ? (
                    <div className="timeline-amount">
                      {new Intl.NumberFormat(locale, { style: "currency", currency: "EUR" }).format(item.amount_eur)}
                    </div>
                  ) : null}
                  <div className="timeline-footer">
                    <div className="timeline-source">{t.sourceLabel} {item.source || item.filename || t.rawSource}</div>
                    {hasQuote ? (
                      <button
                        type="button"
                        className="timeline-quote-toggle"
                        aria-expanded={isQuoteOpen}
                        aria-controls={`quote-${cardId}`}
                        onClick={() => toggleQuote(cardId)}
                      >
                        {t.evidence} ⓘ
                      </button>
                    ) : null}
                  </div>
                  {hasQuote && isQuoteOpen ? (
                    <div className="timeline-quote-popover" id={`quote-${cardId}`} role="note">
                      <div className="timeline-quote-label">{t.evidenceLabel}</div>
                      <div className="timeline-quote-text">{quote}</div>
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>
        </section>
      );
    });
  };

  const hasAnyGroups = props.timelineCurrentGrouped.length > 0 || props.timelineArchiveGrouped.length > 0;

  const hasFilteredResults = () => {
    if (!props.timelineItems.length) return false;
    return hasAnyGroups;
  };

  const visibleItems = props.timelineCurrentGrouped.flatMap(([, items]) => items);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const openDeadlines = visibleItems.filter((item) => {
    const dt = new Date(item.date_iso);
    return !Number.isNaN(dt.getTime()) && dt >= today && props.normalizeCategory(item.category || "info") === "deadline";
  }).length;

  const openPayments = visibleItems.filter((item) => {
    const dt = new Date(item.date_iso);
    return !Number.isNaN(dt.getTime()) && dt >= today && props.normalizeCategory(item.category || "info") === "payment";
  }).length;

  const nextEventDays = (() => {
    const upcoming = visibleItems
      .map((item) => new Date(item.date_iso))
      .filter((dt) => !Number.isNaN(dt.getTime()) && dt >= today)
      .sort((a, b) => a.getTime() - b.getTime());
    if (!upcoming.length) return null;
    return Math.round((upcoming[0].getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
  })();

  const deadlinesSummary =
    openDeadlines > 0
      ? `${openDeadlines} Frist${openDeadlines === 1 ? "" : "en"} ${openDeadlines === 1 ? "steht" : "stehen"} an`
      : "Keine offenen Fristen";
  const paymentsSummary =
    openPayments > 0
      ? `${openPayments} offene Zahlung${openPayments === 1 ? "" : "en"}`
      : "Keine offenen Zahlungen";
  const nextEventSummary =
    nextEventDays === null
      ? "Kein kommender Termin"
      : nextEventDays === 0
        ? "Nächster Termin heute"
        : `Nächster Termin in ${nextEventDays} Tag${nextEventDays === 1 ? "" : "en"}`;

  const nextDeadline = visibleItems
    .filter((item) => props.normalizeCategory(item.category || "info") === "deadline")
    .map((item) => new Date(item.date_iso))
    .filter((dt) => !Number.isNaN(dt.getTime()))
    .sort((a, b) => a.getTime() - b.getTime())[0];

  const duePayments30d = visibleItems.filter((item) => {
    const category = props.normalizeCategory(item.category || "info");
    if (category !== "payment") return false;
    const dt = new Date(item.date_iso);
    if (Number.isNaN(dt.getTime())) return false;
    const in30 = new Date(today);
    in30.setDate(in30.getDate() + 30);
    return dt >= today && dt <= in30;
  }).length;

  const actionSummary = (() => {
    if (openDeadlines > 0 && nextDeadline) {
      return `${openDeadlines} Frist${openDeadlines === 1 ? "" : "en"} stehen an (nächste: ${nextDeadline.toLocaleDateString("de-DE")}).`;
    }
    if (duePayments30d > 0) {
      return `${duePayments30d} Zahlung${duePayments30d === 1 ? "" : "en"} fällig innerhalb von 30 Tagen.`;
    }
    if (openDeadlines === 0) {
      return `Keine offenen Fristen. ${nextEventSummary}.`;
    }
    return `${deadlinesSummary}. ${paymentsSummary}.`;
  })();

  const isReducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;
  const archiveOpen = archiveMounted && !archiveClosing;

  const openArchive = () => {
    if (archiveMounted && !archiveClosing) return;
    setArchiveMounted(true);
    setArchiveClosing(false);
  };

  const closeArchive = () => {
    if (!archiveMounted) return;
    if (isReducedMotion()) {
      setArchiveMounted(false);
      setArchiveClosing(false);
      return;
    }
    setArchiveClosing(true);
  };

  const onArchiveAnimationEnd = () => {
    if (!archiveClosing) return;
    setArchiveMounted(false);
    setArchiveClosing(false);
  };

  const toggleQuote = (id: string) => {
    setOpenQuoteId((current) => (current === id ? null : id));
  };

  const exportTimelineCsv = () => {
    if (props.timelineItems.length === 0) return;
    const headers = t.csvHeaders.split(";");
    const rows = props.timelineItems.map((item) => [
      item.date_iso || "",
      item.time_24h || "",
      item.title || "",
      props.normalizeCategory(item.category || "info"),
      item.amount_eur != null ? item.amount_eur.toFixed(2) : "",
      item.description || "",
      item.source || item.filename || "",
      (item.source_quote || "").replace(/\n/g, " "),
    ]);
    const csvContent = [headers, ...rows].map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(";")).join("\n");
    const blob = new Blob(["\uFEFF" + csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `ndiah_timeline_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section id="timelineCard" className="card reveal" data-state={props.state}>
      <div className="card-title-row">
        <h2>{t.title}</h2>
        {props.state === "loading" ? <span className="card-title-spinner" aria-hidden="true" /> : null}
      </div>
      {props.timelineItems.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-title">{t.noResult}</div>
          <div>{t.noResultSub}</div>
        </div>
      ) : null}

      <div className="timeline-panel-scroll">
        <div className="timeline-sticky-header">
          <StatusBanner state={props.state} message={props.message} details={props.details} />
          <div className="row wrap">
            <button className="btn btn-secondary" onClick={props.onLoadFromStore} disabled={props.disabled || !props.hasDocuments || props.pending}>
              {t.load}
            </button>
            <button className="chip" onClick={props.onExtractDocuments} disabled={props.disabled || !props.hasDocuments || props.pending} title="Führt KI-Extraktion für alle Dokumente erneut aus (kostet Tokens)">
              {t.reExtract}
            </button>
            {props.timelineItems.length > 0 ? (
              <button className="chip" onClick={exportTimelineCsv} disabled={props.pending}>
                {t.exportCsv}
              </button>
            ) : null}
          </div>
          {!props.hasDocuments ? (
            <div className="timeline-hint">
              {t.noDocs}
            </div>
          ) : null}

          {props.state === "error" ? (
            <div className="empty-actions">
              <button className="chip" disabled={props.pending || props.disabled} onClick={props.onRetry}>
                {t.retry}
              </button>
            </div>
          ) : null}

          <div className="timeline-tools">
            <input
              type="text"
              placeholder={t.searchPlaceholder}
              value={props.timelineSearch}
              disabled={props.pending || props.disabled}
              onChange={(e) => props.onSearchChange(e.target.value)}
            />
            <select value={props.timelineCategory} disabled={props.pending || props.disabled} onChange={(e) => props.onCategoryChange(e.target.value)}>
              <option value="">{t.allCategories}</option>
              {props.timelineCategories.map((cat) => (
                <option key={cat} value={cat}>
                  {cat}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="col">
        <details className="timeline-advanced">
          <summary>{t.advanced}</summary>
          <div className="col">
            <textarea
              rows={8}
              placeholder={t.rawTextPlaceholder}
              value={props.timelineInput}
              disabled={props.pending || props.disabled}
              onChange={(e) => props.onInputChange(e.target.value)}
            />
            <div className="row wrap">
              <button className="btn" disabled={props.pending || props.disabled} onClick={props.onExtract}>
                {t.extractRaw}
              </button>
            </div>
          </div>
        </details>
        </div>
        <div className="timeline-summary" aria-label="Timeline-Zusammenfassung">
        <div className="timeline-summary-item timeline-summary-main">{actionSummary}</div>
        </div>
        <div className="timeline-list">
        {props.timelineItems.length === 0 ? (
          <div className="timeline-empty">
            <span className="empty-state-title">{t.noTimeline}</span>
            <br />
            {t.noTimelineSub}
          </div>
        ) : !hasFilteredResults() ? (
          <div className="timeline-empty">{t.noFilter}</div>
        ) : (
          <>
            {props.timelineCurrentGrouped.length > 0 ? (
              <section className="timeline-section">
                <div className="timeline-section-title">{t.upcoming}</div>
                {renderGroupedCards(props.timelineCurrentGrouped, true, false)}
              </section>
            ) : (
              <div className="timeline-empty">{t.noUpcoming}</div>
            )}

            {props.timelineArchiveGrouped.length > 0 ? (
              <section className="timeline-archive-shell">
                <button type="button" className="timeline-archive-toggle" aria-expanded={archiveOpen} onClick={archiveOpen ? closeArchive : openArchive}>
                  <span>{t.archive}</span>
                  <span className="timeline-archive-toggle-state">{archiveOpen ? t.hide : t.show}</span>
                </button>
                {archiveMounted ? (
                  <div
                    className={`timeline-archive-panel ${archiveClosing ? "is-closing" : "is-opening"}`}
                    onAnimationEnd={onArchiveAnimationEnd}
                  >
                    <div className="timeline-section">{renderGroupedCards(props.timelineArchiveGrouped, false, true)}</div>
                  </div>
                ) : null}
              </section>
            ) : null}
          </>
        )}
        </div>
      </div>
    </section>
  );
}

import { useEffect, useState } from "react";
import StatusBanner from "../StatusBanner";
import { TimelineItem, UiState } from "../../types";

type Props = {
  disabled?: boolean;
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
  onRetry: () => void;
  onSearchChange: (value: string) => void;
  onCategoryChange: (value: string) => void;
  normalizeCategory: (category: string) => string;
};

export default function TimelineCard(props: Props) {
  const [archiveMounted, setArchiveMounted] = useState(false);
  const [archiveClosing, setArchiveClosing] = useState(false);
  const [lastAnimatedSeed, setLastAnimatedSeed] = useState<number | null>(null);
  const [openQuoteId, setOpenQuoteId] = useState<string | null>(null);
  const formatGroupDate = (dateIso: string) => {
    const date = new Date(dateIso);
    if (Number.isNaN(date.getTime())) return dateIso;
    return date.toLocaleDateString("de-DE");
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
                    <div className="timeline-title">{item.title || "Ohne Titel"}</div>
                    <span className={`badge badge-${props.normalizeCategory(item.category || "info")}`}>
                      {props.normalizeCategory(item.category || "info")}
                    </span>
                  </div>
                  <div className="timeline-meta">
                    <span>Datum: {item.date_iso || "-"}</span>
                    {item.time_24h ? <span>Zeit: {item.time_24h}</span> : null}
                  </div>
                  <div className="timeline-desc">{shorten(item.description || "")}</div>
                  {typeof item.amount_eur === "number" ? (
                    <div className="timeline-amount">
                      {new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" }).format(item.amount_eur)}
                    </div>
                  ) : null}
                  <div className="timeline-footer">
                    <div className="timeline-source">Quelle: {item.source || item.filename || "Rohtext-Extraktion"}</div>
                    {hasQuote ? (
                      <button
                        type="button"
                        className="timeline-quote-toggle"
                        aria-expanded={isQuoteOpen}
                        aria-controls={`quote-${cardId}`}
                        onClick={() => toggleQuote(cardId)}
                      >
                        Beleg ⓘ
                      </button>
                    ) : null}
                  </div>
                  {hasQuote && isQuoteOpen ? (
                    <div className="timeline-quote-popover" id={`quote-${cardId}`} role="note">
                      <div className="timeline-quote-label">Beleg:</div>
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

  return (
    <section id="timelineCard" className="card reveal" data-state={props.state}>
      <div className="card-title-row">
        <h2>Timeline Extraktion</h2>
        {props.state === "loading" ? <span className="card-title-spinner" aria-hidden="true" /> : null}
      </div>
      {props.timelineItems.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-title">Kein Timeline-Ergebnis</div>
          <div>Aktualisiere die Timeline aus deinen hochgeladenen Dokumenten.</div>
        </div>
      ) : null}

      <div className="timeline-panel-scroll">
        <div className="timeline-sticky-header">
          <StatusBanner state={props.state} message={props.message} details={props.details} />
          <div className="row wrap">
            <button className="btn btn-secondary" onClick={props.onExtractDocuments} disabled={props.disabled || !props.hasDocuments || props.pending}>
              Timeline aktualisieren
            </button>
          </div>
          {!props.hasDocuments ? (
            <div className="timeline-hint">
              Keine hochgeladenen Dokumente gefunden. Bitte zuerst im Upload-Bereich mindestens ein PDF hochladen.
            </div>
          ) : null}

          {props.state === "error" ? (
            <div className="empty-actions">
              <button className="chip" disabled={props.pending || props.disabled} onClick={props.onRetry}>
                Erneut versuchen
              </button>
            </div>
          ) : null}

          <div className="timeline-tools">
            <input
              type="text"
              placeholder="Suche in Titel/Beschreibung..."
              value={props.timelineSearch}
              disabled={props.pending || props.disabled}
              onChange={(e) => props.onSearchChange(e.target.value)}
            />
            <select value={props.timelineCategory} disabled={props.pending || props.disabled} onChange={(e) => props.onCategoryChange(e.target.value)}>
              <option value="">Alle Kategorien</option>
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
          <summary>Erweitert</summary>
          <div className="col">
            <textarea
              rows={8}
              placeholder="Dokumenttext einfügen..."
              value={props.timelineInput}
              disabled={props.pending || props.disabled}
              onChange={(e) => props.onInputChange(e.target.value)}
            />
            <div className="row wrap">
              <button className="btn" disabled={props.pending || props.disabled} onClick={props.onExtract}>
                Aus Rohtext extrahieren
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
            <span className="empty-state-title">Noch keine Timeline</span>
            <br />
            Text eingeben und Extraktion starten.
          </div>
        ) : !hasFilteredResults() ? (
          <div className="timeline-empty">Keine Einträge für den aktuellen Filter.</div>
        ) : (
          <>
            {props.timelineCurrentGrouped.length > 0 ? (
              <section className="timeline-section">
                <div className="timeline-section-title">Aktuell & Bald</div>
                {renderGroupedCards(props.timelineCurrentGrouped, true, false)}
              </section>
            ) : (
              <div className="timeline-empty">Keine aktuellen oder bald relevanten Einträge.</div>
            )}

            {props.timelineArchiveGrouped.length > 0 ? (
              <section className="timeline-archive-shell">
                <button type="button" className="timeline-archive-toggle" aria-expanded={archiveOpen} onClick={archiveOpen ? closeArchive : openArchive}>
                  <span>Archiv (Vergangene Ereignisse)</span>
                  <span className="timeline-archive-toggle-state">{archiveOpen ? "Ausblenden" : "Anzeigen"}</span>
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

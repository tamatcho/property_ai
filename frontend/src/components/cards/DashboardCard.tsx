import { useMemo } from "react";
import { DocumentItem, TimelineItem } from "../../types";

type TaxData = {
  maintenanceCosts?: number;
  adminFees?: number;
  insurance?: number;
  serviceCharges35a?: number;
  handyman35a?: number;
  otherDeductible?: number;
};

type Props = {
  documents: DocumentItem[];
  timelineItems: TimelineItem[];
  onOpenDocuments: () => void;
  onOpenTax: () => void;
  onOpenAssistant: () => void;
};

function parseTaxData(raw?: string): TaxData {
  if (!raw || raw === "{}" || raw === "null") return {};
  try {
    const parsed = JSON.parse(raw) as TaxData;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeCategory(category?: string): "deadline" | "payment" | "meeting" | "info" | "tax" {
  const value = (category || "").trim().toLowerCase();
  if (value === "deadline") return "deadline";
  if (value === "payment") return "payment";
  if (value === "meeting") return "meeting";
  if (value === "tax") return "tax";
  return "info";
}

export default function DashboardCard({
  documents,
  timelineItems,
  onOpenDocuments,
  onOpenTax,
  onOpenAssistant,
}: Props) {
  const today = useMemo(() => {
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    return now;
  }, []);

  const in30Days = useMemo(() => {
    const dt = new Date(today);
    dt.setDate(dt.getDate() + 30);
    return dt;
  }, [today]);

  const taxTotals = useMemo(() => {
    return documents.reduce(
      (acc, doc) => {
        const tax = parseTaxData(doc.tax_data_json);
        acc.service35a += tax.serviceCharges35a || 0;
        acc.handyman35a += tax.handyman35a || 0;
        acc.other += tax.otherDeductible || 0;
        return acc;
      },
      { service35a: 0, handyman35a: 0, other: 0 }
    );
  }, [documents]);

  const deductibleTotal = taxTotals.service35a + taxTotals.handyman35a + taxTotals.other;

  const upcomingItems = useMemo(() => {
    return timelineItems
      .filter((item) => {
        const date = new Date(item.date_iso);
        if (Number.isNaN(date.getTime())) return false;
        return date >= today;
      })
      .sort((a, b) => {
        const aDate = new Date(`${a.date_iso}T${a.time_24h || "00:00"}:00`).getTime();
        const bDate = new Date(`${b.date_iso}T${b.time_24h || "00:00"}:00`).getTime();
        return aDate - bDate;
      })
      .slice(0, 6);
  }, [timelineItems, today]);

  const dueSoonStats = useMemo(() => {
    let deadlines = 0;
    let payments = 0;
    for (const item of timelineItems) {
      const date = new Date(item.date_iso);
      if (Number.isNaN(date.getTime())) continue;
      if (date < today || date > in30Days) continue;
      const category = normalizeCategory(item.category);
      if (category === "deadline") deadlines += 1;
      if (category === "payment") payments += 1;
    }
    return { deadlines, payments };
  }, [in30Days, timelineItems, today]);

  return (
    <section className="w-full max-w-6xl">
      <header className="mb-6">
        <h2 className="text-2xl font-bold text-gray-900">Dashboard</h2>
        <p className="text-gray-600">Schneller Ueberblick ueber Dokumente, Fristen und steuerliche Potenziale.</p>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4 mb-6">
        <article className="bg-white border border-gray-200 rounded-xl p-4">
          <div className="text-sm text-gray-500">Dokumente</div>
          <div className="mt-2 text-2xl font-semibold text-gray-900">{documents.length}</div>
          <button className="mt-3 text-sm text-brand-700 font-medium hover:underline" onClick={onOpenDocuments}>
            Zu Dokumenten
          </button>
        </article>
        <article className="bg-white border border-gray-200 rounded-xl p-4">
          <div className="text-sm text-gray-500">Fristen (30 Tage)</div>
          <div className="mt-2 text-2xl font-semibold text-gray-900">{dueSoonStats.deadlines}</div>
          <div className="mt-1 text-xs text-gray-500">Deadline-Kategorie aus Timeline</div>
        </article>
        <article className="bg-white border border-gray-200 rounded-xl p-4">
          <div className="text-sm text-gray-500">Zahlungen (30 Tage)</div>
          <div className="mt-2 text-2xl font-semibold text-gray-900">{dueSoonStats.payments}</div>
          <div className="mt-1 text-xs text-gray-500">Payment-Kategorie aus Timeline</div>
        </article>
        <article className="bg-white border border-gray-200 rounded-xl p-4">
          <div className="text-sm text-gray-500">§35a Potenzial</div>
          <div className="mt-2 text-2xl font-semibold text-gray-900">
            {deductibleTotal.toLocaleString("de-DE", { style: "currency", currency: "EUR" })}
          </div>
          <button className="mt-3 text-sm text-brand-700 font-medium hover:underline" onClick={onOpenTax}>
            Zur Steuerhilfe
          </button>
        </article>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <section className="bg-white border border-gray-200 rounded-xl p-4">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-gray-900">Naechste Termine</h3>
            <span className="text-xs text-gray-500">ab heute</span>
          </div>
          {upcomingItems.length === 0 ? (
            <div className="mt-4 text-sm text-gray-500">Keine kommenden Termine in der Timeline.</div>
          ) : (
            <ul className="mt-4 space-y-3">
              {upcomingItems.map((item, index) => (
                <li key={`${item.date_iso}-${item.title}-${index}`} className="border border-gray-100 rounded-lg p-3">
                  <div className="text-sm font-medium text-gray-900">{item.title || "Ohne Titel"}</div>
                  <div className="mt-1 text-xs text-gray-600">
                    {item.date_iso}
                    {item.time_24h ? `, ${item.time_24h}` : ""}
                    {item.filename ? ` - ${item.filename}` : ""}
                  </div>
                  <div className="mt-1 text-xs uppercase tracking-wide text-gray-500">
                    Kategorie: {normalizeCategory(item.category)}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="bg-white border border-gray-200 rounded-xl p-4">
          <h3 className="font-semibold text-gray-900">Schnellaktionen</h3>
          <div className="mt-4 grid grid-cols-1 gap-3">
            <button className="w-full text-left border border-gray-200 rounded-lg px-4 py-3 hover:bg-gray-50" onClick={onOpenDocuments}>
              <div className="text-sm font-medium text-gray-900">Dokumente verwalten</div>
              <div className="text-xs text-gray-600">Upload, Status und Re-Processing</div>
            </button>
            <button className="w-full text-left border border-gray-200 rounded-lg px-4 py-3 hover:bg-gray-50" onClick={onOpenAssistant}>
              <div className="text-sm font-medium text-gray-900">Fragen stellen</div>
              <div className="text-xs text-gray-600">Quellenbasierte Antworten aus deinen Dokumenten</div>
            </button>
            <button className="w-full text-left border border-gray-200 rounded-lg px-4 py-3 hover:bg-gray-50" onClick={onOpenTax}>
              <div className="text-sm font-medium text-gray-900">Steuerdaten exportieren</div>
              <div className="text-xs text-gray-600">Summen und CSV fuer §35a EStG</div>
            </button>
          </div>
        </section>
      </div>
    </section>
  );
}

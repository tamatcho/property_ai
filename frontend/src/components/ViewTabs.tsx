export type AppView = "dashboard" | "documents" | "tax" | "assistant";

type Props = {
  activeTab: AppView;
  onChange: (tab: AppView) => void;
  orientation?: "vertical" | "horizontal";
  className?: string;
};

type TabConfig = {
  id: AppView;
  label: string;
  iconPath: string;
};

const TABS: TabConfig[] = [
  {
    id: "dashboard",
    label: "Dashboard",
    iconPath: "M3 13h8V3H3v10zm10 8h8V3h-8v18zM3 21h8v-6H3v6z",
  },
  {
    id: "documents",
    label: "Dokumente",
    iconPath: "M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10",
  },
  {
    id: "tax",
    label: "Steuerhilfe",
    iconPath: "M13 7h8m0 0v8m0-8l-8 8-4-4-6 6",
  },
  {
    id: "assistant",
    label: "Chat",
    iconPath: "M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z",
  },
];

export default function ViewTabs({
  activeTab,
  onChange,
  orientation = "vertical",
  className = "",
}: Props) {
  const isVertical = orientation === "vertical";
  const navClass = isVertical
    ? "space-y-1"
    : "flex items-center gap-2 overflow-x-auto";
  const buttonClass = isVertical
    ? "w-full justify-start"
    : "shrink-0";

  return (
    <nav className={`${navClass} ${className}`.trim()}>
      {TABS.map((tab) => {
        const isActive = tab.id === activeTab;
        return (
          <button
            key={tab.id}
            onClick={() => onChange(tab.id)}
            className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${buttonClass} ${
              isActive
                ? "bg-brand-50 text-brand-700 font-semibold"
                : "text-gray-600 hover:bg-gray-50 font-medium"
            }`}
          >
            <svg className="w-5 h-5 opacity-70" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={tab.iconPath} />
            </svg>
            {tab.label}
          </button>
        );
      })}
    </nav>
  );
}

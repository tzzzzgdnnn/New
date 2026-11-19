// Phone navigation: a fixed bottom tab bar (the desktop app uses Sidebar).
import {
  HomeIcon,
  SearchIcon,
  HistoryIcon,
  DownloadsQueueIcon,
  SettingsIcon,
} from "../../components/Icons";

const TABS = [
  { id: "home", label: "Home", Icon: HomeIcon },
  { id: "search", label: "Search", Icon: SearchIcon },
  { id: "history", label: "Library", Icon: HistoryIcon },
  { id: "downloads", label: "Downloads", Icon: DownloadsQueueIcon },
  { id: "settings", label: "Settings", Icon: SettingsIcon },
];

export default function TabBar({ page, onNavigate, onSearch, activeDownloads }) {
  return (
    <nav className="sp-tabbar" aria-label="Tabs">
      {TABS.map(({ id, label, Icon }) => {
        const active = page === id;
        const badge = id === "downloads" && activeDownloads > 0 ? activeDownloads : null;
        return (
          <button
            key={id}
            type="button"
            className={`sp-tab${active ? " is-active" : ""}`}
            aria-current={active ? "page" : undefined}
            onClick={() => (id === "search" ? onSearch() : onNavigate(id))}
          >
            <Icon />
            <span className="sp-tab-label">{label}</span>
            {badge && <span className="sp-tab-badge">{badge}</span>}
          </button>
        );
      })}
    </nav>
  );
}

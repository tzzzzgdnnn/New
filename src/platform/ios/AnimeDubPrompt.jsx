// First-run choice for anime audio, shown once on the first anime title.
// The answer is saved and can be changed later in Settings.
import { setAnimeDubMode } from "./playerBridge";

const OPTIONS = [
  { mode: "sub", title: "Sub", detail: "Japanese audio with subtitles" },
  { mode: "dub", title: "Dub", detail: "English audio" },
];

export default function AnimeDubPrompt({ onChoose }) {
  const choose = (mode) => onChoose?.(setAnimeDubMode(mode));
  return (
    <div className="sb-dub-prompt" role="dialog" aria-modal="true" aria-labelledby="sb-dub-title">
      <div className="sb-dub-card">
        <div id="sb-dub-title" className="sb-dub-title">
          Watch anime in Sub or Dub?
        </div>
        <div className="sb-dub-sub">You can change this anytime in Settings.</div>
        <div className="sb-dub-buttons">
          {OPTIONS.map((o) => (
            <button key={o.mode} className="sb-dub-btn" onClick={() => choose(o.mode)}>
              <span className="sb-dub-btn-title">{o.title}</span>
              <span className="sb-dub-btn-detail">{o.detail}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Settings row: the same choice, changeable at any time. */
export function AnimeDubSetting({ value, onChange }) {
  return (
    <div className="sb-dub-buttons sb-dub-buttons--inline">
      {OPTIONS.map((o) => (
        <button
          key={o.mode}
          className={"sb-dub-btn" + (value === o.mode ? " is-active" : "")}
          onClick={() => onChange?.(setAnimeDubMode(o.mode))}
        >
          <span className="sb-dub-btn-title">{o.title}</span>
          <span className="sb-dub-btn-detail">{o.detail}</span>
        </button>
      ))}
    </div>
  );
}

// First run of a Kids profile: pick a few favorite characters. Saved per
// profile; the Kids Home puts them (and their shows) first.
import { useState } from "react";
import { saveKidsFavorites, useKidsCharacters } from "./kidsCatalog";
import "./kids.css";

const MIN_PICKS = 3;

export default function KidsOnboarding({ name, apiKey, onDone }) {
  const { ready, list } = useKidsCharacters(apiKey);
  const [picked, setPicked] = useState(() => new Set());
  const toggle = (key) =>
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
  const finish = (keys) => {
    saveKidsFavorites(keys);
    onDone?.(keys);
  };
  const left = Math.max(0, MIN_PICKS - picked.size);
  return (
    <div className="kids-onb" role="dialog" aria-label="Pick your favorites">
      <div className="kids-onb-head">
        <div className="kids-onb-title">Hi{name ? ` ${name}` : ""}! Who are your favorites?</div>
        <div className="kids-onb-sub">Pick {MIN_PICKS} or more characters you love.</div>
      </div>
      <div className="kids-onb-grid">
        {list.map((c) => (
          <button
            key={c.key}
            type="button"
            className={"kids-char kids-onb-char" + (picked.has(c.key) ? " is-on" : "")}
            aria-pressed={picked.has(c.key)}
            onClick={() => toggle(c.key)}
          >
            <span className="kids-char-img">
              <img src={c.img} alt="" loading="lazy" decoding="async" draggable="false" />
              {picked.has(c.key) && <span className="kids-onb-check" aria-hidden="true">✓</span>}
            </span>
            <span className="kids-char-name">{c.name}</span>
          </button>
        ))}
        {!ready && Array.from({ length: list.length ? 3 : 9 }, (_, i) => <span key={`s${i}`} className="kids-char kids-char--skel" />)}
      </div>
      {ready && !list.length && <div className="kids-onb-sub">No characters available right now. You can pick them later.</div>}
      <div className="kids-onb-bar">
        <button type="button" className="kids-onb-skip" onClick={() => finish([])}>
          Skip
        </button>
        <button type="button" className="kids-onb-go" disabled={left > 0} onClick={() => finish([...picked])}>
          {left > 0 ? `Pick ${left} more` : "Let's go!"}
        </button>
      </div>
    </div>
  );
}

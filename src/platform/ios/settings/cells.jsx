// iOS Settings building blocks: inset grouped sections, rows with colored
// icon tiles, chevrons, native-style switches and checkmark lists. Styled by
// settings.css (iOS build only).
import { useId } from "react";

// ── Glyphs (24×24, stroke = currentColor) ─────────────────────────────────
const P = {
  play: <path d="M8 5.5v13l10.5-6.5z" fill="currentColor" stroke="none" />,
  captions: (
    <>
      <rect x="3" y="5.5" width="18" height="13" rx="3" />
      <path d="M10.5 10.2a2.4 2.4 0 1 0 0 3.6M17 10.2a2.4 2.4 0 1 0 0 3.6" />
    </>
  ),
  mic: (
    <>
      <rect x="9" y="3.5" width="6" height="11" rx="3" />
      <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3" />
    </>
  ),
  shield: <path d="M12 3.5 5 6v5.5c0 4.4 3 7.9 7 9 4-1.1 7-4.6 7-9V6z" />,
  brush: (
    <>
      <path d="M14.5 4.5 19.5 9.5 11 18l-5-5z" />
      <path d="M6 13c-1.8.6-2.5 2.2-2.5 4.5 2.3 0 3.9-.7 4.5-2.5" />
    </>
  ),
  home: <path d="M4 11 12 4.5 20 11v8.5h-5.5v-5h-5v5H4z" />,
  rocket: (
    <>
      <path d="M12 3c3 2 4.5 5.5 4 10l-2 3h-4l-2-3c-.5-4.5 1-8 4-10z" />
      <circle cx="12" cy="9.5" r="1.6" />
      <path d="M8 13l-2.5 2.5L7 18M16 13l2.5 2.5L17 18" />
    </>
  ),
  books: (
    <>
      <path d="M5 4.5h4v15H5zM10 4.5h4v15h-4z" />
      <path d="m15.5 5.2 3.7-.9 3 14.2-3.7.9z" transform="translate(-1.5 0)" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17M12 3.5c2.4 2.4 3.5 5.2 3.5 8.5s-1.1 6.1-3.5 8.5c-2.4-2.4-3.5-5.2-3.5-8.5S9.6 5.9 12 3.5z" />
    </>
  ),
  archive: (
    <>
      <rect x="3.5" y="4.5" width="17" height="4.5" rx="1.2" />
      <path d="M5 9v10.5h14V9M10 13h4" />
    </>
  ),
  trash: (
    <>
      <path d="M4.5 6.5h15M9.5 6.5V4.5h5v2M6.5 6.5l1 13h9l1-13" />
      <path d="M10 10.5v6M14 10.5v6" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v5.5M12 7.6v.2" />
    </>
  ),
  film: (
    <>
      <rect x="3.5" y="5" width="17" height="14" rx="2.5" />
      <path d="M8 5v14M16 5v14M3.5 9.5H8M3.5 14.5H8M16 9.5h4.5M16 14.5h4.5" />
    </>
  ),
  key: (
    <>
      <circle cx="8" cy="12" r="3.8" />
      <path d="M11.8 12h8.7M17.5 12v3M20.5 12v2.2" />
    </>
  ),
  people: (
    <>
      <circle cx="9" cy="8.5" r="3.2" />
      <path d="M3.5 19c.6-3.3 2.8-5 5.5-5s4.9 1.7 5.5 5" />
      <circle cx="17" cy="9.5" r="2.4" />
      <path d="M15.8 14.3c2.4-.3 4.3 1.2 4.7 4.2" />
    </>
  ),
  gauge: (
    <>
      <path d="M4.5 16.5a8 8 0 1 1 15 0" />
      <path d="m12 13.5 3.5-4" />
    </>
  ),
};

/** A row glyph inside a colored rounded square (like iOS Settings). */
export function IconTile({ name, color = "var(--sp-accent)" }) {
  return (
    <span className="sps-tile" style={{ background: color }} aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
        {P[name] || P.info}
      </svg>
    </span>
  );
}

/** Inset rounded section with an optional header and footer. */
export function Group({ header, footer, children }) {
  return (
    <section className="sps-group">
      {header && <h3 className="sps-group-head">{header}</h3>}
      <div className="sps-group-body">{children}</div>
      {footer && <div className="sps-group-foot">{footer}</div>}
    </section>
  );
}

/**
 * One row. With onClick it is a button (chevron unless `chevron={false}`);
 * `accessory` replaces the trailing value/chevron (a switch, a field).
 */
export function Row({ icon, iconColor, label, detail, value, onClick, chevron, accessory, danger, center, disabled, htmlFor }) {
  const nav = chevron ?? (!!onClick && !accessory);
  const action = !!onClick && !nav && !accessory && !danger;
  const body = (
    <>
      {icon && <IconTile name={icon} color={iconColor} />}
      <span className="sps-row-main">
        <span className="sps-row-text">
          <span className="sps-row-label">{label}</span>
          {detail && <span className="sps-row-detail">{detail}</span>}
        </span>
        {value != null && value !== "" && <span className="sps-row-value">{value}</span>}
        {accessory}
        {nav && <span className="sps-chev" aria-hidden="true" />}
      </span>
    </>
  );
  const cls =
    "sps-row" +
    (icon ? " has-icon" : "") +
    (danger ? " is-danger" : "") +
    (center ? " is-center" : "") +
    (action ? " is-action" : "") +
    (onClick ? " is-tappable" : "");
  if (onClick)
    return (
      <button type="button" className={cls} onClick={onClick} disabled={disabled}>
        {body}
      </button>
    );
  if (htmlFor)
    return (
      <label className={cls + " is-tappable"} htmlFor={htmlFor}>
        {body}
      </label>
    );
  return <div className={cls}>{body}</div>;
}

/** Native-style switch row; the whole row toggles. */
export function SwitchRow({ icon, iconColor, label, detail, value, onChange }) {
  const id = useId();
  return (
    <Row
      icon={icon}
      iconColor={iconColor}
      label={label}
      detail={detail}
      htmlFor={id}
      accessory={
        <input
          id={id}
          type="checkbox"
          role="switch"
          className="sps-switch"
          checked={!!value}
          onChange={(e) => onChange(e.target.checked)}
        />
      }
    />
  );
}

/** Pick-one list with a checkmark on the selected row. */
export function ChoiceList({ options, value, onChange }) {
  return options.map((o) => {
    const on = String(o.value) === String(value);
    return (
      <Row
        key={String(o.value)}
        label={o.label}
        detail={o.detail}
        onClick={() => onChange(o.value)}
        chevron={false}
        accessory={
          <span className={"sps-check" + (on ? " is-on" : "")} aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="m5 12.5 4.5 4.5L19 7.5" />
            </svg>
          </span>
        }
      />
    );
  });
}

/** − value + stepper for small numeric settings. */
export function Stepper({ value, min, max, step = 1, onChange, format = (v) => v }) {
  const set = (v) => onChange(Math.max(min, Math.min(max, v)));
  return (
    <span className="sps-stepper">
      <span className="sps-stepper-val">{format(value)}</span>
      <span className="sps-stepper-btns">
        <button type="button" aria-label="Decrease" disabled={value <= min} onClick={() => set(value - step)}>
          −
        </button>
        <button type="button" aria-label="Increase" disabled={value >= max} onClick={() => set(value + step)}>
          +
        </button>
      </span>
    </span>
  );
}

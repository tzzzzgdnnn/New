// Every movie / TV page on a Kids profile renders through this gate: the
// page (and anything it would start: autoplay, Continue Watching resume,
// downloads, server lookups) mounts only after the title's US certification
// is verified as allowed. Direct navigation, restored navigation after a
// reload and links from any list all land here.
import { useEffect, useState } from "react";
import { isKidsProfileActive } from "../../../utils/profileScope";
import { cachedKidsVerdict, resolveKidsVerdict } from "./kidsFilter";
import { kidsFetcher } from "./useKidsFilter";
import "./kids.css";

export default function KidsTitleGate({ item, type, apiKey, onBack, children }) {
  const kids = isKidsProfileActive();
  const probe = item ? { ...item, media_type: type } : null;
  const [verdict, setVerdict] = useState(() => (kids && probe ? cachedKidsVerdict(probe) : true));
  const key = `${type}_${item?.id}`;
  useEffect(() => {
    if (!kids || !probe) return;
    const now = cachedKidsVerdict(probe);
    setVerdict(now);
    if (now !== undefined) return;
    let alive = true;
    resolveKidsVerdict(probe, kidsFetcher(apiKey)).then((ok) => alive && setVerdict(ok));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kids, key, apiKey]);

  if (!kids) return children;
  if (verdict === true) return children;
  if (verdict === undefined)
    return (
      <div className="sp-page-loading kids-gate-loading" role="status" aria-label="Checking">
        <span />
      </div>
    );
  return (
    <div className="kids-blocked" role="alert">
      <div className="kids-blocked-emoji" aria-hidden="true">🙈</div>
      <div className="kids-blocked-title">Not available on Kids profiles</div>
      <div className="kids-blocked-sub">Pick something else to watch!</div>
      {onBack && (
        <button className="kids-blocked-btn" onClick={onBack}>
          Go back
        </button>
      )}
    </div>
  );
}

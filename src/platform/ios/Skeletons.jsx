// Shimmer placeholders shown while rows and the billboard load.

const RAIL_POSTERS = 6;
const HOME_RAILS = 3;

/** A titled row of poster-shaped shimmer blocks. */
export function SkeletonRail({ wide = false }) {
  return (
    <div className="section sb-row-section" aria-hidden="true">
      <div className="sp-skel sp-skel-title" />
      <div className="sb-row">
        {Array.from({ length: RAIL_POSTERS }, (_, i) => (
          <div key={i} className={wide ? "sb-wide-item" : "sb-row-item"}>
            <div className={"sp-skel " + (wide ? "sp-skel-wide" : "sp-skel-poster")} />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Billboard plus a few rails, used while Home's first data loads. */
export function HomeSkeleton() {
  return (
    <div className="sp-home-skel" role="status" aria-label="Loading">
      <div className="sp-skel sp-skel-bill" />
      {Array.from({ length: HOME_RAILS }, (_, i) => (
        <SkeletonRail key={i} />
      ))}
    </div>
  );
}

/** Thumbnail + two-line rows: episodes (16:9) or search results (poster). */
export function SkeletonList({ rows = 4, poster = false }) {
  return (
    <div className="sp-skel-list" role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="sp-skel-row">
          <div className={"sp-skel " + (poster ? "sp-skel-thumb-poster" : "sp-skel-thumb")} />
          <div className="sp-skel-text">
            <div className="sp-skel sp-skel-line" />
            <div className="sp-skel sp-skel-line sp-skel-short" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Title page while its details load: backdrop, title, overview, episodes. */
export function DetailSkeleton() {
  return (
    <div className="sp-detail-skel" role="status" aria-label="Loading">
      <div className="sp-skel sp-skel-bill" />
      <div className="section">
        <div className="sp-skel sp-skel-title" />
        <div className="sp-skel sp-skel-line" />
        <div className="sp-skel sp-skel-line sp-skel-short" />
      </div>
      <div className="section">
        <SkeletonList rows={3} />
      </div>
    </div>
  );
}

/** Search results while a query loads: cards shaped like `.search-result`. */
export function SearchSkeleton({ rows = 6 }) {
  return (
    <div className="sp-search-skel" role="status" aria-label="Searching" aria-busy="true">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="search-result sp-search-skel-card" aria-hidden="true">
          <div className="sp-skel sp-search-skel-poster" />
          <div className="search-result-info sp-skel-text">
            <div className="sp-skel sp-skel-line sp-search-skel-title" />
            <div className="sp-skel sp-skel-line sp-skel-short sp-search-skel-meta" />
          </div>
          <div className="sp-skel sp-search-skel-badge" />
        </div>
      ))}
    </div>
  );
}

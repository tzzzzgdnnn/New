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

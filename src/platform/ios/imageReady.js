// Marks an image's container once the image has loaded, so the shimmer
// placeholder behind it (polish.css) stops animating instead of repainting
// under every poster forever.

const READY_CLASS = "sp-img-ready";

/** Listen (once, app-wide) for image loads and errors in capture phase. */
export function installImageReadyMarker() {
  const mark = (e) => {
    if (e.target instanceof HTMLImageElement) e.target.parentElement?.classList.add(READY_CLASS);
  };
  document.addEventListener("load", mark, true);
  document.addEventListener("error", mark, true);
}

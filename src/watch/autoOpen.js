// Pick + Play: when the party's title changes, every device opens it and
// starts its player by itself. This is the rule for "should this device open
// it now" (pure, so the tests run it).

/**
 * Open `media` here unless this device opened that title itself moments ago
 * (its own pick, already opened from the Pick sheet) or its player already
 * has it open.
 */
export function shouldAutoOpen(media, opened, now, playerHas) {
  if (!media?.key) return false;
  if (opened?.key === media.key && now - (opened.at || 0) < 15_000) return false;
  if (playerHas?.(media.key)) return false;
  return true;
}

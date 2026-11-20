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

/** A media key without the anime audio suffix: the same title / episode. */
export const titleKey = (key) => String(key || "").replace(/:(sub|dub)$/, "");

/**
 * Press Play on a title page while in a party: put it on for everyone
 * unless it is what the party already has (this device just auto-opened the
 * party's title, maybe with its own anime audio), so two phones never
 * bounce the party between titles.
 */
export function shouldAnnounce(media, roomMedia) {
  if (!media?.key) return false;
  if (!roomMedia?.key) return true;
  return titleKey(media.key) !== titleKey(roomMedia.key);
}

/**
 * Key this device reports for what its page has open. The party's own title
 * opened with another anime audio (sub vs dub) still counts as loaded, or
 * the room would hold everyone forever waiting on it.
 */
export function localKey(hereKey, roomMedia) {
  if (!hereKey) return null;
  if (roomMedia?.key && titleKey(roomMedia.key) === titleKey(hereKey)) return roomMedia.key;
  return hereKey;
}

/** "Show · S1 E2" note shown when the party's title changes. */
export function nowPlayingNote(media) {
  if (!media) return "";
  const ep = media.type === "tv" ? ` · S${media.season || 1} E${media.episode || 1}` : "";
  return `Now playing for everyone: ${media.title || "something"}${ep}`;
}

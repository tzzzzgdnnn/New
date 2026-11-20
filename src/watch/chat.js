// Party chat as every screen shows it (web overlay, iPhone and Android
// players). Plain functions so the tests run the same code.

/** The room HTML-escapes names and text; screens show them as plain text. */
export const unescapeHtml = (s) =>
  String(s || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");

/**
 * Chat for the screen: unescaped, newest last, each line with its sender's
 * picture (from the message, else from members[], else `fallback(name)`).
 * `rawName` / `rawText` keep the escaped originals for the native players.
 */
export function chatView(list, members, myId, fallback = () => null) {
  const byId = new Map((members || []).map((m) => [m.id, m]));
  return (list || []).map((c) => {
    const name = unescapeHtml(c.name);
    return {
      ...c,
      name,
      text: unescapeHtml(c.text),
      rawName: c.name,
      rawText: c.text,
      avatar: c.avatar || byId.get(c.from)?.avatar || fallback(name),
      mine: c.from === myId,
    };
  });
}

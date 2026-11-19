// Reachability probe for an embed URL: time until the server answers.
// `no-cors` keeps it to one opaque HEAD request (embed hosts send no CORS
// headers); a network error, DNS failure or abort rejects.
export const probeUrl = (url, signal, fetchImpl = globalThis.fetch) =>
  fetchImpl(url, { method: "HEAD", mode: "no-cors", cache: "no-store", redirect: "follow", signal }).then(
    (res) => {
      if (res.type !== "opaque" && res.status >= 500) throw new Error(`HTTP ${res.status}`);
    },
  );

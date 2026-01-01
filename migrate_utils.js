/**
 * migrate_utils.js
 *
 * Fonctions pures (testables) utilisées par migrate.js :
 * - buildSearchUrl
 * - CSV/JSON export helpers
 *
 * Compatible navigateur + Node (CommonJS) pour tests simples.
 */

(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.MP_MIGRATE_UTILS = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  function normalizeTitle(s) {
    return String(s || "").trim();
  }

  function buildSearchUrl(siteId, title) {
    const q = encodeURIComponent(normalizeTitle(title));
    switch (siteId) {
      case "mangadex":
        return `https://mangadex.org/search?q=${q}`;
      case "anilist":
        return `https://anilist.co/search/manga?search=${q}`;
      case "mal":
        return `https://myanimelist.net/manga.php?q=${q}&cat=manga`;
      case "mangaupdates":
        return `https://www.mangaupdates.com/search.html?search=${q}`;
      default:
        return `https://mangadex.org/search?q=${q}`;
    }
  }

  function csvEscape(value) {
    const s = String(value ?? "");
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  }

  function makeCsv(items) {
    const header = [
      "title",
      "mangapark_url",
      "comic_id",
      "last_read_serial",
      "last_read_url",
      "captured_at",
    ];
    const lines = [header.join(",")];
    for (const it of items || []) {
      lines.push(
        [
          csvEscape(it.title),
          csvEscape(it.mangapark_url),
          csvEscape(it.comic_id),
          csvEscape(it.last_read_serial),
          csvEscape(it.last_read_url),
          csvEscape(it.captured_at),
        ].join(",")
      );
    }
    return lines.join("\n");
  }

  function makeJson(payload) {
    return JSON.stringify(payload, null, 2);
  }

  return { buildSearchUrl, makeCsv, makeJson, csvEscape, normalizeTitle };
});


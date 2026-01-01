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

  function normalizeForMatch(s) {
    // Aggressive normalization for fuzzy matching (ASCII-ish, lowercase, compact spaces).
    // Keep it dependency-free and deterministic.
    try {
      let x = String(s || "");
      x = x.normalize("NFKD").replace(/[\u0300-\u036f]/g, ""); // strip diacritics
      x = x.toLowerCase();
      // Replace punctuation/separators with spaces
      x = x.replace(/[^a-z0-9]+/g, " ");
      x = x.replace(/\s+/g, " ").trim();
      return x;
    } catch {
      return String(s || "").toLowerCase().trim();
    }
  }

  function diceCoefficient(a, b) {
    // Sørensen–Dice coefficient on bigrams (0..1)
    const s1 = normalizeForMatch(a);
    const s2 = normalizeForMatch(b);
    if (!s1 || !s2) return 0;
    if (s1 === s2) return 1;
    if (s1.length < 2 || s2.length < 2) return 0;

    const bigrams = new Map();
    for (let i = 0; i < s1.length - 1; i += 1) {
      const bg = s1.slice(i, i + 2);
      bigrams.set(bg, (bigrams.get(bg) || 0) + 1);
    }

    let matches = 0;
    for (let i = 0; i < s2.length - 1; i += 1) {
      const bg = s2.slice(i, i + 2);
      const count = bigrams.get(bg) || 0;
      if (count > 0) {
        bigrams.set(bg, count - 1);
        matches += 1;
      }
    }

    const total = (s1.length - 1) + (s2.length - 1);
    return total > 0 ? (2 * matches) / total : 0;
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

  return {
    buildSearchUrl,
    makeCsv,
    makeJson,
    csvEscape,
    normalizeTitle,
    normalizeForMatch,
    diceCoefficient,
  };
});


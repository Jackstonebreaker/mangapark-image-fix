## Texte de fiche Chrome Web Store — MangaPark Toolkit

Tu peux copier/coller ces sections dans le Chrome Web Store. Elles sont alignées avec `manifest.json` et `PRIVACY.md`.

---

### FR — Description courte

Répare les images cassées sur MangaPark, exporte ta follow list (CSV/JSON) et t’aide à migrer vers d’autres services — tout tourne localement.

### FR — Description détaillée

**MangaPark Toolkit** est une extension Chrome (Manifest V3) conçue pour améliorer ton expérience sur MangaPark et domaines alternatifs.

Fonctionnalités :
- **Fix images** : corrige automatiquement certaines URLs d’images cassées (réécriture des URLs `s00..s10` `/media/` vers le domaine courant).
- **Fix this page** : lance le correctif une fois sur l’onglet actif (après clic).
- **Export** : sauvegarde ta follow list MangaPark en **CSV/JSON** sur ton ordinateur.
- **Migration** : ouvre des recherches (MangaDex, AniList, MyAnimeList, MangaUpdates) pour t’aider à retrouver tes titres.
- **MangaDex (optionnel)** :
  - **Auto-match** (suggestions via l’API publique MangaDex)
  - **Auto-follow via API** (avancé / opt‑in) : nécessite ton propre client API MangaDex.

Confidentialité :
- Pas d’analytics, pas de tracking.
- L’extension n’a pas de serveur “éditeur”.
- Les données restent dans ton navigateur (Chrome storage) et dans les fichiers exportés.
- Détails complets : voir `PRIVACY.md`.

Permissions (résumé) :
- `storage` : préférences + état export/migration.
- `activeTab` + `scripting` : action “Fix this page”.
- `downloads` : téléchargement des exports.
- `alarms` : exécution en arrière-plan de certaines actions opt‑in (auto-follow batch).

---

### EN — Short description

Fix broken MangaPark images, export your follow list (CSV/JSON), and help migration to other services — everything runs locally.

### EN — Detailed description

**MangaPark Toolkit** is a Chrome extension (Manifest V3) that improves MangaPark reading and library portability.

Features:
- **Image fix**: rewrites broken image URLs (`s00..s10` `/media/`) to the current domain.
- **Fix this page**: one-shot fix on the current tab (after a user click).
- **Export**: saves your MangaPark follow list locally as **CSV/JSON**.
- **Migration helper**: opens search pages (MangaDex, AniList, MyAnimeList, MangaUpdates).
- **MangaDex (optional)**:
  - **Auto-match** suggestions using the public MangaDex API
  - **API auto-follow** (advanced / opt‑in) using your own MangaDex API client

Privacy:
- No analytics, no tracking.
- No publisher backend.
- Data stays in your browser (Chrome storage) and in your exported files.
- Full details: see `PRIVACY.md`.


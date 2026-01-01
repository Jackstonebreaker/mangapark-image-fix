# MangaPark Toolkit (Chrome Extension MV3)

[![CI](https://github.com/Jackstonebreaker/mangapark-image-fix/actions/workflows/ci.yml/badge.svg)](https://github.com/Jackstonebreaker/mangapark-image-fix/actions/workflows/ci.yml)
![Version](https://img.shields.io/badge/version-1.0.0-blue)
![License](https://img.shields.io/badge/license-MIT-green)

Extension Chrome **Manifest V3** qui :

- **Corrige** des images cassées sur MangaPark (et domaines alternatifs) en réécrivant certaines URLs `s00..s10` `/media/`.
- **Exporte** ta follow list localement (CSV/JSON) — privacy-first.
- **Aide** à une migration manuelle via un panneau dédié (recherche sur services tiers, sans automatisation).

## Screenshots

> Remplace ces placeholders par de vraies captures.

- Popup : `docs/assets/popup.svg`
- Migration panel : `docs/assets/migration-panel.svg`

## Installation (Load unpacked)

1. Ouvre `chrome://extensions`
2. Active **Mode développeur**
3. Clique **Charger l’extension non empaquetée**
4. Sélectionne le dossier `mangapark-image-fix/` (celui qui contient `manifest.json`)

## Utilisation (exemples concrets)

### Correction d’images

- Sur un domaine supporté : laisse **Auto-fix = ON**, recharge la page.
- Sur un domaine non listé dans le manifest : clique **Fix this page now**.

### Debug

- Active **Debug = ON**, recharge une page : tu verras un résumé console préfixé **`[MP FIX]`**.

### Export follow list

1. Connecte-toi à MangaPark.
2. Dans le popup : **Export follow list**.
3. Télécharge en **CSV** ou **JSON**.

### Migration assistée

1. Fais un export.
2. Ouvre **Open Migration Panel** (`migrate.html`).
3. Utilise **Search on target site** (MangaDex/AniList/MAL/MangaUpdates) — **manuel**.

## Développement

### Pré-requis

- Node.js 18+ (recommandé : 20)

### Installer / tester / lint / format

```bash
cd mangapark-image-fix
npm install
npm test
npm run lint
npm run format:check
```

### Packaging (zip prêt à charger)

```bash
cd mangapark-image-fix
chmod +x scripts/pack.sh
npm run pack
```

Le zip est généré dans `mangapark-image-fix/dist/mangapark-image-fix.zip`.

## FAQ / Troubleshooting

### “Fix this page now” ne fait rien

- Vérifie que l’extension est activée dans `chrome://extensions`.
- Active **Debug = ON** et regarde les logs console.

### Le site n’est pas auto-corrigé

Il n’est probablement pas dans la liste `matches` du `manifest.json`. Utilise **Fix this page now**.

### Permissions rationale

Permissions déclarées dans `manifest.json` :

- `storage` : sauvegarder préférences, whitelist, état d’export/migration.
- `activeTab` : agir sur l’onglet actif après action utilisateur.
- `scripting` : injecter le patch “one-shot” (Fix this page now).
- `downloads` : télécharger les exports CSV/JSON sans serveur.

Host permissions :

- Domaines MangaPark & alternatifs : exécution du content script.
- `https://api.mangadex.org/*` : utilisé par la migration (recherche/metadata si activé côté UI).

## Compatibilité

Testé sur :

- Chrome (desktop)
- Brave (desktop)
- Microsoft Edge (desktop)

> Si tu as un souci sur une version précise, ouvre une issue avec le template “Bug report”.

## Sécurité

Voir [`SECURITY.md`](SECURITY.md).

## Contribuer

- Guide : [`CONTRIBUTING.md`](CONTRIBUTING.md)
- Code of Conduct : [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md)

## Roadmap

- Ajouter plus de tests unitaires sur la réécriture `srcset`.
- Améliorer la migration (matching + UX).
- Ajouter des issues taggées **`good first issue`** pour onboarding contributeurs.

## Licence

MIT — voir [`LICENSE`](LICENSE).

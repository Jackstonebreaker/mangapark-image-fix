# Contribuer

Merci de vouloir contribuer ! Ce guide est écrit pour un workflow GitHub “classique”.

## Pré-requis

- Node.js (recommandé : 18+)
- Git

## Workflow

1. (Optionnel) Ouvre d’abord une **issue** (bug/feature) pour valider l’approche.
2. **Fork** le dépôt.
2. Crée une branche :
   - `feat/<courte-description>` pour une fonctionnalité
   - `fix/<courte-description>` pour un bug
3. Fais tes changements (petits commits, messages clairs).
4. Lance les checks :
   - `npm install`
   - `npm run test`
   - `npm run lint`
   - `npm run format:check`
5. Ouvre une **Pull Request** vers `main`.

## Bonnes pratiques

- Une PR = un sujet (évite les PR “fourre-tout”).
- Ajoute/maintient des tests quand c’est pertinent (`tests/`).
- Documente tout changement de comportement (README/CHANGELOG).
- Si tu touches à l’UI, ajoute des captures “avant/après” dans la PR.

## Signaler un bug / proposer une amélioration

Utilise les templates GitHub :

- Bug report
- Feature request

## Traductions (i18n)

Une nouvelle langue se fait via `mangapark-image-fix/_locales/<lang>/messages.json`.

## Code of Conduct

En contribuant, tu acceptes notre [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).


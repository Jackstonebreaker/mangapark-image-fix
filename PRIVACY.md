# Politique de confidentialité — MangaPark Toolkit

Ce document décrit comment l’extension gère les données. Objectif : **privacy-first**.

## Résumé

- **Aucune collecte** de données par un serveur “éditeur” : l’extension ne possède pas de backend.
- **Aucun tracking** (pas d’analytics, pas de pixels, pas de fingerprinting).
- Les données restent **dans ton navigateur** (Chrome storage) et/ou dans les **fichiers exportés** que tu télécharges.

## Données utilisées

### 1) Correction d’images

- L’extension inspecte/modifie localement certains attributs d’images (`src`, `srcset`, attributs lazy) afin de corriger des URLs cassées.
- Elle ne lit pas les cookies ni tokens “pour les envoyer ailleurs”. Elle se contente de changer des URLs d’images.

### 2) Export follow list

- L’export lit des données depuis MangaPark en utilisant **ta session déjà connectée** (cookies gérés par le navigateur).
- L’extension ne récupère pas ton mot de passe.
- Les résultats exportés sont stockés localement puis téléchargeables en **JSON/CSV**.

### 3) Migration assistée

- Le panneau de migration ouvre des pages de recherche vers des services tiers (MangaDex, AniList, MAL, MangaUpdates).
- **Aucune automatisation** sur ces sites : pas de login, pas de clic auto, pas d’ajout automatique.

## Stockage (Chrome storage)

L’extension utilise `chrome.storage` pour :

- Préférences : activation, debug, whitelist
- État export/migration : progression, items exportés, etc.

Le stockage peut être **sync** (si disponible) ou **local** selon les politiques/quotas.

## Partage / transfert

- **Aucun transfert** vers un serveur contrôlé par le mainteneur.
- Le seul “transfert” est celui que tu déclenches : requêtes vers les sites cibles (MangaPark / services tiers) et téléchargement de fichiers exportés.

## Rétention / suppression

- Tu peux supprimer les données locales via les boutons **Clear** dans le popup/panneau.
- Tu peux aussi supprimer le stockage de l’extension via `chrome://extensions` → “Détails” → “Effacer les données”.

## Contact / sécurité

- Pour une vulnérabilité : voir [`SECURITY.md`](SECURITY.md).

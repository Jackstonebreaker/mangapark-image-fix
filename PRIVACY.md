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
- L’extension ne te demande pas ton mot de passe MangaPark.
- Les résultats exportés sont stockés localement puis téléchargeables en **JSON/CSV**.

### 3) Migration assistée

- Le panneau de migration ouvre des pages de recherche vers des services tiers (MangaDex, AniList, MAL, MangaUpdates).
- Sur ces sites : **pas de clic auto** et pas d’ajout automatique “à ton insu”.
- Optionnellement, le panneau peut utiliser l’**API publique MangaDex** (`https://api.mangadex.org`) pour proposer un “auto‑match” (suggestions).

### 4) Option avancée : Auto-follow via l’API MangaDex (opt‑in)

Cette fonctionnalité est **désactivée par défaut** et n’est utilisable qu’après action explicite dans le panneau de migration.

- **Données saisies par l’utilisateur** :
  - Identifiants d’un client API MangaDex (`clientId`, `clientSecret`)
  - Ton **nom d’utilisateur MangaDex**
  - Ton **mot de passe MangaDex** (uniquement au moment de la connexion)
- **Ce qui est envoyé sur le réseau** (uniquement vers MangaDex) :
  - Authentification OAuth2 : requête vers `https://auth.mangadex.org/.../token`
  - Actions “follow” : requêtes vers `https://api.mangadex.org/...`
- **Ce qui est stocké localement** :
  - `clientId`, `clientSecret`, `username` : stockés dans `chrome.storage.local` (pour éviter de te les redemander)
  - Jetons d’accès/refresh + expiration : stockés en priorité dans `chrome.storage.session` (sinon `chrome.storage.local` si `session` n’est pas disponible)
- **Ce qui n’est pas stocké** :
  - Le **mot de passe MangaDex** n’est pas sauvegardé dans le stockage de l’extension. Il est utilisé pour obtenir un jeton, puis oublié.

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

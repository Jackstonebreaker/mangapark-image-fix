# Roadmap — MangaPark Toolkit

Ce document est **public** et volontairement simple. Il explique où va le projet, sans promesse de dates.

## 1) Introduction

### Vision
Aider les gros lecteurs (1000+ mangas) à **reprendre le contrôle** de leur bibliothèque MangaPark, sans compromis sur la confidentialité.

### Ce que l’extension fait
- **Corrige** certains problèmes d’images (localement, dans la page).
- **Exporte** ta follow list (CSV/JSON) pour te donner une sauvegarde portable.
- **Aide** à une **migration manuelle** (outils d’organisation et de vérification, pas de “bot”).

### Ce qu’elle ne fera JAMAIS
- **Automatiser** des actions sur des sites tiers (pas d’auto-clics, pas de “robot”, pas de migration en 1 clic).
- **Envoyer** tes données dans le cloud (pas de backend, pas de sync serveur).
- **Tracker** ton activité (pas d’analytics, pas de fingerprinting, pas de pixels).

## 2) Principes produit

- **Privacy-first** : tout reste dans ton navigateur (storage + fichiers exportés).
- **User-in-control** : chaque action importante est **déclenchée par toi** et compréhensible.
- **Manual over automatic** : on préfère des outils qui accélèrent le manuel plutôt qu’une “automatisation magique”.
- **Chrome Web Store compliant** : permissions minimales, comportement transparent, respect des règles CWS.

## 3) Roadmap par version

### V2.0 — Power Migration UX
Objectif : rendre la migration **plus claire** et **plus fiable** pour les gros catalogues.

- **Indicateur “Site supporté / non supporté”** : savoir immédiatement si l’extension peut agir sur la page actuelle.
- **Historique local des exports** (date, nombre de titres, statut, nettoyage manuel) : retrouver ce qui a été exporté, quand, et supprimer ce qui n’est plus utile.
- **Mémorisation des titres déjà migrés** : éviter les doublons et les “re-traitements” inutiles.
- **Indicateur visuel “Déjà traité”** : scanner une liste de centaines/ milliers de titres en quelques secondes.
- **Messages d’erreur plus pédagogiques** : comprendre quoi faire ensuite, sans jargon.

### V2.1 — Migration assistée intelligente
Objectif : aider l’utilisateur à **organiser** le travail restant, sans automatiser.

- **Notes utilisateur par manga** (“À vérifier”, “Trouvé ailleurs”) : marquer rapidement les cas ambigus.
- **Filtrage traités / non traités** : se concentrer sur ce qui reste à faire.
- **Statut visuel par titre** : voir d’un coup d’œil l’état (traité, à vérifier, trouvé ailleurs).

### V2.2 — UX polish
Objectif : améliorer la perception de qualité et la lisibilité des états, sans complexifier.

- **Animations légères (optionnelles)** : micro-feedback discret, désactivable.
- **Transitions douces d’état** (export, pause, terminé) : éviter les changements “brusques” et rendre l’état évident.

### V3.0 — Aide à la découverte (lecture seule)
Objectif : aider à vérifier rapidement si un titre existe ailleurs, **sans compte** et **sans automatisation**.

- **Vérifier si un manga existe sur MangaDex (lecture seule)** : indicateur simple “Found / Not found / Multiple results”.
- **Vérifier si un manga existe sur AniList (lecture seule)** : même indicateur, mêmes règles.

Garde-fous (non négociables) :
- **Sans login**.
- **Sans automatisation** (pas d’actions sur le compte utilisateur, pas de “follow” automatique).
- **Déclenchement manuel** : la recherche est lancée uniquement à la demande.
- **Respect des limites** : gestion des erreurs/rate limits, et pas de collecte de données.

## 4) Ce qui est volontairement hors scope

- **Automatisation sur sites tiers** (auto-clics, formulaires remplis automatiquement, scripts “bot”).
- **Sync cloud** (sauvegarde serveur, multi-appareils via backend).
- **Login externe imposé** (comptes, SSO, etc.).
- **Téléchargement de contenu** (chapitres/images/mangas).

## 5) Contribution & feedback

### Proposer une idée
Ouvre une **issue** (Feature request) et décris :
- le problème utilisateur (1–2 phrases)
- le scénario concret (exemple)
- pourquoi c’est utile pour un gros lecteur

### Signaler un bug
Ouvre une **issue** (Bug report) avec :
- étapes pour reproduire
- résultat attendu vs obtenu
- version de Chrome
- logs si besoin (en évitant toute donnée sensible)

### Rappel des contraintes (légal / CWS)
- Pas de backend, pas de tracking.
- Pas d’automatisation sur sites tiers.
- Permissions et accès réseau doivent rester **minimaux** et justifiés.

---

Merci de garder en tête que le projet est conçu pour rester **maintenable par une seule personne** : on privilégie les features petites, claires, et robustes.

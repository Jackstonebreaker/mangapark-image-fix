# MangaPark Toolkit (Chrome Extension MV3)

Extension Chrome **Manifest V3** qui corrige des images cassées sur *MangaPark et ses domaines alternatifs* en réécrivant certaines URLs d’images.

## Ce que fait l’extension

- Détecte uniquement les images dont le host source est `s00`…`s10` **et** dont le chemin commence par `/media/`.
- Réécrit l’URL vers le domaine courant en conservant uniquement le `pathname` :
  - `newUrl = ${location.protocol}//${location.host}${url.pathname}`
- Applique le correctif sur :
  - `img[src]`
  - `img[srcset]`
  - attributs lazy courants : `data-src`, `data-original`, `data-lazy-src`, `data-echo`, `data-url`
- Gère les ajouts dynamiques via **MutationObserver** (pas de polling).

## Modes

- **Auto-fix** (par défaut ON) : actif uniquement sur les domaines “par défaut” listés dans le manifest (pas d’injection globale).
- **Fix this page now** : injection/patch “one-shot” sur l’onglet actif via `chrome.scripting.executeScript` (action utilisateur), utile si un domaine alternatif n’est pas dans la liste.
- **Debug** (par défaut OFF) :
  - ON : logs console structurés préfixés **`[MP FIX]`** avec résumé (images examinées/patchées + exemples limités à 10).
  - OFF : silence total.
- **Export follow list** (utilitaire) :
  - Exporte la liste de suivis (follow) via l’API interne du site, en utilisant **ta session connectée**.
  - L’export se fait sur la page `/my/follows` : si tu n’y es pas, l’extension ouvre automatiquement `mangapark.net/my/follows` et lance l’export.
  - Les données exportées sont stockées localement (storage) et téléchargeables en **CSV** ou **JSON** depuis le popup.
- **Migration assistée** (utilitaire) :
  - Ouvre un panneau interne qui parcourt les titres exportés et permet d’ouvrir des **pages de recherche** sur des sites externes (MangaDex, AniList, MyAnimeList, MangaUpdates).
  - **Aucune automatisation** : pas de login, pas d’auto-ajout, pas de clic automatique sur ces sites.

## Installation (Load unpacked)

1. Ouvrez Chrome → `chrome://extensions`.
2. Activez **Mode développeur**.
3. Cliquez **Charger l’extension non empaquetée**.
4. Sélectionnez le dossier `mangapark-image-fix/` (celui qui contient `manifest.json`).

## Utilisation

Ouvrez le popup via l’icône :

- **Fix this page now** : force l’exécution sur l’onglet actif (même si domaine non autorisé).
- **Auto-fix** : ON/OFF global.
- **Debug** : ON/OFF.
- **Sites autorisés** : ajouter/supprimer des entrées, bouton **Reset defaults**.
- **Export** :
  - **Export follow list** : démarre l’export (workflow A).
  - **Resume export** : reprend à la dernière page si un export a été interrompu.
  - **Cancel export** : annule l’export en cours.
  - **Download CSV / JSON** : télécharge l’export (pas besoin de permission “downloads”).
  - **Clear** : efface l’état et les données exportées.
- **Migration** :
  - Choisir un **Target site** et “Open in new tab”.
  - **Open Migration Panel** : ouvre la page interne `migrate.html`.
  - Dans le panneau : Search, Copy title, Next/Previous, Remove item, Clear all, Export CSV/JSON.

## Langue de l’extension (i18n)

L’extension utilise `chrome.i18n` et un dossier `/_locales` :

- `/_locales/en` : **obligatoire** (fallback)
- `/_locales/fr` : exemple complet

Dans le popup, le sélecteur **Extension language** permet :

- **Auto** : l’UI suit la langue de Chrome
- **EN/FR** : override manuel (les messages sont chargés localement depuis `/_locales/<lang>/messages.json`)

### Contribuer une nouvelle langue

1. Copier `mangapark-image-fix/_locales/en` vers `mangapark-image-fix/_locales/<lang>` (ex: `es`, `de`, `pt-BR`).
2. Traduire les valeurs `message` dans `messages.json`.
3. (Optionnel) Ajouter l’option de langue dans `popup.js` (liste du sélecteur UI).

## Tests (3 scénarios)

### 1) Domaine supporté (auto-fix ON)

1. Ouvrez un site supporté (domaine présent dans la liste du manifest).
2. Assurez-vous que **Auto-fix = ON**.
3. (Optionnel) Activez **Debug = ON**, rechargez la page → observez les logs **`[MP FIX] summary`**.

### 2) Toggle OFF (aucun patch)

1. Mettez **Auto-fix = OFF** dans le popup.
2. Rechargez la page supportée.
3. Résultat attendu :
   - Aucun patch ne s’exécute.
   - Si Debug = OFF : aucun log.
   - Badge : **OFF**.

### 3) Domaine non supporté (Fix this page now)

1. Ouvrez un domaine/domaine alternatif **non** listé dans le manifest.
2. Cliquez l’icône → bouton **Fix this page now**.
3. Résultat attendu :
   - Le patch s’exécute sur la page (et continue via MutationObserver pour le lazy-load).
   - Si Debug = ON : logs **`[MP FIX] summary`** (exemples limités).


### 5) Export follow list

Étapes :

1. Assure-toi d’être connecté sur MangaPark (session active).
2. Clique **Export follow list** :
   - si tu n’es pas sur `/my/follows`, l’extension ouvre `mangapark.net/my/follows`, attend le chargement, puis lance l’export.
3. Suis la progression dans le popup (Page X/Y — Collected N).
4. Une fois terminé, clique **Download CSV** ou **Download JSON**.
5. Si tu obtiens “NOT_LOGGED_IN”, connecte-toi puis relance.

### 6) Migration assistée

Étapes :

1. Assure-toi d’avoir un export (`mp_export_follows`) déjà fait.
2. Dans le popup, section **Migration** : clique **Open Migration Panel**.
3. Dans le panneau :

    - choisis le **Target site**
    - clique **Search on target site** pour ouvrir une page de recherche
    - utilise **Next/Previous** pour parcourir
    - **Remove item** met à jour la liste stockée (le compteur du popup change)
    - **Export CSV/JSON** télécharge un fichier depuis le panneau

## Dépannage

- **Le bouton “Fix this page now” ne fait rien** :
  - vérifiez que l’extension est bien activée dans `chrome://extensions`
  - ouvrez DevTools Console et activez **Debug = ON** pour voir les résumés
- **Aucun log** : normal si Debug est OFF.
- **Le site n’est pas auto-corrigé** : il n’est peut-être pas dans la liste des domaines du manifest → utilisez **Fix this page now**.

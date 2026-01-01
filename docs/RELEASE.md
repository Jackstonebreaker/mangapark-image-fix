# Release guide

Ce guide décrit une release “propre” (tag + notes + zip).

## 1) Mettre à jour la version

- `manifest.json` → `version`
- `package.json` → `version`
- `CHANGELOG.md` → ajouter une section pour la version

## 2) Checks locaux

```bash
cd mangapark-image-fix
npm install
npm test
npm run lint
npm run format:check
```

## 3) Packaging

```bash
cd mangapark-image-fix
chmod +x scripts/pack.sh
npm run pack
```

Le zip final est : `dist/mangapark-image-fix.zip`.

## 4) Tag et push

```bash
cd mangapark-image-fix
git tag v1.0.0
git push origin v1.0.0
```

## 5) Créer la Release GitHub

1. Sur GitHub, crée une **Release** depuis le tag `v1.0.0`.
2. Colle les notes de version (depuis `CHANGELOG.md`).
3. Attache `dist/mangapark-image-fix.zip` comme asset.


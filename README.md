# Traces

Site de partage de traces GPS (GPX, FIT, KML, IGC). Les visiteurs envoient leur fichier depuis le site, la base se met à jour toute seule et la trace apparaît sur la carte.

## Comment c'est construit

| Rôle | Outil | Coût |
|---|---|---|
| Code | GitHub (ce dépôt) | gratuit |
| Site web | GitHub Pages | gratuit |
| Base de données et fichiers | Supabase | gratuit |
| Anti-robot | Cloudflare Turnstile | gratuit |

Le navigateur lit le fichier de trace (`parsers.js`), en extrait la date, la distance, la durée, les altitudes et un tracé simplifié, puis envoie le tout à la fonction `submit-trace` de Supabase. Cette fonction vérifie l'anti-robot, applique des limites d'usage, range le fichier d'origine dans un stockage privé et ajoute une ligne dans la table `traces`. Le site lit cette table et affiche la carte.

## Fichiers

- `index.html`, `style.css`, `app.js` : le site
- `parsers.js` : lecture des fichiers GPX, FIT, KML, IGC
- `config.js` : adresses et clés publiques (sans danger dans un dépôt public)
- `supabase/` : structure de la base et fonction d'envoi
- `vendor/leaflet/` : bibliothèque de carte (copie locale)
- `tests/` : vérifications automatiques (`npm install`, puis `npm test`)
- `.github/workflows/keepalive.yml` : empêche la mise en pause de Supabase

## Mise en service (une seule fois)

1. **Supabase, SQL Editor** : exécuter `supabase/step1-schema.sql`, puis `supabase/step2-rate-limit.sql`.
2. **Supabase, Edge Functions** : créer une fonction nommée `submit-trace` (bouton « Deploy a new function », puis « Via Editor »), coller le contenu de `supabase/functions/submit-trace/index.ts` et déployer. Dans les réglages de la fonction, désactiver la vérification JWT : la fonction contrôle elle-même chaque envoi.
3. **Supabase, Edge Functions, Secrets** : ajouter `TURNSTILE_SECRET_KEY` avec la clé secrète fournie par Cloudflare.
4. **Cloudflare, Turnstile** : le widget doit autoriser le nom de domaine `danibach.github.io`.
5. **GitHub, Settings, Pages** : source « Deploy from a branch », branche `main`, dossier `/ (root)`.

Le site est alors en ligne sur `https://danibach.github.io/tracks/`.

## Au quotidien

- **Retirer une trace du site** : Supabase, Table Editor, table `traces`, cocher `hidden` sur la ligne.
- **Récupérer les données** : Table Editor, bouton d'export CSV.
- **Fichiers d'origine** : Storage, dossier `trace-files` (privé).

## Limites connues

- Les statistiques sont calculées dans le navigateur de l'utilisateur. La fonction vérifie leur cohérence, mais ne relit pas le fichier.
- Fichiers de 6 Mo au maximum, 5 envois par heure et par connexion, 300 envois par jour pour l'ensemble du site.
- La liste affiche les 500 traces les plus récentes.
- Offre gratuite Supabase : 500 Mo de base et 1 Go de fichiers.

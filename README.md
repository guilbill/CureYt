# CureYt

Classe les vidéos récentes de vos abonnements YouTube selon leur surperformance par rapport à leur propre chaîne.
Page statique (HTML, CSS, JS natif) : tout se passe dans le navigateur, rien n'est envoyé ailleurs qu'à Google.

- Démo sans compte : `?demo` (données fictives)
- Spécification : voir `docs/superpowers/plans/2026-10-16-cureyt-v1.md`
- Tests : `npm test` (Node 20+)
- Développement local : `python3 -m http.server 8000` puis http://localhost:8000

## Activer la connexion Google (une seule fois)

Le code ne contient aucun secret : seul un identifiant client OAuth public va dans `config.js`.

1. Sur https://console.cloud.google.com, créer un projet et activer **YouTube Data API v3**.
2. Écran de consentement OAuth : type **Externe**, statut **Test**, portée `https://www.googleapis.com/auth/youtube.readonly`.
3. Ajouter les adresses Gmail des testeurs (100 maximum).
4. Identifiants > Créer un ID client OAuth > **Application Web**, origines JavaScript autorisées :
   - `https://guilbill.github.io`
   - `http://localhost:8000`
5. Copier l'ID client dans `config.js` (`CLIENT_ID`), commit, push. GitHub Pages republie en une minute.

## Quota

10 000 unités par jour pour tout le projet Google. Chargement complet pour 200 abonnements : environ 410 unités.
Rafraîchissement léger : environ 240. Le cache (IndexedDB) évite tout appel si les données ont moins de 3 h.

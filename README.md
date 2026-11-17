# Parole — entraînement à la prise de parole

Front statique (Netlify) + Supabase (auth, Postgres, RLS) + une Netlify Function pour le coach IA (Anthropic).

## Déployer
1. **Supabase** : créez un projet, ouvrez SQL Editor, collez `supabase/schema.sql`, exécutez. Authentication > Providers : Email activé.
   Authentication > URL Configuration : ajoutez l’URL Netlify dans Site URL.
2. Éditez `config.js` avec l’URL du projet et la clé `anon`.
3. **Netlify** : poussez ce dossier sur Git, « Add new site > Import », ou `npx netlify deploy --prod`.
4. Netlify > Site settings > Environment variables :
   `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `ANTHROPIC_API_KEY` (et `ANTHROPIC_MODEL` si besoin).
5. Ouvrez le site, créez un compte, faites une leçon, demandez un retour.

## Limites connues
- Retour du coach non diffusé en streaming (limite de 10 s des Netlify Functions par défaut, 26 s en réglage payant).
- Pas de quota d’appels IA par utilisateur : à ajouter avant d’ouvrir au public (table `usage` + contrôle dans `coach.mjs`).
- Pas de paiement : Stripe viendrait ensuite via une autre Netlify Function et un webhook.
- Contenu pédagogique original, inspiré des trois approches, sans reproduction.
- Rien n’a été exécuté ici (pas de réseau) : faites un essai complet après le déploiement.

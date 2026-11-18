# Parole — entraînement à la prise de parole

Site statique (Netlify) + Supabase (comptes, base, règles d'accès) + fonctions Netlify (coach IA, paiements).

```
index.html, app.js, config.js     → le site
vendor/supabase.js                → supabase-js 2.45.4 hébergé localement
netlify/functions/coach.mjs       → /api/coach              retour du coach IA
netlify/functions/pay.mjs         → /api/pay                création et suivi des paiements
netlify/functions/wave-webhook.mjs→ /api/webhooks/wave      confirmation Wave (signée)
netlify/functions/paytech-ipn.mjs → /api/webhooks/paytech   confirmation Orange Money (signée)
netlify/lib/common.mjs            → outils partagés
supabase/schema.sql, seed.sql,
  admin.sql                       → structure, contenu, administration (déjà appliqués sur le projet samakadu)
fonts/                            → police Bricolage Grotesque hébergée sur le site (licence OFL)
```

## Contenu
5 modules, 25 leçons : Structurer, Faire entendre, Analyser, Mises en situation, Défis chronométrés.
La première leçon de chaque module est gratuite ; les 20 autres sont Premium.

Le contenu est dans la base (tables `modules`, `lessons`, `lesson_content`). Pour ajouter un parcours (par exemple un module NECOM),
ajoutez des lignes dans Supabase > Table Editor : aucun redéploiement nécessaire. La colonne `coach_angle` d'un module dit au coach IA
ce qu'il doit évaluer ; `duration_sec` d'une leçon active le chronomètre.

## Offres et paiement
Prix dans la table `plans` (modifiables dans Supabase) : 1 mois 5 000 FCFA, 3 mois 12 000 FCFA, 12 mois 40 000 FCFA.
Paiement unique sans renouvellement ; un nouvel achat prolonge l'accès.

- **Wave** : en direct via l'API Wave Checkout.
  Dans business.wave.com > Développeurs : créez une clé API (`WAVE_API_KEY`), puis enregistrez le webhook
  `https://VOTRE-SITE/api/webhooks/wave` (événements `checkout.session.completed` et `checkout.session.payment_failed`) avec la
  méthode « signing secret » ; copiez ce secret dans `WAVE_WEBHOOK_SECRET`.
- **Orange Money** : via PayTech (paytech.sn), qui gère l'API Orange Money. Clés dans Paramètres > API.
  Commencez avec `PAYTECH_ENV=test`, puis passez à `prod` quand PayTech a activé votre compte.

Sécurité des paiements :
- le montant est toujours lu dans la base ; le navigateur n'envoie qu'un nom d'offre ;
- chaque confirmation est vérifiée par signature (HMAC-SHA256) ; Wave : refus au-delà de 5 minutes (anti-rejeu) ;
- la base revérifie le montant et ne crédite jamais deux fois la même commande ;
- seule la clé de service (côté serveur) peut valider un paiement ; aucun utilisateur ne peut s'attribuer un abonnement ;
- si la notification Wave tarde, la page de retour interroge Wave directement pour rattraper le statut.

## Déploiement
1. Supabase est déjà prêt (schéma et contenu appliqués). Vérifiez seulement :
   - Authentication > Emails > SMTP : branchez un SMTP (Brevo, Resend…), ou désactivez « Confirm email » pendant les tests ;
   - Authentication > URL Configuration : Site URL = `https://monumental-swan-0a25bf.netlify.app`, Redirect URLs = `https://monumental-swan-0a25bf.netlify.app/**` ;
   - Authentication > Providers > Email : « Leaked password protection » activée (recommandé).
2. Netlify > Environment variables : toutes celles de `.env.example`.
3. Déployez le dossier entier. Le build s'arrête si une clé secrète a été oubliée dans le code.

## Espace administrateur (#/admin)
Visible uniquement pour les comptes de la table `admins` (au départ : senobeyeshop@gmail.com).
Chiffres clés, liste des apprenants (recherche, pages de 20), dernières commandes, et un formulaire pour offrir ou retirer
le Premium (par exemple aux membres d'une promotion NECOM payée en espèces). Chaque action est journalisée dans `admin_log`.
La protection est dans la base : un non-admin qui appelle ces fonctions reçoit un refus, même en contournant l'écran.
Ajouter un administrateur : SQL Editor →
`insert into public.admins (user_id) select id from auth.users where email = 'collegue@exemple.sn';`

## Coach IA
Le retour s'affiche au fur et à mesure qu'il est rédigé (limite Netlify : 60 s par réponse).
3 retours par jour en gratuit, 15 en Premium, 300 par jour au total (plafond de dépense).

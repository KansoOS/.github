# Comment ça marche

Auto-création de PR draft dès qu'un push apporte des commits sur une branche,
et suppression automatique de la branche quand sa PR est mergée, sur tous les
repos de l'organisation KansoOS.

## Le flux

```
push avec des commits → webhook GitHub (org) → Cloudflare Worker → API GitHub → PR draft créée
PR mergée               → webhook GitHub (org) → Cloudflare Worker → API GitHub → branche supprimée
```

1. Quelqu'un push des commits sur une branche d'un repo de l'org.
2. GitHub envoie un webhook `push` au Worker (configuré au niveau de l'**organisation**, donc valable pour tous les repos, y compris futurs).
3. Le Worker vérifie que la requête vient bien de GitHub (signature HMAC).
4. Il filtre : push avec au moins un commit, pas la branche par défaut, pas une suppression. On ne se base pas sur `created` (branche neuve) car les branches sont souvent pré-créées vides par l'outil de ticketing avant le premier vrai push de code — ce flag ne serait alors jamais vrai au moment où du code arrive.
5. Il appelle l'API GitHub pour créer une **PR draft** : branche → branche par défaut. Si une PR existe déjà pour cette branche (push suivants), GitHub répond 422 et le Worker l'ignore simplement : pas de doublon.
6. Quand cette PR (ou n'importe quelle PR) est mergée, GitHub envoie un webhook `pull_request` (action `closed`, `merged: true`).
7. Le Worker vérifie que la branche head appartient au même repo (pas une fork), puis appelle l'API GitHub pour **supprimer la branche**.

## Les pièces

| Pièce | Rôle |
|---|---|
| `worker.js` | Le code qui tourne sur Cloudflare, reçoit les webhooks, crée la PR et supprime la branche au merge |
| `wrangler.toml` | Config minimale du Worker |
| `WEBHOOK_SECRET` (secret Cloudflare) | Vérifie que le webhook vient bien de GitHub |
| `GH_TOKEN` (secret Cloudflare) | Token fine-grained, scope org entière, droits PR (lecture/écriture) + contenu (lecture/écriture pour supprimer une ref) |
| Webhook GitHub (org-level) | Envoie chaque `push` et `pull_request` de chaque repo vers l'URL du Worker |

## Pourquoi ces choix

- **Cloudflare Worker** : pas de serveur à gérer, gratuit à ce volume, instantané.
- **Webhook au niveau organisation** (pas repo par repo) : une seule config, couvre tous les repos présents et futurs.
- **Secrets hors du code** : `GH_TOKEN` et `WEBHOOK_SECRET` vivent uniquement dans le stockage chiffré Cloudflare, jamais dans Git.
- **Vérification de signature** : sans elle, n'importe qui connaissant l'URL du Worker pourrait déclencher de fausses PR.

## Infos utiles

- URL du Worker : `https://auto-draft-pr.kansoos.workers.dev`
- Redéployer après une modif du code : `npx wrangler deploy`
- Voir les logs en direct : `npx wrangler tail`
- Changer un secret : `printf '%s' 'nouvelle-valeur' | npx wrangler secret put NOM_DU_SECRET`

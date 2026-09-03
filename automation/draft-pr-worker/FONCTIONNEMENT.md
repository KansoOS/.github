# Comment ça marche

Auto-création de PR draft dès qu'une nouvelle branche est poussée, sur tous les repos de l'organisation KansoOS.

## Le flux

```
push nouvelle branche → webhook GitHub (org) → Cloudflare Worker → API GitHub → PR draft créée
```

1. Quelqu'un push une nouvelle branche sur un repo de l'org.
2. GitHub envoie un webhook `push` au Worker (configuré au niveau de l'**organisation**, donc valable pour tous les repos, y compris futurs).
3. Le Worker vérifie que la requête vient bien de GitHub (signature HMAC).
4. Il filtre : nouvelle branche seulement, pas la branche par défaut, pas une suppression.
5. Il appelle l'API GitHub pour créer une **PR draft** : branche → branche par défaut.

## Les pièces

| Pièce | Rôle |
|---|---|
| `worker.js` | Le code qui tourne sur Cloudflare, reçoit le webhook et crée la PR |
| `wrangler.toml` | Config minimale du Worker |
| `WEBHOOK_SECRET` (secret Cloudflare) | Vérifie que le webhook vient bien de GitHub |
| `GH_TOKEN` (secret Cloudflare) | Token fine-grained, scope org entière, droits PR + lecture contenu |
| Webhook GitHub (org-level) | Envoie chaque `push` de chaque repo vers l'URL du Worker |

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

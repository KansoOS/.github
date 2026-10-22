# Comment ça marche

Auto-création de PR draft dès qu'un push apporte des commits sur une branche,
suppression automatique de la branche quand sa PR est mergée, et synchro du
monorepo vitrine à chaque push sur la branche par défaut d'un repo mirroré —
sur tous les repos de l'organisation KansoOS.

## Le flux

```
push avec des commits (branche non défaut) → webhook GitHub (org) → Worker → API GitHub → PR draft créée
push sur la branche par défaut (repo mirroré) → webhook GitHub (org) → Worker → API GitHub → workflow_dispatch sur KansoOS/KansoOS
PR mergée                                      → webhook GitHub (org) → Worker → API GitHub → branche supprimée
```

1. Quelqu'un push des commits sur une branche d'un repo de l'org.
2. GitHub envoie un webhook `push` au Worker (configuré au niveau de l'**organisation**, donc valable pour tous les repos, y compris futurs).
3. Le Worker vérifie que la requête vient bien de GitHub (signature HMAC).
4. Il mint un **token d'installation GitHub App** (JWT signé avec `GH_APP_PRIVATE_KEY`, échangé contre un token via l'API) — toutes les actions GitHub qui suivent s'authentifient avec ce token, pas avec un PAT personnel, pour que l'attribution des PR (et des commits en cas de squash merge) reste correcte.
5. Il filtre : push avec au moins un commit, pas une suppression.
6. **Si c'est la branche par défaut** et que le repo fait partie de `SYNCED_REPOS` (`kanso-mdm-backend`, `kanso-web-dashboard`, `kanso-infra`) : il déclenche `sync.yml` dans `KansoOS/KansoOS` via `workflow_dispatch` (API Actions), en lui passant le nom du repo. C'est ce workflow qui clone le repo et met à jour sa copie dans le monorepo (voir `KansoOS/.github/workflows/sync.yml`). Pas de PR dans ce cas : il n'y a pas de branche à merger.
7. **Sinon** (branche non par défaut) : il appelle l'API GitHub pour créer une **PR draft** : branche → branche par défaut. On ne se base pas sur `created` (branche neuve) car les branches sont souvent pré-créées vides par l'outil de ticketing avant le premier vrai push de code — ce flag ne serait alors jamais vrai au moment où du code arrive. Si une PR existe déjà pour cette branche (push suivants), GitHub répond 422 et le Worker l'ignore simplement : pas de doublon.
8. Quand une PR est mergée, GitHub envoie un webhook `pull_request` (action `closed`, `merged: true`).
9. Le Worker remint un token d'installation (étape 4), vérifie que la branche head appartient au même repo (pas une fork), puis appelle l'API GitHub pour **supprimer la branche**.

## Les pièces

| Pièce | Rôle |
|---|---|
| `worker.js` | Le code qui tourne sur Cloudflare, reçoit les webhooks, crée la PR, supprime la branche au merge, déclenche la synchro du monorepo |
| `wrangler.toml` | Config minimale du Worker |
| `WEBHOOK_SECRET` (secret Cloudflare) | Vérifie que le webhook vient bien de GitHub |
| `GH_APP_ID` / `GH_APP_PRIVATE_KEY` / `GH_APP_INSTALLATION_ID` (secrets Cloudflare) | Identité de la GitHub App : signent un JWT, échangé contre un token d'installation (droits Contents/Pull requests/Actions en lecture-écriture) à chaque requête |
| Webhook GitHub (org-level) | Envoie chaque `push` et `pull_request` de chaque repo vers l'URL du Worker |
| `KansoOS/.github/workflows/sync.yml` | Clone le repo passé en entrée et met à jour sa copie dans `KansoOS/KansoOS` (secret `SYNC_TOKEN`, un PAT classique séparé — pas de souci d'attribution ici, cf. README) |

## Pourquoi ces choix

- **Cloudflare Worker** : pas de serveur à gérer, gratuit à ce volume, instantané.
- **Webhook au niveau organisation** (pas repo par repo) : une seule config, couvre tous les repos présents et futurs.
- **GitHub App plutôt qu'un PAT personnel** : un PAT attribue chaque action (PR créée, et le commit final en cas de squash merge) au propriétaire du token, pas à qui a vraiment poussé le code. Une App a sa propre identité (`<nom>[bot]`), donc l'attribution reste correcte indépendamment de qui a configuré/redéployé le Worker.
- **Secrets hors du code** : tout vit uniquement dans le stockage chiffré Cloudflare, jamais dans Git.
- **Vérification de signature** : sans elle, n'importe qui connaissant l'URL du Worker pourrait déclencher de fausses PR.

## Infos utiles

- URL du Worker : `https://auto-draft-pr.kansoos.workers.dev`
- Redéployer après une modif du code : `npx wrangler deploy`
- Voir les logs en direct : `npx wrangler tail`
- Changer un secret : `printf '%s' 'nouvelle-valeur' | npx wrangler secret put NOM_DU_SECRET`

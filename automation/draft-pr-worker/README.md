# auto-draft-pr

Cloudflare Worker qui écoute les webhooks `push` et `pull_request` au niveau de
l'organisation GitHub. Il crée automatiquement une pull request en draft dès
qu'un push apporte des commits sur une branche (qu'elle soit neuve ou déjà
créée à l'avance, vide), supprime la branche automatiquement quand sa PR est
mergée (tous repos de l'org, présents et futurs), et déclenche la synchro du
monorepo vitrine [KansoOS/KansoOS](https://github.com/KansoOS/KansoOS) quand
c'est un push sur la branche par défaut d'un repo mirroré (`kanso-mdm-backend`,
`kanso-web-dashboard`, `kanso-infra` — liste `SYNCED_REPOS` dans `worker.js`).

## Déploiement (ce que tu dois faire)

```bash
npm install -g wrangler
wrangler login
wrangler secret put WEBHOOK_SECRET   # string random, ex: openssl rand -hex 32
wrangler secret put GH_TOKEN         # voir "Token GitHub" ci-dessous
wrangler deploy
```

`wrangler deploy` te donne une URL du type
`https://auto-draft-pr.<ton-compte>.workers.dev`.

## Token GitHub (`GH_TOKEN`)

Settings → Developer settings → Fine-grained tokens :
- Resource owner : ton organisation
- Repository access : All repositories
- Permissions : Contents = Read and write (nécessaire pour supprimer une branche), Pull requests = Read and write, **Actions = Read and write** (nécessaire pour déclencher le workflow de synchro du monorepo)

⚠️ Ce même token (valeur identique à `GH_TOKEN`) doit aussi être posé comme secret **`SYNC_TOKEN`** sur le repo `KansoOS/KansoOS` (Settings → Secrets and variables → Actions) : c'est lui qui sert à `sync.yml` pour cloner les repos sources.

## Webhook organisation

Org Settings → Webhooks → Add webhook :
- Payload URL : l'URL du Worker (ci-dessus)
- Content type : `application/json`
- Secret : la même valeur que `WEBHOOK_SECRET`
- Events : "Let me select individual events" → coche **Pushes** et **Pull requests**

Une fois branché, aucun fichier à ajouter dans les autres repos : ça marche
aussi sur les repos créés après coup, tant que le token a accès à "All
repositories".

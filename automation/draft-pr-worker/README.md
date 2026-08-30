# auto-draft-pr

Cloudflare Worker qui écoute le webhook `push` au niveau de l'organisation GitHub
et crée automatiquement une pull request en draft dès qu'une nouvelle branche
est poussée pour la première fois (tous repos de l'org, présents et futurs).

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
- Permissions : Contents = Read-only, Pull requests = Read and write

## Webhook organisation

Org Settings → Webhooks → Add webhook :
- Payload URL : l'URL du Worker (ci-dessus)
- Content type : `application/json`
- Secret : la même valeur que `WEBHOOK_SECRET`
- Events : "Let me select individual events" → coche uniquement **Pushes**

Une fois branché, aucun fichier à ajouter dans les autres repos : ça marche
aussi sur les repos créés après coup, tant que le token a accès à "All
repositories".

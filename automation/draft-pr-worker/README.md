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
wrangler secret put WEBHOOK_SECRET          # string random, ex: openssl rand -hex 32
wrangler secret put GH_APP_ID               # voir "Auth GitHub App" ci-dessous
wrangler secret put GH_APP_PRIVATE_KEY      # idem, coller le .pem en PKCS#8
wrangler secret put GH_APP_INSTALLATION_ID  # idem
wrangler deploy
```

`wrangler deploy` te donne une URL du type
`https://auto-draft-pr.<ton-compte>.workers.dev`.

## Auth GitHub App (`GH_APP_ID` / `GH_APP_PRIVATE_KEY` / `GH_APP_INSTALLATION_ID`)

Le Worker agit au nom d'une **GitHub App**, pas d'un token personnel (PAT) :
avec un PAT, GitHub attribue chaque PR créée — et, en cas de squash merge, le
commit final sur la branche par défaut — au **propriétaire du token**, pas à
qui a vraiment poussé le code. Une App a sa propre identité (`<nom>[bot]`),
donc l'attribution reste correcte quel que soit qui a configuré le Worker.

**Créer l'App** (une fois) : Org Settings → Developer settings → GitHub Apps
→ New GitHub App.
- Webhook → **décoche "Active"** (le webhook organisation ci-dessous suffit,
  l'App ne sert qu'à l'authentification)
- Permissions (Repository permissions) : **Contents** = Read and write,
  **Pull requests** = Read and write, **Actions** = Read and write
- Create → **Generate a private key** (télécharge un `.pem`, en PKCS#1) →
  note l'**App ID** affiché en haut de la page
- **Install App** → organisation → All repositories → Install → note
  l'**Installation ID** (dans l'URL de la page d'installation, ou
  `gh api /orgs/<org>/installations --jq '.installations[].id'`)

**Convertir la clé** (Web Crypto, utilisé par le Worker, n'importe que du
PKCS#8, pas le PKCS#1 téléchargé par défaut) :
```bash
openssl pkcs8 -topk8 -nocrypt -in original-key.pem -out private-key-pkcs8.pem
```
Poser le contenu de `private-key-pkcs8.pem` (en entier, avec les lignes
`BEGIN`/`END`) comme secret `GH_APP_PRIVATE_KEY`.

Le Worker mint un token d'installation à chaque requête (`getInstallationToken`
dans `worker.js`) — pas de cache, le volume ne le justifie pas.

⚠️ `sync.yml` dans `KansoOS/KansoOS` utilise encore un PAT classique
(`SYNC_TOKEN`) pour cloner les repos sources — ça ne pose pas de problème
d'attribution (c'est juste un accès en lecture pour le clone, les commits de
synchro sont déjà attribués en dur à `kanso-sync-bot` dans ce workflow), donc
pas besoin de le migrer vers l'App pour corriger ce bug précis. À faire un
jour pour réduire le nombre de secrets statiques qui traînent, si on veut.

## Webhook organisation

Org Settings → Webhooks → Add webhook :
- Payload URL : l'URL du Worker (ci-dessus)
- Content type : `application/json`
- Secret : la même valeur que `WEBHOOK_SECRET`
- Events : "Let me select individual events" → coche **Pushes** et **Pull requests**

Une fois branché, aucun fichier à ajouter dans les autres repos : ça marche
aussi sur les repos créés après coup, tant que le token a accès à "All
repositories".

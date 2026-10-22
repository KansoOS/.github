export default {
  async fetch(request, env) {
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    const rawBody = await request.text();

    const signature = request.headers.get('X-Hub-Signature-256') || '';
    const valid = await verifySignature(env.WEBHOOK_SECRET, rawBody, signature);
    if (!valid) {
      return new Response('Invalid signature', { status: 401 });
    }

    const event = request.headers.get('X-GitHub-Event');
    const payload = JSON.parse(rawBody);

    // Toutes les actions côté API GitHub (créer une PR, supprimer une
    // branche, déclencher un workflow) passent par un token d'installation
    // de GitHub App, pas par un PAT personnel : sinon GitHub attribue la PR
    // (et, en cas de squash, le commit final sur main) au propriétaire du
    // token plutôt qu'à l'auteur réel du push.
    let token;
    try {
      token = await getInstallationToken(env);
    } catch (err) {
      console.log(`Installation token error: ${err.message}`);
      return new Response('Failed to authenticate as GitHub App (see logs)', { status: 200 });
    }

    if (event === 'push') {
      return handlePush(payload, token, env);
    }

    if (event === 'pull_request') {
      return handlePullRequest(payload, token);
    }

    return new Response('Ignored (not a push or pull_request event)', { status: 200 });
  },
};

// Repos (dans l'org KansoOS) mirorés dans le monorepo vitrine KansoOS/KansoOS.
// Noms réels des repos GitHub (≠ noms des dossiers locaux de dev) :
// kanso-mdm-backend, kanso-web-dashboard, kanso-infra.
const MONOREPO_OWNER = 'KansoOS';
const MONOREPO_REPO = 'KansoOS';
const MONOREPO_SYNC_WORKFLOW = 'sync.yml';
const SYNCED_REPOS = new Set(['kanso-mdm-backend', 'kanso-web-dashboard', 'kanso-infra']);

async function handlePush(payload, token, env) {
  const isBranch = payload.ref.startsWith('refs/heads/');
  const branch = payload.ref.replace('refs/heads/', '');
  const defaultBranch = payload.repository.default_branch;
  const hasCommits = Array.isArray(payload.commits) && payload.commits.length > 0;
  const [owner, repo] = payload.repository.full_name.split('/');

  if (payload.deleted || !isBranch || !hasCommits) {
    return new Response('Skipped', { status: 200 });
  }

  // Un push sur la branche par défaut d'un repo suivi : on met à jour sa
  // copie dans le monorepo vitrine, pas de PR (il n'y a pas de branche à
  // merger ici).
  if (branch === defaultBranch) {
    if (owner === MONOREPO_OWNER && SYNCED_REPOS.has(repo)) {
      await triggerMonorepoSync(repo, token, env);
    }
    return new Response('Default branch push handled', { status: 200 });
  }

  // Les branches sont souvent créées à l'avance (vides, calées sur la branche
  // par défaut) par l'outil de ticketing, avant le premier vrai push de code.
  // Dans ce cas `payload.created` n'est vrai qu'au moment de cette création
  // vide, pas quand du code arrive vraiment. On déclenche donc sur le premier
  // push qui apporte des commits, que la branche soit neuve ou non : si une PR
  // existe déjà pour cette branche, l'API GitHub répond 422 et c'est ignoré
  // plus bas, donc pas de doublon.
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'auto-draft-pr-worker',
    },
    body: JSON.stringify({
      title: branch,
      head: branch,
      base: defaultBranch,
      draft: true,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.log(`PR creation skipped for ${owner}/${repo}#${branch}: ${res.status} ${err}`);
    return new Response('PR not created (see logs)', { status: 200 });
  }

  const pr = await res.json();
  return new Response(`Draft PR created: ${pr.html_url}`, { status: 200 });
}

// Déclenche le workflow de synchro dans KansoOS/KansoOS (via workflow_dispatch) :
// c'est lui qui clone `repo`@defaultBranch et met à jour sa copie dans le monorepo.
async function triggerMonorepoSync(repo, token, env) {
  const res = await fetch(
    `https://api.github.com/repos/${MONOREPO_OWNER}/${MONOREPO_REPO}/actions/workflows/${MONOREPO_SYNC_WORKFLOW}/dispatches`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'auto-draft-pr-worker',
      },
      body: JSON.stringify({ ref: 'main', inputs: { repo } }),
    }
  );

  if (!res.ok) {
    const err = await res.text();
    console.log(`Monorepo sync dispatch failed for ${repo}: ${res.status} ${err}`);
  }
}

async function handlePullRequest(payload, token) {
  const pr = payload.pull_request;

  const isSameRepo = pr.head.repo && pr.head.repo.full_name === pr.base.repo.full_name;

  if (payload.action !== 'closed' || !pr.merged || !isSameRepo) {
    return new Response('Skipped', { status: 200 });
  }

  const branch = pr.head.ref;
  const [owner, repo] = payload.repository.full_name.split('/');

  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`,
    {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'auto-draft-pr-worker',
      },
    }
  );

  if (!res.ok) {
    const err = await res.text();
    console.log(`Branch deletion skipped for ${owner}/${repo}#${branch}: ${res.status} ${err}`);
    return new Response('Branch not deleted (see logs)', { status: 200 });
  }

  return new Response(`Branch deleted: ${owner}/${repo}#${branch}`, { status: 200 });
}

// --- Auth GitHub App : un token d'installation frais à chaque requête -----
// (le volume est faible, pas besoin de le mettre en cache ; un Worker ne
// garantit de toute façon pas la persistance d'un cache entre deux requêtes).

async function getInstallationToken(env) {
  const jwt = await buildAppJwt(env.GH_APP_ID, env.GH_APP_PRIVATE_KEY);

  const res = await fetch(
    `https://api.github.com/app/installations/${env.GH_APP_INSTALLATION_ID}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'auto-draft-pr-worker',
      },
    }
  );

  if (!res.ok) {
    throw new Error(`${res.status} ${await res.text()}`);
  }

  const { token } = await res.json();
  return token;
}

async function buildAppJwt(appId, privateKeyPem) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  // iat décalé d'1 min en arrière pour tolérer le clock drift ; exp à 9 min
  // (max autorisé par GitHub : 10 min).
  const payload = { iat: now - 60, exp: now + 9 * 60, iss: appId };

  const unsigned = `${base64url(json(header))}.${base64url(json(payload))}`;
  const key = await importPrivateKey(privateKeyPem);
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(unsigned)
  );
  return `${unsigned}.${base64url(new Uint8Array(signature))}`;
}

// Nécessite une clé au format PKCS#8 (`-----BEGIN PRIVATE KEY-----`), pas le
// PKCS#1 (`-----BEGIN RSA PRIVATE KEY-----`) téléchargé par défaut par
// GitHub : la convertir une fois avec
//   openssl pkcs8 -topk8 -nocrypt -in original.pem -out pkcs8.pem
// (Web Crypto, utilisé ici, n'importe que du PKCS#8.)
async function importPrivateKey(pem) {
  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s+/g, '');
  const binary = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    'pkcs8',
    binary,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
}

function json(obj) {
  return new TextEncoder().encode(JSON.stringify(obj));
}

function base64url(bytes) {
  const str = btoa(String.fromCharCode(...bytes));
  return str.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function verifySignature(secret, body, signatureHeader) {
  if (!signatureHeader.startsWith('sha256=')) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  const expected =
    'sha256=' + [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return timingSafeEqual(expected, signatureHeader);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}

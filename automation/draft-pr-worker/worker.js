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

    if (event === 'push') {
      return handlePush(payload, env);
    }

    if (event === 'pull_request') {
      return handlePullRequest(payload, env);
    }

    return new Response('Ignored (not a push or pull_request event)', { status: 200 });
  },
};

// Repos (dans l'org KansoOS) mirorés dans le monorepo vitrine KansoOS/KansoOS.
const MONOREPO_OWNER = 'KansoOS';
const MONOREPO_REPO = 'KansoOS';
const MONOREPO_SYNC_WORKFLOW = 'sync.yml';
const SYNCED_REPOS = new Set(['backend-mdm', 'dashboard-web', 'infra']);

async function handlePush(payload, env) {
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
      await triggerMonorepoSync(repo, env);
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
      Authorization: `Bearer ${env.GH_TOKEN}`,
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
async function triggerMonorepoSync(repo, env) {
  const res = await fetch(
    `https://api.github.com/repos/${MONOREPO_OWNER}/${MONOREPO_REPO}/actions/workflows/${MONOREPO_SYNC_WORKFLOW}/dispatches`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.GH_TOKEN}`,
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

async function handlePullRequest(payload, env) {
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
        Authorization: `Bearer ${env.GH_TOKEN}`,
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

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
    if (event !== 'push') {
      return new Response('Ignored (not a push event)', { status: 200 });
    }

    const payload = JSON.parse(rawBody);

    const isBranch = payload.ref.startsWith('refs/heads/');
    const branch = payload.ref.replace('refs/heads/', '');
    const defaultBranch = payload.repository.default_branch;

    if (!payload.created || payload.deleted || !isBranch || branch === defaultBranch) {
      return new Response('Skipped', { status: 200 });
    }

    const [owner, repo] = payload.repository.full_name.split('/');

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
  },
};

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

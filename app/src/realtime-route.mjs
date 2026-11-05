// Arena uses both legacy UUIDs and runner-qualified IDs in realtime URLs.
export function realtimeRoute(value) {
  try {
    const url = new URL(value);
    if (url.origin !== 'https://arena.ai') return null;
    const m = url.pathname.match(/^\/ai-proxy\/realtime\/v1\/sessions\/([^/]+)\/(out|in\/append)$/);
    if (!m) return null;
    const key = decodeURIComponent(m[1]);
    const id = key.replace(/^agent-runner:/, '');
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) return null;
    return { id, key, endpoint: m[2] };
  } catch { return null; }
}
export function matchesRealtime(value, id, endpoint) {
  const route = realtimeRoute(value);
  return Boolean(route && route.id === id && route.endpoint === endpoint);
}
export function trackRealtime(page) {
  if (page.__bridgeRealtime || typeof page.on !== 'function') return;
  page.__bridgeRealtime = new Map();
  page.on('request', request => {
    const route = realtimeRoute(request.url());
    if (!route || route.endpoint !== 'out') return;
    const auth = request.headers().authorization || '';
    if (!/^Bearer /i.test(auth)) return;
    if (page.__bridgeRealtime.size >= 32) page.__bridgeRealtime.delete(page.__bridgeRealtime.keys().next().value);
    page.__bridgeRealtime.set(route.id, { key: route.key, token: auth.replace(/^Bearer /i, '') });
  });
}

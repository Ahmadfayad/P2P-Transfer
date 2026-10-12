// Pilot credentials are supplied privately as a Worker secret, never committed.
// Use an expiring Open Relay credential and a provider account with no paid upgrade.
export function turnPilot(env, now = Date.now()) {
  try {
    const config = JSON.parse(env.TURN_PILOT_CONFIG || "null");
    const expires = Date.parse(config?.expiresAt);
    if (!Number.isFinite(expires) || expires <= now || expires > now + 86400000)
      return null;
    const maxBytes = config.maxBytes ?? 256 * 1024 * 1024;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1024 ** 3)
      return null;
    const servers = config.iceServers;
    if (!Array.isArray(servers) || !servers.length || servers.length > 4)
      return null;
    const iceServers = servers.map((s) => {
      const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
      if (!urls.length || urls.length > 4 || urls.some((url) =>
        typeof url !== "string" ||
        !/^turns?:standard\.relay\.metered\.ca:(80|443)(\?transport=(tcp|udp))?$/.test(url)) ||
        typeof s.username !== "string" || !s.username || s.username.length > 256 ||
        typeof s.credential !== "string" || !s.credential || s.credential.length > 256)
        throw new Error("Invalid pilot configuration");
      return { urls, username: s.username, credential: s.credential };
    });
    return { iceServers, expires, maxBytes };
  } catch { return null; }
}

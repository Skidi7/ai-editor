import { execFileSync } from 'node:child_process';
import { Agent, ProxyAgent, setGlobalDispatcher } from 'undici';

/**
 * Outbound networking for the server's own requests (WaveSpeed, result downloads).
 *  - Default: direct connections with a generous connect timeout (30 s) because the API sometimes answers slowly.
 *  - HTTPS_PROXY / HTTP_PROXY: route everything through that proxy.
 *  - USE_SYSTEM_PROXY=true (Windows): use the proxy enabled in Internet Settings, e.g. a local VPN client.
 */

function windowsSystemProxy(): string | null {
  if (process.platform !== 'win32') return null;
  try {
    const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
    const out = execFileSync('reg', ['query', key], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    const enabled = /ProxyEnable\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(out);
    const server = /ProxyServer\s+REG_SZ\s+(\S+)/i.exec(out);
    if (!enabled || parseInt(enabled[1], 16) !== 1 || !server) return null;
    let s = server[1];
    if (s.includes('=')) {
      const parts = Object.fromEntries(s.split(';').map((p) => p.split('=') as [string, string]));
      s = parts.https || parts.http || '';
    }
    if (!s) return null;
    return /^https?:\/\//.test(s) ? s : `http://${s}`;
  } catch {
    return null;
  }
}

export function configureNetwork(): string | null {
  const connectTimeout = Number(process.env.CONNECT_TIMEOUT_MS) || 30000;
  const explicit = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  const useSystem = (process.env.USE_SYSTEM_PROXY || 'false').toLowerCase() === 'true';
  const url = explicit || (useSystem ? windowsSystemProxy() : null);
  try {
    if (url) {
      setGlobalDispatcher(new ProxyAgent({ uri: url, connectTimeout }));
      console.log(`[net] outbound requests go through proxy ${url}${explicit ? '' : ' (Windows system proxy)'}`);
      return url;
    }
    setGlobalDispatcher(new Agent({ connectTimeout }));
    return null;
  } catch (e) {
    console.warn(`[net] could not configure networking: ${(e as Error).message}`);
    return null;
  }
}

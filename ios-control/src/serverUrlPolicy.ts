const HTTPS_DEFAULT_PORT = 443;

export const DEFAULT_BRIDGE_ORIGIN = 'https://xiaoli.136-110-78-96.sslip.io';

export interface ServerUrlPolicy {
  readonly host: string;
  readonly effectivePort: number;
  readonly origin: string;
  readonly dashboardUrl: string;
  isAllowedNavigation(candidate: string): boolean;
}

function invalidAddress(): Error {
  return new Error('A valid HTTPS Bridge address is required');
}

function parseHttpsUrl(input: string): URL {
  const trimmed = input?.trim();
  if (!trimmed || !/^https:\/\//i.test(trimmed)) {
    throw invalidAddress();
  }

  const authority = trimmed.slice(trimmed.indexOf('//') + 2).split(/[/?#]/, 1)[0];
  if (
    !authority ||
    authority.endsWith(':') ||
    authority.includes('@') ||
    /[\\\u0000-\u001f\u007f]/.test(trimmed)
  ) {
    throw invalidAddress();
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw invalidAddress();
  }

  const port = url.port ? Number(url.port) : HTTPS_DEFAULT_PORT;
  if (
    url.protocol !== 'https:' ||
    !url.hostname ||
    url.username !== '' ||
    url.password !== '' ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    url.origin === 'null'
  ) {
    throw invalidAddress();
  }

  return url;
}

export function createServerUrlPolicy(input: string): ServerUrlPolicy {
  const url = parseHttpsUrl(input);
  const host = url.hostname.toLowerCase();
  const effectivePort = url.port ? Number(url.port) : HTTPS_DEFAULT_PORT;
  const origin = `https://${host}${effectivePort === HTTPS_DEFAULT_PORT ? '' : `:${effectivePort}`}`;

  return Object.freeze({
    host,
    effectivePort,
    origin,
    dashboardUrl: `${origin}/mobile/`,
    isAllowedNavigation(candidate: string): boolean {
      try {
        const candidateUrl = parseHttpsUrl(candidate);
        const candidatePort = candidateUrl.port ? Number(candidateUrl.port) : HTTPS_DEFAULT_PORT;
        return candidateUrl.hostname.toLowerCase() === host && candidatePort === effectivePort;
      } catch {
        return false;
      }
    },
  });
}

export function isApkDownload(candidate: string): boolean {
  try {
    return /\.apk$/i.test(new URL(candidate).pathname);
  } catch {
    return false;
  }
}

import fs from 'node:fs/promises';
import path from 'node:path';
import {pipeline} from 'node:stream/promises';

const CSP = "default-src 'self'; base-uri 'none'; connect-src 'self'; font-src 'self'; " +
  "form-action 'none'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; " +
  "script-src 'self'; style-src 'self'";
const MAX_STATIC_BYTES = 2 * 1024 * 1024;
const MAX_APK_BYTES = 32 * 1024 * 1024;

export function createMobileHandler({api, publicDir, apkPath, fileSystem = fs} = {}) {
  if (!api || typeof api.handle !== 'function') {
    throw new TypeError('mobile handler requires an API');
  }
  if (typeof publicDir !== 'string' || publicDir.trim() === '') {
    throw new TypeError('mobile handler publicDir must be a non-empty string');
  }
  if (typeof apkPath !== 'string' || apkPath.trim() === '') {
    throw new TypeError('mobile handler apkPath must be a non-empty string');
  }
  for (const method of ['lstat', 'open', 'readFile']) {
    if (typeof fileSystem?.[method] !== 'function') {
      throw new TypeError(`mobile handler fileSystem must provide ${method}()`);
    }
  }

  const root = path.resolve(publicDir);
  const routes = new Map([
    ['/mobile/', {
      file: path.join(root, 'index.html'), type: 'text/html; charset=utf-8', maxBytes: MAX_STATIC_BYTES
    }],
    ['/mobile/styles.css', {
      file: path.join(root, 'styles.css'), type: 'text/css; charset=utf-8', maxBytes: MAX_STATIC_BYTES
    }],
    ['/mobile/app.js', {
      file: path.join(root, 'app.js'), type: 'text/javascript; charset=utf-8', maxBytes: MAX_STATIC_BYTES
    }],
    ['/downloads/xiaoli-control.apk', {
      file: path.resolve(apkPath), type: 'application/vnd.android.package-archive',
      maxBytes: MAX_APK_BYTES, download: 'xiaoli-control.apk'
    }]
  ]);

  return async function handleMobileRequest(request, response) {
    if (await api.handle(request, response)) return true;
    const pathname = parsePathname(request.url);
    if (pathname === '/mobile') {
      if (!['GET', 'HEAD'].includes(request.method)) {
        sendEmpty(response, 405, {'allow': 'GET, HEAD'});
      } else {
        sendEmpty(response, 308, {'location': '/mobile/'});
      }
      return true;
    }
    const route = routes.get(pathname);
    if (!route) return false;
    if (!['GET', 'HEAD'].includes(request.method)) {
      sendEmpty(response, 405, {'allow': 'GET, HEAD'});
      return true;
    }

    let stat;
    try {
      stat = await fileSystem.lstat(route.file);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        sendEmpty(response, 404);
        return true;
      }
      throw error;
    }
    if (!isAllowedFile(stat, route.maxBytes)) {
      sendEmpty(response, 404);
      return true;
    }
    if (route.download) {
      await streamDownload({request, response, route, beforeOpen: stat, fileSystem});
      return true;
    }
    const data = await fileSystem.readFile(route.file);
    if (data.length !== stat.size || data.length > route.maxBytes) {
      sendEmpty(response, 404);
      return true;
    }
    const headers = {
      ...securityHeaders(),
      'content-type': route.type,
      'content-length': data.length
    };
    response.writeHead(200, headers);
    response.end(request.method === 'HEAD' ? undefined : data);
    return true;
  };
}

async function streamDownload({request, response, route, beforeOpen, fileSystem}) {
  let handle;
  let stream;
  try {
    handle = await fileSystem.open(route.file, 'r');
    if (!handle || typeof handle.stat !== 'function' ||
        typeof handle.createReadStream !== 'function' || typeof handle.close !== 'function') {
      throw new TypeError('mobile handler fileSystem.open() must return a file handle');
    }
    const openedStat = await handle.stat();
    if (!isAllowedFile(openedStat, route.maxBytes) || !sameFileIdentity(beforeOpen, openedStat)) {
      sendEmpty(response, 404);
      return;
    }

    const headers = {
      ...securityHeaders(),
      'content-type': route.type,
      'content-length': openedStat.size,
      'content-disposition': `attachment; filename="${route.download}"`
    };
    if (request.method === 'HEAD' || openedStat.size === 0) {
      response.writeHead(200, headers);
      response.end();
      return;
    }

    stream = handle.createReadStream({
      autoClose: false,
      start: 0,
      end: openedStat.size - 1
    });
    response.writeHead(200, headers);
    try {
      await pipeline(stream, response);
    } catch (error) {
      if (!response.destroyed) throw error;
    }
  } catch (error) {
    if (!response.headersSent && isMissingFileError(error)) {
      sendEmpty(response, 404);
      return;
    }
    throw error;
  } finally {
    stream?.destroy();
    if (handle) await handle.close();
  }
}

function isAllowedFile(stat, maxBytes) {
  return Boolean(stat) &&
    typeof stat.isFile === 'function' && stat.isFile() &&
    (typeof stat.isSymbolicLink !== 'function' || !stat.isSymbolicLink()) &&
    Number.isSafeInteger(stat.size) && stat.size >= 0 && stat.size <= maxBytes;
}

function sameFileIdentity(beforeOpen, opened) {
  for (const field of ['dev', 'ino']) {
    if (beforeOpen?.[field] !== undefined && opened?.[field] !== undefined &&
        beforeOpen[field] !== opened[field]) {
      return false;
    }
  }
  return true;
}

function isMissingFileError(error) {
  return ['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error?.code);
}

function parsePathname(rawUrl) {
  try {
    return new URL(rawUrl, 'http://127.0.0.1').pathname;
  } catch {
    return '';
  }
}

function securityHeaders() {
  return {
    'cache-control': 'no-store',
    'content-security-policy': CSP,
    'cross-origin-opener-policy': 'same-origin',
    'permissions-policy': 'camera=(), geolocation=(), microphone=()',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY'
  };
}

function sendEmpty(response, status, extraHeaders = {}) {
  response.writeHead(status, {
    ...securityHeaders(),
    'content-length': 0,
    ...extraHeaders
  });
  response.end();
}

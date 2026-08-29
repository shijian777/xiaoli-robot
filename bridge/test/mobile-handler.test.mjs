import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import * as fs from 'node:fs/promises';
import {createServer, request as httpRequest} from 'node:http';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

let handlerModule;
try {
  handlerModule = await import('../src/mobile/mobile-handler.mjs');
} catch {
  handlerModule = {};
}

async function fixture(run) {
  const root = await mkdtemp(path.join(tmpdir(), 'xiaoli-mobile-handler-'));
  const publicDir = path.join(root, 'mobile');
  const apkPath = path.join(root, 'xiaoli-control.apk');
  await mkdir(publicDir);
  await writeFile(path.join(publicDir, 'index.html'), '<!doctype html><title>小理</title>');
  await writeFile(path.join(publicDir, 'styles.css'), 'body{}');
  await writeFile(path.join(publicDir, 'app.js'), 'globalThis.ready=true;');
  await writeFile(apkPath, Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  try {
    await run({publicDir, apkPath});
  } finally {
    await rm(root, {recursive: true, force: true});
  }
}

async function withHandler(options, run) {
  assert.equal(typeof handlerModule.createMobileHandler, 'function',
    'createMobileHandler must be implemented');
  const handler = handlerModule.createMobileHandler(options);
  const server = createServer((request, response) => {
    Promise.resolve(handler(request, response)).then((handled) => {
      if (!handled && !response.writableEnded) {
        response.writeHead(404);
        response.end('outer 404');
      }
    }).catch(() => {
      if (!response.writableEnded) {
        response.writeHead(500);
        response.end('internal');
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await run(server.address().port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function waitFor(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return true;
}

test('mobile handler delegates the protected API and serves only explicit static routes', async () => {
  await fixture(async ({publicDir, apkPath}) => {
    const api = {
      async handle(request, response) {
        if (request.url !== '/api/mobile/v1/status') return false;
        response.writeHead(200, {'content-type': 'application/json'});
        response.end('{"ok":true}');
        return true;
      }
    };
    await withHandler({api, publicDir, apkPath}, async (port) => {
      const delegated = await fetch(`http://127.0.0.1:${port}/api/mobile/v1/status`);
      assert.equal(delegated.status, 200);
      assert.deepEqual(await delegated.json(), {ok: true});

      const page = await fetch(`http://127.0.0.1:${port}/mobile/`);
      assert.equal(page.status, 200);
      assert.match(page.headers.get('content-type'), /^text\/html/);
      assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
      assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
      assert.match(await page.text(), /小理/);

      for (const [route, type] of [
        ['/mobile/styles.css', 'text/css'],
        ['/mobile/app.js', 'text/javascript'],
        ['/downloads/xiaoli-control.apk', 'application/vnd.android.package-archive']
      ]) {
        const response = await fetch(`http://127.0.0.1:${port}${route}`);
        assert.equal(response.status, 200);
        assert.match(response.headers.get('content-type'), new RegExp(`^${type.replace('/', '\\/')}`));
      }
    });
  });
});

test('APK download streams without reading the complete package into memory', async () => {
  await fixture(async ({publicDir, apkPath}) => {
    const fileSystem = {
      lstat: fs.lstat,
      open: fs.open,
      async readFile(candidate, ...args) {
        if (path.resolve(candidate) === path.resolve(apkPath)) {
          throw new Error('APK must not use readFile');
        }
        return fs.readFile(candidate, ...args);
      }
    };
    await withHandler({
      api: {handle: async () => false}, publicDir, apkPath, fileSystem
    }, async (port) => {
      const response = await fetch(`http://127.0.0.1:${port}/downloads/xiaoli-control.apk`);
      assert.equal(response.status, 200);
      assert.deepEqual(
        Buffer.from(await response.arrayBuffer()),
        Buffer.from([0x50, 0x4b, 0x03, 0x04])
      );
    });
  });
});

test('APK download validates the opened file and closes rejected handles', async () => {
  await fixture(async ({publicDir, apkPath}) => {
    const before = await fs.lstat(apkPath);
    const cases = [
      {
        name: 'non-regular file',
        stat: {...before, isFile: () => false, isSymbolicLink: () => false}
      },
      {
        name: 'file larger than 32 MiB',
        stat: {
          ...before,
          size: (32 * 1024 * 1024) + 1,
          isFile: () => true,
          isSymbolicLink: () => false
        }
      }
    ];

    for (const scenario of cases) {
      let closed = false;
      const fileSystem = {
        lstat: fs.lstat,
        readFile: fs.readFile,
        async open() {
          return {
            stat: async () => scenario.stat,
            createReadStream() {
              throw new Error('rejected APK must not be streamed');
            },
            async close() {
              closed = true;
            }
          };
        }
      };
      await withHandler({
        api: {handle: async () => false}, publicDir, apkPath, fileSystem
      }, async (port) => {
        const response = await fetch(`http://127.0.0.1:${port}/downloads/xiaoli-control.apk`);
        assert.equal(response.status, 404, scenario.name);
      });
      assert.equal(closed, true, `${scenario.name} handle must be closed`);
    }
  });
});

test('aborting an APK download destroys the stream and closes its handle', async () => {
  await fixture(async ({publicDir, apkPath}) => {
    await writeFile(apkPath, Buffer.alloc(4 * 1024 * 1024, 0x5a));
    let handleClosed = false;
    let openedStream;
    const fileSystem = {
      lstat: fs.lstat,
      readFile: fs.readFile,
      async open(candidate, flags) {
        const handle = await fs.open(candidate, flags);
        return {
          stat: (...args) => handle.stat(...args),
          createReadStream(options) {
            openedStream = handle.createReadStream({...options, highWaterMark: 1024});
            return openedStream;
          },
          async close() {
            handleClosed = true;
            await handle.close();
          }
        };
      }
    };

    await withHandler({
      api: {handle: async () => false}, publicDir, apkPath, fileSystem
    }, async (port) => {
      await new Promise((resolve, reject) => {
        const request = httpRequest({
          hostname: '127.0.0.1', port, path: '/downloads/xiaoli-control.apk', method: 'GET'
        }, (response) => {
          response.once('data', () => {
            response.destroy();
            request.destroy();
            resolve();
          });
          response.once('error', reject);
        });
        request.once('error', reject);
        request.end();
      });

      assert.equal(
        await waitFor(() => handleClosed && openedStream?.destroyed),
        true,
        'aborted download must promptly release its file stream and handle'
      );
    });
  });
});

test('mobile handler redirects the directory, supports HEAD and rejects unsafe methods', async () => {
  await fixture(async ({publicDir, apkPath}) => {
    await withHandler({api: {handle: async () => false}, publicDir, apkPath}, async (port) => {
      const redirect = await fetch(`http://127.0.0.1:${port}/mobile`, {redirect: 'manual'});
      assert.equal(redirect.status, 308);
      assert.equal(redirect.headers.get('location'), '/mobile/');

      const head = await fetch(`http://127.0.0.1:${port}/mobile/app.js`, {method: 'HEAD'});
      assert.equal(head.status, 200);
      assert.ok(Number(head.headers.get('content-length')) > 0);
      assert.equal(await head.text(), '');

      const post = await fetch(`http://127.0.0.1:${port}/mobile/`, {method: 'POST'});
      assert.equal(post.status, 405);
      assert.equal(post.headers.get('allow'), 'GET, HEAD');
    });
  });
});

test('mobile handler declines traversal and unrelated paths without filesystem lookup', async () => {
  await fixture(async ({publicDir, apkPath}) => {
    await withHandler({api: {handle: async () => false}, publicDir, apkPath}, async (port) => {
      for (const route of ['/unrelated', '/mobile/../secret', '/mobile/%2e%2e/secret', '/downloads/other.apk']) {
        const response = await fetch(`http://127.0.0.1:${port}${route}`);
        assert.equal(response.status, 404);
        assert.equal(await response.text(), 'outer 404');
      }
    });
  });
});

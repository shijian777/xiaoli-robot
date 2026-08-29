import test from 'node:test';
import assert from 'node:assert/strict';
import {readTurnEvents} from '../src/agent-stack/ndjson.mjs';

const LIMIT_ERROR = 'Agent Stack turn stream exceeded safety limits';

async function collectEvents(stream) {
  const events = [];
  for await (const event of readTurnEvents(stream)) events.push(event);
  return events;
}

function openDelayedCloseStream(chunk) {
  let cancelled = false;
  let closeTimer;
  return {
    stream: new ReadableStream({
      start(controller) {
        controller.enqueue(chunk);
        closeTimer = setTimeout(() => controller.close(), 20);
      },
      cancel() {
        clearTimeout(closeTimer);
        cancelled = true;
      }
    }),
    wasCancelled() {
      return cancelled;
    }
  };
}

function closedStream(chunk) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(chunk);
      controller.close();
    }
  });
}

test('reads fragmented NDJSON events, skips heartbeat lines, and accepts a final unterminated line', async () => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of [
        '{"event":"assistant_',
        'message","payload":{"text":"first"}}\n\n {\"event\":\"turn_',
        'started\",\"payload\":{}}\n{"event":"turn_finished","payload":{"status":"succeeded"}}'
      ]) controller.enqueue(encoder.encode(chunk));
      controller.close();
    }
  });

  const events = [];
  for await (const event of readTurnEvents(stream)) events.push(event);

  assert.deepEqual(events, [
    {event: 'assistant_message', payload: {text: 'first'}},
    {event: 'turn_started', payload: {}},
    {event: 'turn_finished', payload: {status: 'succeeded'}}
  ]);
});

test('preserves a UTF-8 code point split across network chunks', async () => {
  const encoder = new TextEncoder();
  const prefix = encoder.encode('{"event":"assistant_message","payload":{"text":"');
  const bytes = encoder.encode('{"event":"assistant_message","payload":{"text":"小理"}}\n');
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.subarray(0, prefix.byteLength + 1));
      controller.enqueue(bytes.subarray(prefix.byteLength + 1));
      controller.close();
    }
  });

  assert.deepEqual(await collectEvents(stream), [
    {event: 'assistant_message', payload: {text: '小理'}}
  ]);
});

test('rejects malformed UTF-8 without silently replacing Agent text', async () => {
  const prefix = new TextEncoder().encode('{"event":"assistant_message","payload":{"text":"');
  const suffix = new TextEncoder().encode('"}}\n');
  const bytes = new Uint8Array(prefix.byteLength + 2 + suffix.byteLength);
  bytes.set(prefix, 0);
  bytes.set([0xc3, 0x28], prefix.byteLength);
  bytes.set(suffix, prefix.byteLength + 2);
  const source = openDelayedCloseStream(bytes);

  await assert.rejects(() => collectEvents(source.stream), {
    message: 'Malformed UTF-8 in NDJSON turn stream'
  });
  assert.equal(source.wasCancelled(), true);
});

test('replaces malformed NDJSON parse details with a static error', async () => {
  const credential = 'uak-in-malformed-ndjson';
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`{"token":"${credential}"\n`));
      controller.close();
    }
  });

  await assert.rejects(async () => {
    for await (const _event of readTurnEvents(stream));
  }, (error) => {
    assert.equal(error.message, 'Malformed NDJSON turn event');
    assert.doesNotMatch(error.message, new RegExp(credential));
    return true;
  });
});

test('accepts one valid NDJSON event whose line is exactly 64 KiB', async () => {
  const prefix = '{"event":"assistant_message","payload":{"text":"';
  const suffix = '"}}';
  const padding = 'x'.repeat(64 * 1024 - prefix.length - suffix.length);
  const events = await collectEvents(closedStream(new TextEncoder().encode(`${prefix}${padding}${suffix}`)));

  assert.equal(events.length, 1);
  assert.equal(events[0].payload.text.length, padding.length);
});

test('accepts exactly 512 non-empty NDJSON events', async () => {
  const line = '{"event":"tick","payload":{}}\n';
  const events = await collectEvents(closedStream(new TextEncoder().encode(line.repeat(512))));

  assert.equal(events.length, 512);
});

test('accepts exactly 1 MiB of cumulative NDJSON heartbeat bytes', async () => {
  const heartbeat = `${' '.repeat(64 * 1024 - 1)}\n`;
  const events = await collectEvents(closedStream(new TextEncoder().encode(heartbeat.repeat(16))));

  assert.deepEqual(events, []);
});

test('rejects and cancels an NDJSON stream whose current line exceeds 64 KiB', async () => {
  const secretFragment = 'private-upstream-content';
  const source = openDelayedCloseStream(
    new TextEncoder().encode(`${secretFragment}${'x'.repeat(64 * 1024)}`)
  );

  await assert.rejects(() => collectEvents(source.stream), (error) => {
    assert.equal(error.message, LIMIT_ERROR);
    assert.doesNotMatch(error.message, new RegExp(secretFragment));
    return true;
  });
  assert.equal(source.wasCancelled(), true);
});

test('rejects an NDJSON turn after 512 non-empty events', async () => {
  const line = '{"event":"tick","payload":{}}\n';
  const source = openDelayedCloseStream(new TextEncoder().encode(line.repeat(513)));

  await assert.rejects(() => collectEvents(source.stream), {message: LIMIT_ERROR});
  assert.equal(source.wasCancelled(), true);
});

test('rejects an NDJSON turn after 1 MiB of cumulative response bytes', async () => {
  const line = `${JSON.stringify({event: 'trace', payload: {text: 'x'.repeat(4_000)}})}\n`;
  const source = openDelayedCloseStream(new TextEncoder().encode(line.repeat(300)));

  await assert.rejects(() => collectEvents(source.stream), {message: LIMIT_ERROR});
  assert.equal(source.wasCancelled(), true);
});

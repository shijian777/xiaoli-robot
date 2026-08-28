import test from 'node:test';
import assert from 'node:assert/strict';
import {readTurnEvents} from '../src/agent-stack/ndjson.mjs';

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

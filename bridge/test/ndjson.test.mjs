import test from 'node:test';
import assert from 'node:assert/strict';
import {readTurnEvents} from '../src/agent-stack/ndjson.mjs';

test('reads fragmented NDJSON events, skips heartbeat lines, and accepts a final unterminated line', async () => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of [
        '{"type":"assistant_',
        'message","message":"first"}\n\n {\"type\":\"turn_',
        'started\"}\n{"type":"turn_finished","status":"succeeded"}'
      ]) controller.enqueue(encoder.encode(chunk));
      controller.close();
    }
  });

  const events = [];
  for await (const event of readTurnEvents(stream)) events.push(event);

  assert.deepEqual(events, [
    {type: 'assistant_message', message: 'first'},
    {type: 'turn_started'},
    {type: 'turn_finished', status: 'succeeded'}
  ]);
});

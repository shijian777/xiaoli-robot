/**
 * Decode newline-delimited JSON from a streaming response without assuming
 * that network chunks end on record boundaries.
 * @param {ReadableStream<Uint8Array>} readable
 * @returns {AsyncGenerator<object>}
 */
export async function* readTurnEvents(readable) {
  const decoder = new TextDecoder();
  let pending = '';

  for await (const chunk of readable) {
    pending += decoder.decode(chunk, {stream: true});
    const lines = pending.split(/\r?\n/);
    pending = lines.pop();
    for (const line of lines) {
      if (line.trim() !== '') yield parseEvent(line);
    }
  }

  pending += decoder.decode();
  if (pending.trim() !== '') yield parseEvent(pending);
}

function parseEvent(line) {
  try {
    return JSON.parse(line);
  } catch {
    throw new Error('Malformed NDJSON turn event');
  }
}

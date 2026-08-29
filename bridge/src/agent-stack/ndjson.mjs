// Normal Agent Stack turns are a few KiB and dozens of events. These caps
// leave generous trace/tool-event headroom while deterministically bounding
// both the parser's pending line and the client's retained event list.
const MAX_LINE_BYTES = 64 * 1024;
const MAX_TURN_EVENTS = 512;
const MAX_STREAM_BYTES = 1024 * 1024;
const LIMIT_ERROR_MESSAGE = 'Agent Stack turn stream exceeded safety limits';

/**
 * Decode newline-delimited JSON from a streaming response without assuming
 * that network chunks end on record boundaries.
 * @param {ReadableStream<Uint8Array>} readable
 * @returns {AsyncGenerator<object>}
 */
export async function* readTurnEvents(readable) {
  const decoder = new TextDecoder('utf-8', {fatal: true});
  let pendingChunks = [];
  let pendingBytes = 0;
  let totalBytes = 0;
  let eventCount = 0;

  for await (const chunk of readable) {
    totalBytes += chunk.byteLength;
    if (totalBytes > MAX_STREAM_BYTES) throw limitError();

    let offset = 0;
    while (offset < chunk.byteLength) {
      const newline = chunk.indexOf(0x0a, offset);
      const end = newline === -1 ? chunk.byteLength : newline;
      const fragment = chunk.subarray(offset, end);
      pendingBytes += fragment.byteLength;
      if (pendingBytes > MAX_LINE_BYTES) throw limitError();
      if (fragment.byteLength > 0) pendingChunks.push(fragment);

      if (newline === -1) break;
      const line = decodeLine(decoder, pendingChunks, pendingBytes);
      pendingChunks = [];
      pendingBytes = 0;
      if (line.trim() !== '') {
        eventCount += 1;
        if (eventCount > MAX_TURN_EVENTS) throw limitError();
        yield parseEvent(line);
      }
      offset = newline + 1;
    }
  }

  if (pendingBytes > 0) {
    const line = decodeLine(decoder, pendingChunks, pendingBytes);
    if (line.trim() !== '') {
      eventCount += 1;
      if (eventCount > MAX_TURN_EVENTS) throw limitError();
      yield parseEvent(line);
    }
  }
}

function decodeLine(decoder, chunks, byteLength) {
  try {
    if (chunks.length === 1) return decoder.decode(chunks[0]);
    const line = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
      line.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return decoder.decode(line);
  } catch {
    throw new Error('Malformed UTF-8 in NDJSON turn stream');
  }
}

function limitError() {
  return new Error(LIMIT_ERROR_MESSAGE);
}

function parseEvent(line) {
  try {
    return JSON.parse(line);
  } catch {
    throw new Error('Malformed NDJSON turn event');
  }
}

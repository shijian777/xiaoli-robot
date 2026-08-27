const MAGIC_0 = 0x58;
const MAGIC_1 = 0x4c;
export const VERSION = 1;
export const HEADER_BYTES = 8;
export const MAX_PAYLOAD_BYTES = 0xffff;

export const FrameKind = Object.freeze({
  CONTROL: 1,
  STREAM_START: 2,
  STREAM_CHUNK: 3,
  STREAM_END: 4
});

function assertIntegerInRange(name, value, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer from ${min} to ${max}`);
  }
}

function assertKind(kind) {
  if (!Number.isInteger(kind) || kind < FrameKind.CONTROL || kind > FrameKind.STREAM_END) {
    throw new RangeError('kind must be one of the supported frame kinds');
  }
}

/**
 * Encode a frame using the fixed XL v1 envelope.
 * @param {{kind:number,streamType:number,flags:number,sequence:number,payload:Buffer|Uint8Array}} frame
 * @returns {Buffer}
 */
export function encodeBinaryFrame({kind, streamType, flags, sequence, payload}) {
  assertKind(kind);
  assertIntegerInRange('streamType', streamType, 0, 4);
  assertIntegerInRange('flags', flags, 0, 0xff);
  assertIntegerInRange('sequence', sequence, 0, 0xffff);
  if (!Buffer.isBuffer(payload) && !(payload instanceof Uint8Array)) {
    throw new TypeError('payload must be a Buffer or Uint8Array');
  }
  if (payload.byteLength > MAX_PAYLOAD_BYTES) {
    throw new RangeError(`payload must be at most ${MAX_PAYLOAD_BYTES} bytes`);
  }

  const body = Buffer.from(payload);
  const output = Buffer.allocUnsafe(HEADER_BYTES + body.length);
  output[0] = MAGIC_0;
  output[1] = MAGIC_1;
  output[2] = VERSION;
  output[3] = kind;
  output[4] = streamType;
  output[5] = flags;
  output.writeUInt16LE(sequence, 6);
  body.copy(output, HEADER_BYTES);
  return output;
}

/**
 * Decode and validate an XL v1 frame.
 * @param {Buffer|Uint8Array} input
 * @returns {{version:number,kind:number,streamType:number,flags:number,sequence:number,payload:Buffer}}
 */
export function decodeBinaryFrame(input) {
  if (!Buffer.isBuffer(input) && !(input instanceof Uint8Array)) {
    throw new TypeError('frame must be a Buffer or Uint8Array');
  }
  const buffer = Buffer.from(input);
  if (buffer.length < HEADER_BYTES) {
    throw new RangeError(`frame is shorter than the ${HEADER_BYTES}-byte header`);
  }
  if (buffer[0] !== MAGIC_0 || buffer[1] !== MAGIC_1) {
    throw new Error('invalid frame magic');
  }
  if (buffer[2] !== VERSION) {
    throw new Error(`unsupported frame version ${buffer[2]}`);
  }
  const kind = buffer[3];
  assertKind(kind);
  const streamType = buffer[4];
  assertIntegerInRange('streamType', streamType, 0, 4);
  const flags = buffer[5];
  const sequence = buffer.readUInt16LE(6);
  const payload = buffer.subarray(HEADER_BYTES);
  if (payload.length > MAX_PAYLOAD_BYTES) {
    throw new RangeError(`payload must be at most ${MAX_PAYLOAD_BYTES} bytes`);
  }
  return {version: VERSION, kind, streamType, flags, sequence, payload};
}

export const MAX_PROTOCOL_IDENTIFIER_BYTES = 71;

const PRINTABLE_ASCII_IDENTIFIER = /^[\x21-\x7e]+$/;

export function isProtocolIdentifier(value) {
  return typeof value === 'string' &&
    value.length <= MAX_PROTOCOL_IDENTIFIER_BYTES &&
    PRINTABLE_ASCII_IDENTIFIER.test(value);
}

export function assertProtocolIdentifier(value, name = 'identifier') {
  if (!isProtocolIdentifier(value)) {
    throw new TypeError(`${name} must be a non-empty printable ASCII identifier of at most ${MAX_PROTOCOL_IDENTIFIER_BYTES} bytes`);
  }
}

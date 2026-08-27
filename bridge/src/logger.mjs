const SECRET_KEY = /key|token|password|authorization|uak/i;
const REDACTED = '[REDACTED]';

function redact(value, seen = new WeakMap(), redactStrings = false) {
  if (typeof value === 'string') return redactStrings ? REDACTED : value;

  if (Array.isArray(value)) {
    if (seen.has(value)) return seen.get(value);
    const result = [];
    seen.set(value, result);
    for (const item of value) result.push(redact(item, seen, redactStrings));
    return result;
  }

  if (value && typeof value === 'object') {
    if (seen.has(value)) return seen.get(value);
    const result = {};
    seen.set(value, result);
    for (const [key, item] of Object.entries(value)) {
      result[key] = SECRET_KEY.test(key) ? REDACTED : redact(item, seen);
    }
    return result;
  }

  return value;
}

function defaultSink(entry) {
  const line = JSON.stringify(entry);
  if (entry.level === 'error') console.error(line);
  else if (entry.level === 'warn') console.warn(line);
  else console.log(line);
}

/**
 * Create a small structured logger. Every value passed to a log method is
 * recursively copied and secret-shaped object keys are replaced before the
 * sink sees it. The sink receives one `{level, args}` entry per call.
 */
export function createLogger(sink = defaultSink) {
  if (typeof sink !== 'function') {
    throw new TypeError('logger sink must be a function');
  }

  const write = (level, args) => sink({
    level,
    args: args.map((value) => redact(value, new WeakMap(), typeof value === 'string'))
  });
  return {
    info: (...args) => write('info', args),
    warn: (...args) => write('warn', args),
    error: (...args) => write('error', args)
  };
}

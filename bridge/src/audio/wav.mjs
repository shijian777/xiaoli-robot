export const APPROVED_PCM_FORMAT = Object.freeze({
  sampleRate: 16000,
  bits: 16,
  channels: 1
});

const RIFF_HEADER_BYTES = 44;
const PCM_FORMAT_CODE = 1;

export function pcmToWav(pcm, audio) {
  assertPcmBuffer(pcm);
  assertApprovedPcmFormat(audio);

  if (pcm.length > 0xffffffff - 36) {
    throw new RangeError('PCM is too large for a WAV container');
  }

  const wav = Buffer.alloc(RIFF_HEADER_BYTES + pcm.length);
  wav.write('RIFF', 0, 4, 'ascii');
  wav.writeUInt32LE(36 + pcm.length, 4);
  wav.write('WAVE', 8, 4, 'ascii');
  wav.write('fmt ', 12, 4, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(PCM_FORMAT_CODE, 20);
  wav.writeUInt16LE(APPROVED_PCM_FORMAT.channels, 22);
  wav.writeUInt32LE(APPROVED_PCM_FORMAT.sampleRate, 24);
  wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(APPROVED_PCM_FORMAT.bits, 34);
  wav.write('data', 36, 4, 'ascii');
  wav.writeUInt32LE(pcm.length, 40);
  pcm.copy(wav, RIFF_HEADER_BYTES);
  return wav;
}

export function parsePcmWav(wav) {
  if (!Buffer.isBuffer(wav)) {
    throw new TypeError('WAV must be a Buffer');
  }
  if (wav.length < 12 || wav.subarray(0, 4).toString('ascii') !== 'RIFF' || wav.subarray(8, 12).toString('ascii') !== 'WAVE') {
    throw new Error('invalid RIFF/WAVE header');
  }
  if (wav.readUInt32LE(4) !== wav.length - 8) {
    throw new Error('invalid RIFF size');
  }

  let audio;
  let pcm;
  let offset = 12;
  while (offset < wav.length) {
    if (offset + 8 > wav.length) {
      throw new Error('truncated WAV chunk header');
    }
    const id = wav.subarray(offset, offset + 4).toString('ascii');
    const size = wav.readUInt32LE(offset + 4);
    const dataOffset = offset + 8;
    const paddedSize = size + (size % 2);
    if (dataOffset + paddedSize > wav.length) {
      throw new Error(`truncated WAV ${id} chunk`);
    }

    if (id === 'fmt ') {
      if (audio) {
        throw new Error('duplicate WAV fmt chunk');
      }
      if (size !== 16) {
        throw new Error('unsupported WAV fmt chunk');
      }
      const formatCode = wav.readUInt16LE(dataOffset);
      audio = {
        channels: wav.readUInt16LE(dataOffset + 2),
        sampleRate: wav.readUInt32LE(dataOffset + 4),
        byteRate: wav.readUInt32LE(dataOffset + 8),
        blockAlign: wav.readUInt16LE(dataOffset + 12),
        bits: wav.readUInt16LE(dataOffset + 14)
      };
      if (formatCode !== PCM_FORMAT_CODE) {
        throw new Error('unsupported WAV PCM format');
      }
      assertApprovedPcmFormat(audio);
      if (audio.byteRate !== 32000 || audio.blockAlign !== 2) {
        throw new Error('unsupported WAV PCM format');
      }
    } else if (id === 'data') {
      if (pcm) {
        throw new Error('duplicate WAV data chunk');
      }
      pcm = Buffer.from(wav.subarray(dataOffset, dataOffset + size));
      assertPcmBuffer(pcm);
    }

    offset = dataOffset + paddedSize;
  }

  if (!audio || !pcm) {
    throw new Error('WAV must contain fmt and data chunks');
  }
  return {
    pcm,
    sampleRate: audio.sampleRate,
    bits: audio.bits,
    channels: audio.channels
  };
}

export function assertApprovedPcmFormat(audio) {
  if (!audio || typeof audio !== 'object' ||
      audio.sampleRate !== APPROVED_PCM_FORMAT.sampleRate ||
      audio.bits !== APPROVED_PCM_FORMAT.bits ||
      audio.channels !== APPROVED_PCM_FORMAT.channels) {
    throw new RangeError('audio format must be 16000 Hz, 16-bit mono PCM');
  }
}

function assertPcmBuffer(pcm) {
  if (!Buffer.isBuffer(pcm)) {
    throw new TypeError('PCM must be a Buffer');
  }
  if (pcm.length % 2 !== 0) {
    throw new RangeError('PCM byte length must be even for 16-bit audio');
  }
}

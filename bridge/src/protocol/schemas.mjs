import Ajv from 'ajv';
import {MAX_PROTOCOL_IDENTIFIER_BYTES} from './limits.mjs';

const nonEmptyString = {type: 'string', minLength: 1, pattern: '\\S'};
const identifier = {
  type: 'string',
  minLength: 1,
  maxLength: MAX_PROTOCOL_IDENTIFIER_BYTES,
  pattern: '^[!-~]+$'
};
const credential = {...nonEmptyString, maxLength: 512};

const common = {
  v: {const: 1},
  messageId: identifier
};

export const MAX_SPOKEN_TEXT_CHARACTERS = 100;

const deviceMessageSchemas = [
  {
    type: 'object',
    properties: {
      ...common,
      type: {const: 'hello'},
      deviceId: identifier,
      firmwareVersion: identifier,
      token: credential,
      capabilities: {anyOf: [{type: 'array'}, {type: 'object'}]}
    },
    required: ['v', 'type', 'messageId', 'deviceId', 'firmwareVersion', 'token', 'capabilities'],
    additionalProperties: false
  },
  {
    type: 'object',
    properties: {
      ...common,
      type: {const: 'case.start'},
      caseId: identifier
    },
    required: ['v', 'type', 'messageId', 'caseId'],
    additionalProperties: false
  },
  {
    type: 'object',
    properties: {
      ...common,
      type: {const: 'speech.start'},
      caseId: identifier,
      segmentId: identifier,
      speaker: {enum: ['A', 'B']},
      audio: {
        type: 'object',
        properties: {
          sampleRate: {const: 16000},
          bits: {const: 16},
          channels: {const: 1}
        },
        required: ['sampleRate', 'bits', 'channels'],
        additionalProperties: false
      }
    },
    required: ['v', 'type', 'messageId', 'caseId', 'segmentId', 'speaker', 'audio'],
    additionalProperties: false
  },
  {
    type: 'object',
    properties: {
      ...common,
      type: {const: 'speech.end'},
      caseId: identifier,
      segmentId: identifier,
      bytes: {type: 'integer', minimum: 0, maximum: 0xffffffff},
      lastSequence: {type: 'integer', minimum: 0, maximum: 0xffff},
      complete: {type: 'boolean'}
    },
    required: ['v', 'type', 'messageId', 'caseId', 'segmentId', 'bytes', 'lastSequence', 'complete'],
    additionalProperties: false
  },
  {
    type: 'object',
    properties: {
      ...common,
      type: {const: 'mediate.request'},
      caseId: identifier
    },
    required: ['v', 'type', 'messageId', 'caseId'],
    additionalProperties: false
  },
  {
    type: 'object',
    properties: {
      ...common,
      type: {const: 'audio.played'},
      caseId: identifier,
      mediationMessageId: identifier
    },
    required: ['v', 'type', 'messageId', 'caseId', 'mediationMessageId'],
    additionalProperties: false
  }
];

export const deviceMessageSchema = {
  oneOf: deviceMessageSchemas
};

export const mediatorResultSchema = {
  type: 'object',
  properties: {
    conflictSummary: nonEmptyString,
    aPosition: nonEmptyString,
    bPosition: nonEmptyString,
    aCanImprove: nonEmptyString,
    bCanImprove: nonEmptyString,
    commonGround: nonEmptyString,
    suggestions: {
      type: 'array',
      minItems: 1,
      items: nonEmptyString
    },
    spokenText: {...nonEmptyString, maxLength: MAX_SPOKEN_TEXT_CHARACTERS}
  },
  required: [
    'conflictSummary',
    'aPosition',
    'bPosition',
    'aCanImprove',
    'bCanImprove',
    'commonGround',
    'suggestions',
    'spokenText'
  ],
  additionalProperties: false
};

const ajv = new Ajv({allErrors: true, strict: true});
export const validateDeviceMessage = ajv.compile(deviceMessageSchema);
export const validateMediatorResult = ajv.compile(mediatorResultSchema);

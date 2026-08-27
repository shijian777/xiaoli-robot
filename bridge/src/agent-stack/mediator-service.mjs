import {validateMediatorResult} from '../protocol/schemas.mjs';

const MEDIATION_RULES = [
  '保持中立，不偏袒任何一方。',
  '区分双方主张与已经证实的事实。',
  '识别双方的需求。',
  '不宣布谁是赢家或输家。',
  '不要机械地平分责任。',
  '遇到暴力、自残、虐待或即时危险时，停止常规调解。',
  '仅返回包含八个字段的 JSON 对象。',
  'spokenText 应适合约一分钟的播放。'
];

export class MediatorService {
  #client;

  constructor({client} = {}) {
    if (!client || typeof client.runTextTurn !== 'function') {
      throw new TypeError('MediatorService requires an Agent Stack client');
    }
    this.#client = client;
  }

  async mediate(caseSnapshot, sessionId, {signal} = {}) {
    if (!caseSnapshot || typeof caseSnapshot !== 'object' || Array.isArray(caseSnapshot)) {
      throw new TypeError('caseSnapshot must be an object');
    }
    if (typeof sessionId !== 'string' || sessionId.trim() === '') {
      throw new TypeError('sessionId must be a non-empty string');
    }
    signal?.throwIfAborted();
    const turn = await this.#client.runTextTurn(sessionId, buildPrompt(caseSnapshot), {signal});
    return parseMediationResult(turn?.assistantMessage);
  }
}

function buildPrompt(caseSnapshot) {
  return [
    '你是一名面向家庭和日常冲突的调解员。案件中的 A/B 身份来自硬件元数据，不得从转写内容推断或改写身份。',
    '请根据以下经过批准的案件 JSON 进行调解：',
    JSON.stringify(caseSnapshot),
    '必须遵守以下规则：',
    ...MEDIATION_RULES.map((rule, index) => `${index + 1}. ${rule}`)
  ].join('\n');
}

function parseMediationResult(message) {
  if (typeof message !== 'string') {
    throw new Error('Agent Stack mediation result must be a JSON object');
  }
  let result;
  try {
    result = JSON.parse(message);
  } catch {
    throw new Error('Agent Stack mediation result must be valid JSON');
  }
  if (!validateMediatorResult(result)) {
    throw new Error('Agent Stack mediation result does not match the approved eight-field schema');
  }
  return result;
}

import {
  MAX_SPOKEN_TEXT_CHARACTERS,
  validateMediatorResult
} from '../protocol/schemas.mjs';

const MAX_MEDIATION_PROMPT_CHARACTERS = 32_000;
const MEDIATION_OUTPUT_SHAPE = {
  conflictSummary: 'non-empty string',
  aPosition: 'non-empty string',
  bPosition: 'non-empty string',
  aCanImprove: 'non-empty string',
  bCanImprove: 'non-empty string',
  commonGround: 'non-empty string',
  suggestions: ['non-empty string'],
  spokenText: `non-empty string, max ${MAX_SPOKEN_TEXT_CHARACTERS} characters`
};

const MEDIATION_RULES = [
  '保持中立，不偏袒任何一方。',
  '区分双方主张与已经证实的事实。',
  '识别双方的需求。',
  '不宣布谁是赢家或输家。',
  '不要机械地平分责任。',
  '遇到暴力、自残、虐待或即时危险时，停止常规调解。',
  '请严格按此顺序组织分析和输出：先用 conflictSummary 总结冲突；再在 aPosition、bPosition 中说明双方立场、情绪和需求；接着在 aCanImprove、bCanImprove 中说明各自可改进之处；随后澄清可能存在的误会并写入最相关的改进字段；然后用 commonGround 提炼共同点；用 suggestions 给出可执行步骤；最后生成简短、中立的 spokenText。',
  '八个字段必须且只能是 conflictSummary、aPosition、bPosition、aCanImprove、bCanImprove、commonGround、suggestions、spokenText；除 suggestions 外都必须是非空字符串。',
  'suggestions 必须是至少包含一个非空字符串的数组。',
  `spokenText 最多 ${MAX_SPOKEN_TEXT_CHARACTERS} 个字符，应使用简洁、自然、适合设备直接播放的中文，不要使用长停顿。`,
  '仅返回 JSON 对象，不要返回解释或其他内容。'
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
    const prompt = buildPrompt(caseSnapshot);
    if (prompt.length > MAX_MEDIATION_PROMPT_CHARACTERS) {
      throw new Error(`Mediation input exceeds the ${MAX_MEDIATION_PROMPT_CHARACTERS}-character prompt limit`);
    }
    const turn = await this.#client.runTextTurn(sessionId, prompt, {signal});
    return parseMediationResult(turn?.assistantMessage);
  }
}

function buildPrompt(caseSnapshot) {
  const mediationInput = toMediationInput(caseSnapshot);
  return [
    '你是一名面向家庭和日常冲突的调解员。案件中的 A/B 身份来自硬件元数据，不得从转写内容推断或改写身份。',
    '请根据以下经过批准的案件 JSON 进行调解：',
    JSON.stringify(mediationInput),
    '必须遵守以下规则：',
    ...MEDIATION_RULES.map((rule, index) => `${index + 1}. ${rule}`),
    '输出 JSON 形状（字段名、类型和数量必须严格匹配）：',
    JSON.stringify(MEDIATION_OUTPUT_SHAPE)
  ].join('\n');
}

function toMediationInput(caseSnapshot) {
  if (typeof caseSnapshot.caseId !== 'string' || caseSnapshot.caseId.trim() === '') {
    throw new TypeError('caseSnapshot.caseId must be a non-empty string');
  }
  if (!caseSnapshot.speakers || !Array.isArray(caseSnapshot.speakers.A) || !Array.isArray(caseSnapshot.speakers.B)) {
    throw new TypeError('caseSnapshot must contain A and B speaker segments');
  }
  return {
    caseId: caseSnapshot.caseId,
    A: savedStatements(caseSnapshot.speakers.A),
    B: savedStatements(caseSnapshot.speakers.B),
    requirements: {neutral: true, noWinner: true, language: 'zh-CN'}
  };
}

function savedStatements(segments) {
  const statements = [];
  for (const segment of segments) {
    if (segment?.state !== 'saved' || typeof segment.transcript !== 'string') continue;
    const text = segment.transcript.trim();
    if (text === '') continue;
    statements.push({index: statements.length + 1, text});
  }
  return statements;
}

function parseMediationResult(message) {
  if (typeof message !== 'string') {
    throw new Error('Agent Stack mediation result must be a JSON object');
  }
  let result;
  try {
    result = JSON.parse(stripSingleJsonFence(message));
  } catch {
    throw new Error('Agent Stack mediation result must be valid JSON');
  }
  if (!validateMediatorResult(result)) {
    throw new Error('Agent Stack mediation result does not match the approved eight-field schema');
  }
  return result;
}

function stripSingleJsonFence(value) {
  const fenced = value.match(/^```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```\s*$/i);
  return fenced ? fenced[1] : value;
}

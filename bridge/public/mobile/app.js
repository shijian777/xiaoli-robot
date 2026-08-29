'use strict';

const TOKEN_STORAGE_KEY = 'xiaoli.mobile.admin-token';
const POLL_DELAY_MS = 2_000;
const MAX_DISPLAY_TEXT = 20_000;
const ERROR_MESSAGES = Object.freeze({
  unauthorized: '管理员令牌无效，请重新输入。',
  device_not_found: '没有找到这台设备。',
  device_offline: '设备当前离线，暂时不能调解。',
  mediation_not_ready: '双方陈述尚未准备完成。',
  mediation_request_failed: '调解请求失败，请稍后再试。',
  invalid_voice_settings: '声音参数不正确，请检查后重试。',
  voice_settings_unavailable: '当前语音服务不支持在线调节音色。',
  voice_settings_failed: '声音设置保存失败，请稍后再试。',
  network_error: '无法连接服务器，请检查网络。',
  invalid_response: '服务器返回了无法识别的数据。',
  request_failed: '请求未完成，请稍后再试。'
});

const ui = {};
let activeToken = '';
let pollTimer = null;
let pollInFlight = false;
let windowFocused = true;
let sessionEpoch = 0;

document.addEventListener('DOMContentLoaded', initialize);

function initialize() {
  for (const id of [
    'token-panel', 'token-form', 'admin-token', 'token-error', 'dashboard',
    'refresh-button', 'reconfigure-button', 'clear-token-button', 'server-status',
    'server-time', 'device-count', 'device-list', 'empty-devices', 'voice-form',
    'voice', 'speed', 'speed-output', 'volume', 'volume-output', 'pitch',
    'pitch-output', 'voice-message', 'save-voice-button', 'activity-status'
  ]) {
    ui[id] = document.getElementById(id);
  }

  ui['token-form'].addEventListener('submit', connectWithToken);
  ui['clear-token-button'].addEventListener('click', forgetToken);
  ui['reconfigure-button'].addEventListener('click', forgetToken);
  ui['refresh-button'].addEventListener('click', refreshNow);
  ui['voice-form'].addEventListener('submit', saveVoiceSettings);

  for (const name of ['speed', 'volume', 'pitch']) {
    ui[name].addEventListener('input', () => updateRangeOutput(name));
    updateRangeOutput(name);
  }

  document.addEventListener('visibilitychange', handleVisibilityChange);
  window.addEventListener('blur', handleWindowBlur);
  window.addEventListener('focus', handleWindowFocus);

  activeToken = readStoredToken();
  if (activeToken) {
    showDashboard();
    void openSession();
  } else {
    showTokenPanel();
  }
}

async function connectWithToken(event) {
  event.preventDefault();
  const token = ui['admin-token'].value.trim();
  setMessage(ui['token-error'], '');
  if (!token) {
    setMessage(ui['token-error'], '请输入管理员令牌。', 'error');
    ui['admin-token'].focus();
    return;
  }

  storeToken(token);
  ui['admin-token'].value = '';
  showDashboard();
  await openSession();
}

async function openSession() {
  const epoch = ++sessionEpoch;
  setActivity('正在连接服务器…');
  try {
    await Promise.all([loadStatus(epoch), loadVoiceSettings(epoch)]);
    if (epoch !== sessionEpoch) return;
    setActivity('已连接，状态会自动刷新。');
    schedulePoll();
  } catch (error) {
    handleRequestError(error, epoch);
  }
}

async function refreshNow() {
  if (pollInFlight) return;
  stopPolling();
  pollInFlight = true;
  ui['refresh-button'].disabled = true;
  const epoch = sessionEpoch;
  try {
    await Promise.all([loadStatus(epoch), loadVoiceSettings(epoch)]);
    setActivity('状态已刷新。');
  } catch (error) {
    handleRequestError(error, epoch);
  } finally {
    pollInFlight = false;
    ui['refresh-button'].disabled = false;
    schedulePoll();
  }
}

async function loadStatus(epoch) {
  const snapshot = await apiRequest('/api/mobile/v1/status');
  if (epoch !== sessionEpoch) return;
  renderStatus(snapshot);
}

async function loadVoiceSettings(epoch) {
  const settings = await apiRequest('/api/mobile/v1/voice');
  if (epoch !== sessionEpoch) return;
  renderVoiceSettings(settings);
}

function renderStatus(snapshot) {
  if (!isRecord(snapshot) || !Array.isArray(snapshot.devices)) {
    throw new ApiError('invalid_response');
  }

  setText(ui['server-status'], '运行正常');
  setText(ui['server-time'], formatServerTime(snapshot.serverTime));
  const devices = snapshot.devices.filter(isRecord);
  const onlineCount = devices.filter((device) => device.online === true).length;
  setText(ui['device-count'], `${onlineCount} / ${devices.length}`);

  ui['device-list'].replaceChildren();
  ui['empty-devices'].hidden = devices.length !== 0;
  for (const device of devices) {
    ui['device-list'].append(createDeviceCard(device));
  }
}

function createDeviceCard(device) {
  const article = element('article', 'device-card');
  article.setAttribute('role', 'listitem');

  const header = element('div', 'device-header');
  const title = element('h3');
  const deviceId = safeText(device.deviceId, 128) || '未命名设备';
  setText(title, deviceId);
  const badge = element('span', 'badge');
  badge.dataset.online = device.online === true ? 'true' : 'false';
  setText(badge, device.online === true ? '在线' : '离线');
  header.append(title, badge);

  const caseData = isRecord(device.case) ? device.case : {};
  const metadata = element('dl', 'case-meta');
  appendMetadata(metadata, '案件', safeText(caseData.caseId ?? device.currentCaseId, 128) || '尚未创建');
  appendMetadata(metadata, '阶段', phaseLabel(device.state ?? caseData.state ?? caseData.phase));

  const speakers = isRecord(caseData.speakers) ? caseData.speakers : {};
  const speakerGrid = element('div', 'speaker-grid');
  speakerGrid.append(
    createSpeakerCard('A', collectTranscript(speakers.A)),
    createSpeakerCard('B', collectTranscript(speakers.B))
  );

  const actionRow = element('div', 'device-action-row');
  const hint = element('p', 'device-hint');
  const canMediate = device.online === true && caseData.canMediate === true && Boolean(device.deviceId);
  setText(hint, mediationHint(device, caseData));
  const button = element('button', 'button button-primary');
  button.type = 'button';
  button.disabled = !canMediate;
  setText(button, '启动调解');
  button.addEventListener('click', () => requestMediation(deviceId, button));
  actionRow.append(hint, button);

  article.append(header, metadata, speakerGrid, actionRow);
  return article;
}

function appendMetadata(list, term, description) {
  const wrapper = element('div');
  const dt = element('dt');
  const dd = element('dd');
  setText(dt, term);
  setText(dd, description);
  wrapper.append(dt, dd);
  list.append(wrapper);
}

function createSpeakerCard(speaker, transcript) {
  const section = element('section', 'speaker-card');
  section.dataset.speaker = speaker;
  const heading = element('h4');
  setText(heading, `${speaker} 方累计陈述`);
  const body = element('p', 'transcript');
  setText(body, transcript || '暂无陈述');
  section.append(heading, body);
  return section;
}

function collectTranscript(value) {
  if (typeof value === 'string') return safeText(value);
  if (!Array.isArray(value)) return '';
  return safeText(value.map((segment) => {
    if (typeof segment === 'string') return segment;
    if (!isRecord(segment)) return '';
    return typeof segment.transcript === 'string' ? segment.transcript : '';
  }).filter(Boolean).join('\n\n'));
}

async function requestMediation(deviceId, button) {
  if (!window.confirm(`确认让小理开始分析设备“${safeText(deviceId, 128)}”的当前案件吗？`)) return;
  button.disabled = true;
  setActivity('调解请求正在提交…');
  const epoch = sessionEpoch;
  try {
    await apiRequest(`/api/mobile/v1/devices/${encodeURIComponent(deviceId)}/mediate`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: '{}'
    });
    setActivity('调解请求已提交，设备将播放处理结果。');
    await loadStatus(epoch);
  } catch (error) {
    button.disabled = false;
    handleRequestError(error, epoch);
  }
}

function renderVoiceSettings(settings) {
  if (isRecord(settings) && settings.available === false) {
    setVoiceBusy(true);
    setMessage(ui['voice-message'], ERROR_MESSAGES.voice_settings_unavailable, 'error');
    return;
  }
  if (!validVoiceSettings(settings)) throw new ApiError('invalid_response');
  setVoiceBusy(false);
  ui.voice.value = settings.voice;
  for (const name of ['speed', 'volume', 'pitch']) {
    ui[name].value = String(settings[name]);
    updateRangeOutput(name);
  }
}

async function saveVoiceSettings(event) {
  event.preventDefault();
  const settings = {
    voice: ui.voice.value.trim(),
    speed: Number(ui.speed.value),
    volume: Number(ui.volume.value),
    pitch: Number(ui.pitch.value)
  };
  setMessage(ui['voice-message'], '');
  if (!validVoiceSettings(settings)) {
    setMessage(ui['voice-message'], ERROR_MESSAGES.invalid_voice_settings, 'error');
    return;
  }

  setVoiceBusy(true);
  try {
    const saved = await apiRequest('/api/mobile/v1/voice', {
      method: 'PUT',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(settings)
    });
    renderVoiceSettings(saved);
    setMessage(ui['voice-message'], '声音设置已保存。');
  } catch (error) {
    if (error?.code === 'unauthorized') {
      handleRequestError(error, sessionEpoch);
    } else {
      setMessage(ui['voice-message'], friendlyError(error), 'error');
    }
  } finally {
    setVoiceBusy(false);
  }
}

async function apiRequest(path, options = {}) {
  const token = activeToken || readStoredToken();
  if (!token) throw new ApiError('unauthorized');
  let response;
  try {
    response = await fetch(path, {
      ...options,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        ...options.headers,
        Authorization: `Bearer ${token}`
      }
    });
  } catch {
    throw new ApiError('network_error');
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    if (response.ok) throw new ApiError('invalid_response');
  }
  if (!response.ok) {
    const code = isRecord(payload) && typeof payload.error === 'string' && ERROR_MESSAGES[payload.error]
      ? payload.error
      : response.status === 401 ? 'unauthorized' : 'request_failed';
    throw new ApiError(code);
  }
  if (!isRecord(payload)) throw new ApiError('invalid_response');
  return payload;
}

function runPoll() {
  pollTimer = null;
  if (pollInFlight || shouldPausePolling() || !activeToken) return;
  pollInFlight = true;
  const epoch = sessionEpoch;
  loadStatus(epoch).catch((error) => {
    handleRequestError(error, epoch, true);
  }).finally(() => {
    pollInFlight = false;
    schedulePoll();
  });
}

function schedulePoll() {
  stopPolling();
  if (shouldPausePolling() || !activeToken) return;
  pollTimer = window.setTimeout(runPoll, POLL_DELAY_MS);
}

function stopPolling() {
  if (pollTimer !== null) {
    window.clearTimeout(pollTimer);
    pollTimer = null;
  }
}

function shouldPausePolling() {
  return document.hidden || !windowFocused;
}

function handleVisibilityChange() {
  if (document.hidden) stopPolling();
  else schedulePoll();
}

function handleWindowBlur() {
  windowFocused = false;
  stopPolling();
}

function handleWindowFocus() {
  windowFocused = true;
  schedulePoll();
}

function handleRequestError(error, epoch, quiet = false) {
  if (epoch !== sessionEpoch) return;
  if (error?.code === 'unauthorized') {
    clearStoredToken();
    showTokenPanel();
    setMessage(ui['token-error'], ERROR_MESSAGES.unauthorized, 'error');
    return;
  }
  setText(ui['server-status'], '连接异常');
  if (!quiet || ui['activity-status'].dataset.kind !== 'error') {
    setActivity(friendlyError(error), 'error');
  }
}

function showDashboard() {
  ui['token-panel'].hidden = true;
  ui.dashboard.hidden = false;
  ui['reconfigure-button'].hidden = false;
}

function showTokenPanel() {
  ++sessionEpoch;
  stopPolling();
  ui.dashboard.hidden = true;
  ui['reconfigure-button'].hidden = true;
  ui['token-panel'].hidden = false;
  ui['device-list'].replaceChildren();
  ui['empty-devices'].hidden = true;
  setText(ui['device-count'], '0');
  setText(ui['server-status'], '未连接');
  setText(ui['server-time'], '—');
  setActivity('');
  ui['admin-token'].focus();
}

function forgetToken() {
  clearStoredToken();
  ui['admin-token'].value = '';
  setMessage(ui['token-error'], '本机令牌已清除。');
  showTokenPanel();
}

function readStoredToken() {
  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY)?.trim() ?? '';
  } catch {
    return '';
  }
}

function storeToken(token) {
  activeToken = token;
  try {
    localStorage.setItem(TOKEN_STORAGE_KEY, token);
  } catch {
    setActivity('浏览器无法持久保存令牌，本次打开期间仍可使用。', 'error');
  }
}

function clearStoredToken() {
  activeToken = '';
  try {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    // Private-mode storage can be unavailable; the in-memory copy is already cleared.
  }
}

function updateRangeOutput(name) {
  setText(ui[`${name}-output`], ui[name].value);
}

function setVoiceBusy(busy) {
  ui['save-voice-button'].disabled = busy;
  for (const name of ['voice', 'speed', 'volume', 'pitch']) ui[name].disabled = busy;
}

function setActivity(message, kind = '') {
  setMessage(ui['activity-status'], message, kind);
}

function setMessage(target, message, kind = '') {
  setText(target, message);
  if (kind) target.dataset.kind = kind;
  else delete target.dataset.kind;
}

function setText(target, value) {
  target.textContent = safeText(value);
}

function safeText(value, limit = MAX_DISPLAY_TEXT) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

function formatServerTime(value) {
  if (typeof value !== 'string') return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('zh-CN', {hour12: false});
}

function phaseLabel(value) {
  const labels = {
    idle: '等待新案件',
    waiting: '等待发言',
    recording_a: 'A 方发言中',
    recording_b: 'B 方发言中',
    mediation_queued: '调解请求已排队',
    mediating: '小理调解中',
    playing: '播放调解结果',
    awaiting_playback: '等待设备确认播放',
    mediation_failed: '调解失败，可重新提交',
    error: '需要检查'
  };
  return labels[value] ?? (safeText(value, 80) || '未知');
}

function mediationHint(device, caseData) {
  if (device.online !== true) return '设备离线后不能发起调解';
  if (caseData.canMediate !== true) return '等待 A、B 双方完成陈述';
  return '双方陈述已就绪';
}

function validVoiceSettings(value) {
  if (!isRecord(value) || typeof value.voice !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value.voice)) return false;
  return ['speed', 'volume', 'pitch'].every((name) => Number.isInteger(value[name]) && value[name] >= 0 && value[name] <= 100);
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function element(tagName, className = '') {
  const node = document.createElement(tagName);
  if (className) node.className = className;
  return node;
}

function friendlyError(error) {
  return ERROR_MESSAGES[error?.code] ?? ERROR_MESSAGES.request_failed;
}

class ApiError extends Error {
  constructor(code) {
    super('Mobile request failed');
    this.name = 'ApiError';
    this.code = code;
  }
}

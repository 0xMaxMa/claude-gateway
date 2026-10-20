import { validateBrowserIntegration } from './browser-connector';
import { isReservedJevCredentialEnv, jevCredentialEnvNames } from './child-env';
import { ROUNDING_EPSILON, choiceAtTop, roundedHundredths } from './distribution';
import { JevConfig, JevError, JevImageAsset, JevRequest, JevResult } from './types';
const object = (v: unknown): v is Record<string, any> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 1024;
const probability = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
const content = (v: unknown): boolean => typeof v === 'string' || Array.isArray(v) || object(v);
const bad = (message: string): never => { throw new JevError('INVALID_REQUEST', message); };
// TypeSafe image limits (https://docs.typesafe.ai/images): out-of-range images are rejected, never resized.
export const JEV_IMAGE_MIN_SIDE = 280, JEV_IMAGE_MAX_SIDE = 1568, JEV_IMAGE_MIN_PIXELS = 78400, JEV_IMAGE_MAX_PIXELS = 2458624;
const IMAGE_MAX_BYTES = 16 << 20, IMAGES_MAX_BYTES = 24 << 20, REFERENCE_MAX_BYTES = 1024, REFERENCES_MAX_BYTES = 65536;
/** Pixel size read from the PNG IHDR or a JPEG SOF segment; undefined for anything else, including animated PNG. */
export function imageDimensions(bytes: Buffer, format: JevImageAsset['format']): { width: number; height: number } | undefined {
  if (format === 'png') {
    if (bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) || bytes.toString('latin1', 12, 16) !== 'IHDR') return;
    for (let at = 8; at + 8 <= bytes.length;) {
      const type = bytes.toString('latin1', at + 4, at + 8);
      if (type === 'acTL') return;
      if (type === 'IDAT') break;
      at += 12 + bytes.readUInt32BE(at);
    }
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return;
  for (let at = 2; at + 9 <= bytes.length;) {
    if (bytes[at] !== 0xff) return;
    const marker = bytes[at + 1];
    if (marker === 0xff) { at++; continue; }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { at += 2; continue; }
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { width: bytes.readUInt16BE(at + 7), height: bytes.readUInt16BE(at + 5) };
    at += 2 + bytes.readUInt16BE(at + 2);
  }
}
function validateAssets(assets: unknown, referenced: string, config: JevConfig): void {
  if (!object(assets)) bad('Assets must be a map.');
  const entries = Object.entries(assets as Record<string, unknown>);
  if (!entries.length) bad('Assets must not be empty.');
  let total = 0, references = 0;
  for (const [ref, asset] of entries) {
    const refBytes = Buffer.byteLength(ref);
    references += refBytes;
    if (!ref.trim() || refBytes > REFERENCE_MAX_BYTES || ['__proto__', 'constructor', 'prototype'].includes(ref)) bad('Invalid asset reference.');
    // Jev replaces reference text inside values (never keys); an unreferenced asset is a provider 400.
    if (!referenced.includes(ref)) bad('Every asset must be referenced in state or questions.');
    if (!object(asset) || Object.keys(asset).some(k => !['type', 'format', 'data_base64'].includes(k)) || asset.type !== 'image' || !['png', 'jpg', 'jpeg'].includes(asset.format)) bad('Invalid image asset.');
    const data = (asset as Record<string, unknown>).data_base64;
    if (typeof data !== 'string' || !data || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) bad('Image data must be padded standard base64.');
    const bytes = Buffer.from(data as string, 'base64');
    if (bytes.length > Math.min(IMAGE_MAX_BYTES, config.images?.maxImageBytes ?? IMAGE_MAX_BYTES)) bad('Image exceeds the per-image byte limit.');
    total += bytes.length;
    const size = imageDimensions(bytes, (asset as JevImageAsset).format);
    if (!size) bad('Image is not a still PNG or JPEG of the declared format.');
    const { width, height } = size!;
    if (width < JEV_IMAGE_MIN_SIDE || height < JEV_IMAGE_MIN_SIDE || width > JEV_IMAGE_MAX_SIDE || height > JEV_IMAGE_MAX_SIDE || width * height < JEV_IMAGE_MIN_PIXELS || width * height > JEV_IMAGE_MAX_PIXELS) bad('Image dimensions are outside the Jev limits.');
  }
  if (references > REFERENCES_MAX_BYTES) bad('Asset references exceed the byte limit.');
  if (total > IMAGES_MAX_BYTES) bad('Images exceed the request byte limit.');
}
/** Every string value (never a key) in state and questions: where Jev substitutes asset references. */
function referenceText(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) referenceText(v, out);
  else if (object(value)) for (const v of Object.values(value)) referenceText(v, out);
  return out;
}
export function validateJevConfig(config: JevConfig | undefined): void {
  if (config === undefined) return;
  if (!object(config)) throw new JevError('INVALID_CONFIG', 'Jev configuration must be an object.');
  if (Object.keys(config).some(key => !['enabled','provider','model','baseUrl','apiKeyFile','apiKeyEnv','timeoutMs','maxConcurrentRequests','maxQueueSize','maxInputBytes','maxQuestions','allowedAgentIds','features','browser','thinking','images'].includes(key))) throw new JevError('INVALID_CONFIG','Unknown Jev configuration field.');
  if (config.enabled !== undefined && typeof config.enabled !== 'boolean') throw new JevError('INVALID_CONFIG', 'Jev enabled must be a boolean.');
  if ((config.enabled || config.provider !== undefined) && config.provider !== 'typesafe' && config.provider !== 'upstream') throw new JevError('INVALID_CONFIG', 'Select a Jev provider.');
  if ((config.enabled || config.model !== undefined) && !text(config.model)) throw new JevError('INVALID_CONFIG', 'A Jev model ID is required.');
  for (const key of ['apiKeyFile', 'apiKeyEnv', 'baseUrl'] as const) if (config[key] !== undefined && !text(config[key])) throw new JevError('INVALID_CONFIG', `Invalid Jev ${key}.`);
  if (config.apiKeyEnv && isReservedJevCredentialEnv(config.apiKeyEnv)) throw new JevError('INVALID_CONFIG', 'Jev apiKeyEnv must use a dedicated credential variable, not native CLI authentication or process controls.');
  if (config.apiKeyEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(config.apiKeyEnv)) throw new JevError('INVALID_CONFIG', 'Invalid Jev environment reference.');
  if (config.allowedAgentIds !== undefined && (!Array.isArray(config.allowedAgentIds) || !config.allowedAgentIds.every(text))) throw new JevError('INVALID_CONFIG', 'Jev allowedAgentIds must contain agent IDs.');
  if (config.features !== undefined && (!object(config.features) || Object.entries(config.features).some(([key, value]) => !['computerTasks', 'computerSteps', 'browserTasks', 'browserSteps'].includes(key) || !object(value) || Object.keys(value).some(k => k !== 'enabled') || (value.enabled !== undefined && typeof value.enabled !== 'boolean')))) throw new JevError('INVALID_CONFIG', 'Invalid Jev feature configuration.');
  if (config.apiKeyFile && config.apiKeyEnv) throw new JevError('INVALID_CONFIG', 'Choose one Jev credential reference.');
  if (config.images !== undefined && (!object(config.images) || Object.keys(config.images).some(k => !['enabled', 'maxImageBytes', 'model'].includes(k)) || (config.images.model !== undefined && !text(config.images.model)) || (config.images.enabled !== undefined && typeof config.images.enabled !== 'boolean') || (config.images.maxImageBytes !== undefined && (!Number.isSafeInteger(config.images.maxImageBytes) || config.images.maxImageBytes < 1 || config.images.maxImageBytes > IMAGE_MAX_BYTES)))) throw new JevError('INVALID_CONFIG', 'Invalid Jev image configuration.');
  for (const [key, min, max] of [['timeoutMs', 1, 120000], ['maxConcurrentRequests', 1, 64], ['maxQueueSize', 0, 256], ['maxInputBytes', 1, 1048576], ['maxQuestions', 1, 256]] as const) {
    const value = config[key];
    if (value !== undefined && (!Number.isSafeInteger(value) || value < min || value > max)) throw new JevError('INVALID_CONFIG', `Invalid Jev ${key}.`);
  }
  validateBrowserIntegration(config.browser);
  if(config.thinking!==undefined)validateBrowserIntegration({bindings:[],textHelper:config.thinking});
  jevCredentialEnvNames(config);
}
export function validateJevRequest(value: unknown, config: JevConfig): JevRequest {
  if (!object(value) || Object.keys(value).some(k => !['state', 'questions', 'assets', 'requestId'].includes(k))) bad('Expected state and typed questions only.');
  const v = value as Record<string, any>;
  let encoded: string;
  try { encoded = JSON.stringify(v); } catch { return bad('Request must contain JSON data.'); }
  // Image bytes have their own caps; maxInputBytes bounds the text a request carries.
  const { assets: _assets, ...textual } = v;
  if (Buffer.byteLength(JSON.stringify(textual)) > (config.maxInputBytes ?? 131072)) bad('Jev request exceeds the input byte limit.');
  // Reject non-JSON values rather than silently letting JSON.stringify remove them.
  const checkJson = (x: unknown, depth: number): void => {
    if (depth > 32) bad('Jev request nesting exceeds 32 levels.');
    if (x === null || typeof x === 'string' || typeof x === 'boolean' || (typeof x === 'number' && Number.isFinite(x))) return;
    if (!Array.isArray(x) && !object(x)) bad('Request must contain JSON data.');
    if (object(x) && Object.getPrototypeOf(x) !== Object.prototype && Object.getPrototypeOf(x) !== null) bad('Request must contain plain JSON objects.');
    for (const y of Object.values(x as object)) checkJson(y, depth + 1);
  };
  checkJson(v, 0);
  if (!content(v.state) || !object(v.questions)) bad('State and questions are required.');
  const entries = Object.entries(v.questions);
  if (!entries.length || entries.length > (config.maxQuestions ?? 64)) bad('Question count exceeds the configured limits.');
  if (v.requestId !== undefined && (typeof v.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(v.requestId))) bad('Invalid request ID.');
  for (const [id, q] of entries) {
    if (!text(id) || ['__proto__', 'constructor', 'prototype'].includes(id) || !object(q) || !content(q.instructions)) bad('Invalid question.');
    const question = q as Record<string, any>;
    if (Object.keys(question).some(k => !['type', 'instructions', 'criteria'].includes(k))) bad('Unknown question field.');
    if (question.type === 'box') {
      if (question.criteria !== undefined) bad('Box takes no criteria.');
      if (v.assets === undefined) bad('Box requires an image asset.');
    } else if (question.type === 'choice') {
      if (!object(question.criteria)) bad('Choice criteria must be a map.');
      const options = Object.entries(question.criteria);
      if (!options.length || options.length > 255 || options.some(([k, c]) => !text(k) || ['__proto__', 'constructor', 'prototype'].includes(k) || (c !== null && !content(c)))) bad('Invalid Choice criteria.');
    } else if (question.type === 'score') {
      if (!Array.isArray(question.criteria) || question.criteria.length < 2 || question.criteria.length > 10 || !question.criteria.every(content)) bad('Score requires 2–10 levels.');
    } else if (question.type === 'noul') {
      if (question.criteria !== undefined && (!object(question.criteria) || Object.entries(question.criteria).some(([k, c]) => !['true', 'false'].includes(k) || !content(c)))) bad('Invalid Noul criteria.');
    } else bad('Unsupported question type.');
  }
  if (v.assets !== undefined || entries.some(([, q]) => (q as Record<string, unknown>).type === 'box')) {
    if (!config.images?.enabled) bad('Jev image input is not enabled.');
    validateAssets(v.assets, referenceText([v.state, v.questions]).join('\u0000'), config);
  }
  return JSON.parse(encoded!) as JevRequest;
}
export function validateJevResponse(value: unknown, request: JevRequest, requestedModel: string, requestId: string): JevResult {
  const fail = (validationReason: string): never => { throw new JevError('INVALID_RESPONSE', `Jev returned an invalid evaluation (${validationReason}).`, { validationReason }); };
  if (!object(value) || !text(value.model) || !object(value.answers) || !object(value.usage)) fail('ENVELOPE');
  const v = value as Record<string, any>;
  const sameKeys = (a: object, keys: string[]) => Object.keys(a).length === keys.length && keys.every(k => Object.prototype.hasOwnProperty.call(a, k));
  if (!sameKeys(v.answers, Object.keys(request.questions))) fail('ANSWER_KEYS');
  const answers: JevResult['answers'] = {};
  for (const [id, q] of Object.entries(request.questions)) {
    const a = v.answers[id];
    if (!object(a) || a.type !== q.type) fail('ANSWER_TYPE');
    if (q.type === 'noul') { if (!probability(a.noul)) fail('NOUL_RANGE'); answers[id] = { type: 'noul', noul: a.noul }; continue; }
    if (q.type === 'box') {
      const b = a.box;
      // A side can round to zero on a small target (observed from jev-1.14.0): a point, still usable. Inverted is not.
      if (!object(b) || !['top', 'bottom', 'left', 'right'].every(k => probability(b[k])) || b.left > b.right || b.top > b.bottom || !probability(a.confidence)) fail('BOX_SHAPE');
      answers[id] = { type: 'box', box: { top: b.top, bottom: b.bottom, left: b.left, right: b.right }, confidence: a.confidence };
      continue;
    }
    const keys = q.type === 'choice' ? Object.keys(q.criteria) : q.criteria.map((_, i) => String(i));
    if (!probability(a.confidence) || !object(a.probabilities) || !sameKeys(a.probabilities, keys) || !Object.values(a.probabilities).every(probability)) fail('DISTRIBUTION_SHAPE');
    const p = a.probabilities as Record<string, number>;
    // Live Jev responses round probabilities to hundredths (observed sum 0.99).
    // Permit their rounding envelope, capped at two percentage points. Keep
    // full-precision responses strict; never renormalize or raise confidence.
    const values = Object.values(p);
    const tolerance = roundedHundredths(values) ? Math.min(0.02, values.length * 0.005) : 0.001;
    if (Math.abs(values.reduce((sum, n) => sum + n, 0) - 1) > tolerance + ROUNDING_EPSILON) fail('DISTRIBUTION_SUM');
    if (q.type === 'choice') {
      if (typeof a.choice !== 'string' || !keys.includes(a.choice) || !choiceAtTop(p, a.choice)) fail('CHOICE_MISMATCH');
      answers[id] = { type: 'choice', choice: a.choice, confidence: a.confidence, probabilities: p };
    } else {
      const expected = keys.reduce((sum, k) => sum + Number(k) * p[k], 0);
      if (typeof a.score !== 'number' || !Number.isFinite(a.score) || a.score < 0 || a.score > keys.length - 1 || Math.abs(a.score - expected) > 0.01 + ROUNDING_EPSILON || !object(a.legend) || !sameKeys(a.legend, keys) || !Object.values(a.legend).every(x => typeof x === 'string')) fail('SCORE_MISMATCH');
      answers[id] = { type: 'score', score: a.score, confidence: a.confidence, probabilities: p, legend: a.legend };
    }
  }
  if (!['input_tokens', 'output_tokens'].every(k => Number.isSafeInteger(v.usage[k]) && v.usage[k] >= 0)) fail('USAGE');
  if (v.requested_model !== undefined && v.requested_model !== requestedModel) fail('MODEL_IDENTITY');
  if (v.request_id !== undefined && v.request_id !== requestId) fail('REQUEST_IDENTITY');
  if (v.billing !== undefined && (!object(v.billing) || typeof v.billing.charged_credits !== 'number' || !Number.isFinite(v.billing.charged_credits) || v.billing.charged_credits < 0 || (v.billing.rate_version !== undefined && !text(v.billing.rate_version)))) fail('BILLING');
  return { requestId, requestedModel, model: v.model, answers, usage: { input_tokens: v.usage.input_tokens, output_tokens: v.usage.output_tokens }, ...(v.billing ? { billing: { charged_credits: v.billing.charged_credits, ...(v.billing.rate_version ? { rate_version: v.billing.rate_version } : {}) } } : {}) };
}
export const JEV_TOOL_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['state', 'questions'],
  properties: {
    state: { description: 'Bounded text or structured JSON to evaluate.', anyOf: [{ type: 'string' }, { type: 'object' }, { type: 'array' }] },
    questions: { type: 'object', minProperties: 1, maxProperties: 64, additionalProperties: {
      type: 'object', additionalProperties: false, required: ['type', 'instructions'], properties: {
        type: { type: 'string', enum: ['choice', 'score', 'noul'] },
        instructions: { anyOf: [{ type: 'string' }, { type: 'object' }, { type: 'array' }] },
        criteria: { description: 'Choice: option map (1–255); Score: 2–10 ordered levels; Noul: optional true/false map.', anyOf: [{ type: 'object' }, { type: 'array' }] },
      },
    } },
  },
};

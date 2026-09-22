import { validateBrowserIntegration } from './browser-connector';
import { isReservedJevCredentialEnv, jevCredentialEnvNames } from './child-env';
import { JevConfig, JevError, JevRequest, JevResult } from './types';
const object = (v: unknown): v is Record<string, any> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 1024;
// Floating-point arithmetic must not reject a rounded value exactly at a tolerance boundary.
const ROUNDING_EPSILON = 1e-12;
const probability = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
const content = (v: unknown): boolean => typeof v === 'string' || Array.isArray(v) || object(v);
const bad = (message: string): never => { throw new JevError('INVALID_REQUEST', message); };
export function validateJevConfig(config: JevConfig | undefined): void {
  if (config === undefined) return;
  if (!object(config)) throw new JevError('INVALID_CONFIG', 'Jev configuration must be an object.');
  if (Object.keys(config).some(key => !['enabled','provider','model','baseUrl','apiKeyFile','apiKeyEnv','timeoutMs','maxConcurrentRequests','maxQueueSize','maxInputBytes','maxQuestions','allowedAgentIds','features','browser','thinking'].includes(key))) throw new JevError('INVALID_CONFIG','Unknown Jev configuration field.');
  if (config.enabled !== undefined && typeof config.enabled !== 'boolean') throw new JevError('INVALID_CONFIG', 'Jev enabled must be a boolean.');
  if ((config.enabled || config.provider !== undefined) && config.provider !== 'typesafe' && config.provider !== 'upstream') throw new JevError('INVALID_CONFIG', 'Select a Jev provider.');
  if ((config.enabled || config.model !== undefined) && !text(config.model)) throw new JevError('INVALID_CONFIG', 'A Jev model ID is required.');
  for (const key of ['apiKeyFile', 'apiKeyEnv', 'baseUrl'] as const) if (config[key] !== undefined && !text(config[key])) throw new JevError('INVALID_CONFIG', `Invalid Jev ${key}.`);
  if (config.apiKeyEnv && isReservedJevCredentialEnv(config.apiKeyEnv)) throw new JevError('INVALID_CONFIG', 'Jev apiKeyEnv must use a dedicated credential variable, not native CLI authentication or process controls.');
  if (config.apiKeyEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(config.apiKeyEnv)) throw new JevError('INVALID_CONFIG', 'Invalid Jev environment reference.');
  if (config.allowedAgentIds !== undefined && (!Array.isArray(config.allowedAgentIds) || !config.allowedAgentIds.every(text))) throw new JevError('INVALID_CONFIG', 'Jev allowedAgentIds must contain agent IDs.');
  if (config.features !== undefined && (!object(config.features) || Object.entries(config.features).some(([key, value]) => !['browserTasks', 'skillRouting', 'progressFiltering', 'conversationIntake'].includes(key) || !object(value) || Object.keys(value).some(k => k !== 'enabled') || (value.enabled !== undefined && typeof value.enabled !== 'boolean')))) throw new JevError('INVALID_CONFIG', 'Invalid Jev feature configuration.');
  if (config.apiKeyFile && config.apiKeyEnv) throw new JevError('INVALID_CONFIG', 'Choose one Jev credential reference.');
  for (const [key, min, max] of [['timeoutMs', 1, 120000], ['maxConcurrentRequests', 1, 64], ['maxQueueSize', 0, 256], ['maxInputBytes', 1, 1048576], ['maxQuestions', 1, 256]] as const) {
    const value = config[key];
    if (value !== undefined && (!Number.isSafeInteger(value) || value < min || value > max)) throw new JevError('INVALID_CONFIG', `Invalid Jev ${key}.`);
  }
  validateBrowserIntegration(config.browser);
  if(config.thinking!==undefined)validateBrowserIntegration({runnerModule:'validation',bindings:[],textHelper:config.thinking});
  jevCredentialEnvNames(config);
}
export function validateJevRequest(value: unknown, config: JevConfig): JevRequest {
  if (!object(value) || Object.keys(value).some(k => !['state', 'questions', 'requestId'].includes(k))) bad('Expected state and typed questions only.');
  const v = value as Record<string, any>;
  let encoded: string;
  try { encoded = JSON.stringify(v); } catch { return bad('Request must contain JSON data.'); }
  if (Buffer.byteLength(encoded) > (config.maxInputBytes ?? 131072)) bad('Jev request exceeds the input byte limit.');
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
    if (question.type === 'choice') {
      if (!object(question.criteria)) bad('Choice criteria must be a map.');
      const options = Object.entries(question.criteria);
      if (!options.length || options.length > 255 || options.some(([k, c]) => !text(k) || ['__proto__', 'constructor', 'prototype'].includes(k) || (c !== null && !content(c)))) bad('Invalid Choice criteria.');
    } else if (question.type === 'score') {
      if (!Array.isArray(question.criteria) || question.criteria.length < 2 || question.criteria.length > 10 || !question.criteria.every(content)) bad('Score requires 2–10 levels.');
    } else if (question.type === 'noul') {
      if (question.criteria !== undefined && (!object(question.criteria) || Object.entries(question.criteria).some(([k, c]) => !['true', 'false'].includes(k) || !content(c)))) bad('Invalid Noul criteria.');
    } else bad('Unsupported question type.');
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
    const keys = q.type === 'choice' ? Object.keys(q.criteria) : q.criteria.map((_, i) => String(i));
    if (!probability(a.confidence) || !object(a.probabilities) || !sameKeys(a.probabilities, keys) || !Object.values(a.probabilities).every(probability)) fail('DISTRIBUTION_SHAPE');
    const p = a.probabilities as Record<string, number>;
    // Live Jev responses round probabilities to hundredths (observed sum 0.99).
    // Permit their rounding envelope, capped at two percentage points. Keep
    // full-precision responses strict; never renormalize or raise confidence.
    const values = Object.values(p);
    const roundedHundredths = values.every(n => Math.abs(n * 100 - Math.round(n * 100)) <= ROUNDING_EPSILON);
    const tolerance = roundedHundredths ? Math.min(0.02, values.length * 0.005) : 0.001;
    if (Math.abs(values.reduce((sum, n) => sum + n, 0) - 1) > tolerance + ROUNDING_EPSILON) fail('DISTRIBUTION_SUM');
    if (q.type === 'choice') {
      if (typeof a.choice !== 'string' || !keys.includes(a.choice) || keys.some(k => p[k] > p[a.choice] + 0.00001 + ROUNDING_EPSILON)) fail('CHOICE_MISMATCH');
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

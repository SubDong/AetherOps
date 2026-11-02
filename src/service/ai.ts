import { request } from '@/service/base';

/**
 * 解包 API 响应
 * base.request 返回 {ret, msg, data}，此函数提取 data 字段
 * 若 ret !== 0 则抛出异常
 */
function unwrap<T = any>(res: any): T {
  if (res && typeof res === 'object' && 'ret' in res) {
    if (res.ret !== 0) throw new Error(res.msg || '请求失败');
    return res.data as T;
  }
  return res as T;
}

// ========== AI 模型配置（一个账号可多套） ==========

export interface AIProfile {
  id: string;
  label: string;
  enabled: boolean;
  provider: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  maxTokens?: number;
  temperature?: number;
  /** 1=最便宜 … 5=最强，Auto 路由按它分档 */
  costTier: number;
  /** auto=由定价目录/规则推断（可重算），manual=用户手填（不再自动覆盖） */
  costTierSource?: 'auto' | 'manual';
  /** 美元 / 1M token；null=定价目录里没查到 */
  priceIn?: number | null;
  priceOut?: number | null;
  sortOrder: number;
}

/** Auto 是虚拟模型：不存在于库里，由服务端按复杂度实时选一个 */
export const AUTO_MODEL_ID = 'auto';

export function listProfiles() {
  return request<AIProfile[]>('/api/ai/listProfiles', {}).then(unwrap);
}

export function saveProfile(profile: Partial<AIProfile>) {
  return request<AIProfile>('/api/ai/saveProfile', profile).then(unwrap);
}

export function deleteProfile(id: string) {
  return request('/api/ai/deleteProfile', { id }).then(unwrap);
}

export function testProfile(profile: Partial<AIProfile>) {
  return request('/api/ai/testProfile', profile).then(unwrap);
}

// ========== 对话窗口（与连接绑定） ==========

export interface AIChatMeta {
  id: string;
  connectionId: string;
  title: string;
  modelId: string;
  messageCount: number;
  preview: string;
  createdAt: number;
  updatedAt: number;
  /** 该对话累计 token */
  totalTokens?: number;
  /** 该对话累计金额（美元）；单价未知的调用未计入，是下限 */
  costUsd?: number;
}

export function listChats(connectionId?: string) {
  return request<AIChatMeta[]>('/api/ai/listChats', { connectionId: connectionId || '' }).then(unwrap);
}

export function createChat(dto: { connectionId?: string; title?: string; modelId?: string }) {
  return request<AIChatMeta>('/api/ai/createChat', dto).then(unwrap);
}

export function updateChat(chatId: string, patch: { title?: string; modelId?: string }) {
  return request<AIChatMeta>('/api/ai/updateChat', { chatId, ...patch }).then(unwrap);
}

export function deleteChat(chatId: string) {
  return request('/api/ai/deleteChat', { chatId }).then(unwrap);
}

// ========== 成本管控 ==========

export interface CostCheckupIssue {
  code: 'no-usable-model' | 'single-model' | 'uniform-tier' | 'no-cheap-model' | 'missing-price';
  severity: 'warn' | 'info';
  modelIds: string[];
}

export interface TierDecision {
  id: string;
  tier: number;
  priceIn: number | null;
  priceOut: number | null;
  /** catalog=定价目录，rule=模型名规则，unchanged=无法判断 */
  basis: 'catalog' | 'rule' | 'unchanged';
  detail: string;
}

export interface CostAnalysisResult {
  decisions: TierDecision[];
  issues: CostCheckupIssue[];
  catalog: { available: boolean; ok: boolean; matched: number };
  profiles: AIProfile[];
}

export interface UsageTotals {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  unknownCostCalls: number;
}

export interface AIBudget {
  /** 0 一律表示不限 */
  chatTokenLimit: number;
  dailyTokenLimit: number;
  dailyCostLimit: number;
  updatedAt: number;
}

export interface CostInsights {
  today: UsageTotals;
  chat: UsageTotals | null;
  byModel: Array<{ modelId: string; modelLabel: string; calls: number; totalTokens: number; costUsd: number }>;
  budget: AIBudget;
  baselineModel: { id: string; label: string; priceIn: number; priceOut: number } | null;
  /** auto 相比全用最贵模型省下的金额；null 表示算不出来 */
  savedUsd: number | null;
  /** 有调用缺单价，金额是下限 */
  partial: boolean;
}

/** 只体检不写库：打开设置页时调用，不等定价目录 */
export function checkupCosts() {
  return request<CostAnalysisResult>('/api/ai/checkupCosts', {}).then(unwrap);
}

/** 重算全部档位与单价（会等定价目录，可能稍慢） */
export function reanalyzeCosts() {
  return request<CostAnalysisResult>('/api/ai/reanalyzeCosts', {}).then(unwrap);
}

export function getCostInsights(chatId?: string) {
  return request<CostInsights>('/api/ai/getCostInsights', { chatId: chatId || '' }).then(unwrap);
}

export function getBudget() {
  return request<AIBudget>('/api/ai/getBudget', {}).then(unwrap);
}

export function updateBudget(patch: Partial<AIBudget>) {
  return request<AIBudget>('/api/ai/updateBudget', patch).then(unwrap);
}

// ========== AI 配置（旧接口，保留兼容） ==========

export function getAIConfig() {
  return request('/api/ai/getConfig', {}).then(unwrap);
}

export function updateAIConfig(config: any) {
  return request('/api/ai/updateConfig', config).then(unwrap);
}

export function testAIConfig(config: any) {
  return request('/api/ai/testConfig', config).then(unwrap);
}

// ========== AI 对话 ==========

export function chat(sessionId: string, message: string, context?: string) {
  return request('/api/ai/chat', { sessionId, message, context }).then(unwrap);
}

export function clearHistory(sessionId: string) {
  return request('/api/ai/clearHistory', { sessionId }).then(unwrap);
}

// ========== 对话历史 ==========

export function getDisplayHistory(sessionId: string) {
  return request<any[]>('/api/ai/getDisplayHistory', { sessionId }).then(unwrap);
}

export function saveDisplayHistory(sessionId: string, messages: any[], sessionName?: string) {
  return request('/api/ai/saveDisplayHistory', { sessionId, messages, sessionName }).then(unwrap);
}

export function listHistories() {
  return request<any[]>('/api/ai/listHistories', {}).then(unwrap);
}

export function loadHistory(sessionId: string) {
  return request<any[]>('/api/ai/loadHistory', { sessionId }).then(unwrap);
}

export function deleteHistory(sessionId: string) {
  return request('/api/ai/deleteHistory', { sessionId }).then(unwrap);
}

// ========== 系统环境 ==========

export function getSystemContext(sessionId: string) {
  return request<string>('/api/ai/getSystemContext', { sessionId }).then(unwrap);
}

// ========== Skills ==========

export function getSkills() {
  return request<any[]>('/api/ai/getSkills', {}).then(unwrap);
}

export function getSkill(id: string) {
  return request('/api/ai/getSkill', { id }).then(unwrap);
}

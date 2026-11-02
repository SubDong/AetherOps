<template>
  <Modal
    ref="aiSettingsModal"
    :title="t('ai.settings')"
    :closeButton="{ text: t('common.cancel'), show: false }"
    :confirmButton="{ text: '', show: false }"
    :dialogStyle="{ maxWidth: '880px', width: '100%' }"
    @onHidden="handleModalClose"
  >
    <div class="ai-settings">
      <!-- 左：模型列表（Auto + 各套配置） -->
      <aside class="model-list">
        <div class="model-list-header">
          <span class="model-list-title"><i class="bi bi-collection me-1"></i>{{ t('ai.modelList') }}</span>
          <button type="button" class="btn btn-sm btn-outline-primary" :disabled="saving" @click="startCreate">
            <i class="bi bi-plus-lg me-1"></i>{{ t('ai.addModel') }}
          </button>
        </div>
        <div class="model-items">
          <div class="model-item auto-item" :class="{ active: selectedId === AUTO_MODEL_ID }" @click="selectedId = AUTO_MODEL_ID">
            <div class="model-item-main">
              <span class="model-item-label"><i class="bi bi-stars me-1"></i>{{ t('ai.autoTitle') }}</span>
              <span class="model-item-sub">{{ t('ai.autoBadge') }}</span>
            </div>
          </div>

          <div
            v-for="p in profiles"
            :key="p.id"
            class="model-item"
            :class="{ active: selectedId === p.id, off: !p.enabled }"
            @click="selectProfile(p)"
          >
            <div class="model-item-main">
              <span class="model-item-label text-truncate">{{ p.label || p.model }}</span>
              <span class="model-item-sub text-truncate">{{ p.model }}</span>
            </div>
            <span
              class="tier-badge"
              :class="{ auto: p.costTierSource === 'auto' }"
              :title="p.costTierSource === 'auto' ? t('ai.tierAuto') : t('ai.tierManual')"
            >{{ p.costTier }}</span>
          </div>

          <div v-if="profiles.length === 0" class="model-empty">{{ t('ai.noModels') }}</div>
        </div>
        <!-- 主动重算：会等定价目录，所以只能由用户点，不能在打开弹窗时自动跑 -->
        <button type="button" class="btn btn-sm btn-outline-secondary w-100 mt-2" :disabled="analyzing" @click="reanalyze">
          <span v-if="analyzing" class="spinner-border spinner-border-sm me-1"></span>
          <i v-else class="bi bi-calculator me-1"></i>
          {{ analyzing ? t('ai.analyzing') : t('ai.reanalyze') }}
        </button>
      </aside>

      <!-- 右：Auto 说明 / 具体配置表单 -->
      <section class="model-form">
        <div v-if="selectedId === AUTO_MODEL_ID" class="auto-explain">
          <h6><i class="bi bi-stars me-1"></i>{{ t('ai.autoTitle') }}</h6>
          <p>{{ t('ai.autoHint') }}</p>
          <p class="text-muted small mb-3">{{ t('ai.costTierHint') }}</p>

          <!-- 配置体检：只做纯计算，回答「这套配置能不能真的省钱」 -->
          <div v-if="issues.length" class="checkup-box">
            <div class="checkup-title"><i class="bi bi-clipboard-pulse me-1"></i>{{ t('ai.checkup') }}</div>
            <div v-for="issue in issues" :key="issue.code" class="checkup-item" :class="issue.severity">
              <i :class="issue.severity === 'warn' ? 'bi bi-exclamation-triangle' : 'bi bi-info-circle'"></i>
              <span>{{ issueText(issue) }}</span>
            </div>
            <div v-if="!catalogAvailable" class="checkup-item info">
              <i class="bi bi-cloud-slash"></i>
              <span>{{ t('ai.catalogOffline') }}</span>
            </div>
          </div>
          <div v-else class="checkup-ok">
            <i class="bi bi-check-circle me-1"></i>{{ t('ai.checkupOk') }}
          </div>

          <!-- 预算：0 一律表示不限 -->
          <div class="budget-box">
            <div class="checkup-title"><i class="bi bi-wallet2 me-1"></i>{{ t('ai.budget') }}</div>
            <div class="row g-2">
              <div class="col-4">
                <label class="form-label small mb-1">{{ t('ai.chatTokenLimit') }}</label>
                <input type="number" min="0" class="form-control form-control-sm" v-model.number="budgetForm.chatTokenLimit">
              </div>
              <div class="col-4">
                <label class="form-label small mb-1">{{ t('ai.dailyTokenLimit') }}</label>
                <input type="number" min="0" class="form-control form-control-sm" v-model.number="budgetForm.dailyTokenLimit">
              </div>
              <div class="col-4">
                <label class="form-label small mb-1">{{ t('ai.dailyCostLimit') }}</label>
                <input type="number" min="0" step="0.01" class="form-control form-control-sm" v-model.number="budgetForm.dailyCostLimit">
              </div>
            </div>
            <small class="form-text text-muted d-block mt-2">{{ t('ai.budgetHint') }}</small>
          </div>

          <div class="mt-3 d-flex justify-content-end gap-2">
            <button type="button" class="btn btn-outline-primary btn-sm" :disabled="savingBudget" @click="saveBudget">
              <span v-if="savingBudget" class="spinner-border spinner-border-sm me-1"></span>
              <i v-else class="bi bi-check2 me-1"></i>
              {{ t('ai.saveBudget') }}
            </button>
            <button type="button" class="btn btn-secondary" @click="close">{{ t('common.close') }}</button>
          </div>
        </div>

        <form v-else @submit.prevent="saveSettings" class="ai-settings-form">
          <div class="mb-3">
            <label class="form-label fw-bold">
              <i class="bi bi-tag me-1"></i>{{ t('ai.modelLabel') }} <span class="text-danger">*</span>
            </label>
            <input type="text" class="form-control" v-model="form.label" :placeholder="t('ai.modelLabelPlaceholder')">
            <small class="form-text text-muted">{{ t('ai.modelLabelHint') }}</small>
          </div>

          <div class="mb-3">
            <label class="form-label fw-bold">
              <i class="bi bi-cloud me-1"></i>{{ t('ai.provider') }} <span class="text-danger">*</span>
            </label>
            <select class="form-select" v-model="form.provider" @change="onProviderChange">
              <option value="openai">OpenAI</option>
              <option value="anthropic">Anthropic (Claude)</option>
              <option value="tencent">腾讯云</option>
              <option value="azure">Azure OpenAI</option>
              <option value="custom">自定义</option>
            </select>
            <small class="form-text text-muted">{{ t('ai.providerHint') }}</small>
          </div>

          <div class="mb-3">
            <label class="form-label fw-bold">
              <i class="bi bi-key me-1"></i>{{ t('ai.apiKey') }} <span class="text-danger">*</span>
            </label>
            <div class="input-group">
              <input
                :type="showApiKey ? 'text' : 'password'"
                class="form-control"
                v-model="form.apiKey"
                :placeholder="t('ai.apiKeyPlaceholder')"
                autocomplete="off"
              >
              <button type="button" class="btn btn-outline-secondary" :title="t('context.copy')" @click="copyApiKey">
                <i class="bi bi-clipboard"></i>
              </button>
              <button type="button" class="btn btn-outline-secondary" @click="showApiKey = !showApiKey">
                <i :class="showApiKey ? 'bi bi-eye-slash' : 'bi bi-eye'"></i>
              </button>
            </div>
            <small class="form-text text-muted">{{ t('ai.apiKeyHint') }}</small>
          </div>

          <div class="mb-3">
            <label class="form-label fw-bold">
              <i class="bi bi-globe me-1"></i>{{ t('ai.baseUrl') }}
            </label>
            <input type="text" class="form-control" v-model="form.baseUrl" :placeholder="t('ai.baseUrlPlaceholder')">
            <small class="form-text text-muted">{{ t('ai.baseUrlHint') }}</small>
          </div>

          <div class="mb-3">
            <label class="form-label fw-bold">
              <i class="bi bi-cpu me-1"></i>{{ t('ai.model') }} <span class="text-danger">*</span>
            </label>
            <input type="text" class="form-control" v-model="form.model" :placeholder="t('ai.modelPlaceholder')">
            <small class="form-text text-muted">{{ t('ai.modelHint') }}</small>
          </div>

          <div class="row mb-3">
            <div class="col-6">
              <label class="form-label">
                {{ t('ai.costTier') }}
                <span class="tier-source" :class="form.costTierSource">
                  {{ form.costTierSource === 'manual' ? t('ai.tierManual') : t('ai.tierAuto') }}
                </span>
              </label>
              <select class="form-select form-select-sm" v-model.number="form.costTier" @change="tierTouched = true">
                <!-- 新建且没动过下拉时停在这里：值是 0 而不是 3，避免把“默认 3 档”
                     看成分析结果（真正的档位在保存时由服务端按定价目录算出来） -->
                <option v-if="showAutoTierPlaceholder" :value="0" disabled>{{ t('ai.tierAutoPending') }}</option>
                <option v-for="n in 5" :key="n" :value="n">{{ n }}</option>
              </select>
            </div>
            <div class="col-6">
              <label class="form-label">{{ t('ai.maxTokens') }}</label>
              <input type="number" class="form-control form-control-sm" v-model.number="form.maxTokens" min="100" max="32000">
            </div>
          </div>
          <small class="form-text text-muted d-block mb-3">
            {{ tierTouched ? t('ai.costTierManualHint') : t('ai.costTierHint') }}
            <span class="d-block">{{ priceText }}</span>
          </small>

          <div class="row mb-3">
            <div class="col-6">
              <label class="form-label">{{ t('ai.temperature') }}</label>
              <input type="number" class="form-control form-control-sm" v-model.number="form.temperature" min="0" max="2" step="0.1">
            </div>
            <div class="col-6 d-flex align-items-end">
              <div class="form-check">
                <input class="form-check-input" type="checkbox" id="ai-model-enabled" v-model="form.enabled">
                <label class="form-check-label" for="ai-model-enabled">{{ t('ai.enabled') }}</label>
              </div>
            </div>
          </div>

          <div class="d-flex align-items-center gap-2 mt-3">
            <button type="button" class="btn btn-outline-info" @click="testConnection" :disabled="testing">
              <span v-if="testing" class="spinner-border spinner-border-sm me-1"></span>
              <i v-else class="bi bi-lightning me-1"></i>
              {{ testing ? t('ai.testing') : t('ai.testConnection') }}
            </button>
            <button v-if="selectedId !== NEW_ID" type="button" class="btn btn-outline-danger" @click="removeModel" :disabled="saving">
              <i class="bi bi-trash me-1"></i>{{ t('ai.deleteModel') }}
            </button>
            <div class="ms-auto d-flex gap-2">
              <button type="button" class="btn btn-secondary" @click="close">{{ t('common.cancel') }}</button>
              <button type="submit" class="btn btn-primary" :disabled="saving">
                <span v-if="saving" class="spinner-border spinner-border-sm me-1"></span>
                {{ saving ? t('common.processing') : t('common.save') }}
              </button>
            </div>
          </div>
        </form>
      </section>
    </div>
  </Modal>
</template>

<script lang="ts" setup>
import { ref, reactive, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import Modal from '@/components/modal/index.vue';
import * as aiService from '@/service/ai';
import { toast } from '@/utils/toast';
import { modal } from '@/utils/modal';
import { copy } from '@/utils/clipboard';
import { publish, AI_PROFILES_CHANGED } from '@/base/eventBus';

const { t } = useI18n();

const emit = defineEmits(['saved']);

/** Auto 不是真实配置，列表里占一个位置，选中时只显示说明 */
const AUTO_MODEL_ID = aiService.AUTO_MODEL_ID;
/** 新增态：表单已打开但还没落库 */
const NEW_ID = '__new__';

const aiSettingsModal = ref();
// 账号隔离后配置只属于本人，服务端也不再下发掩码值，
// 默认就按原样显示，方便核对与随手复制；需要防肩窥时点眼睛切回密码框
const showApiKey = ref(true);
const testing = ref(false);
const saving = ref(false);
const loading = ref(false);

const profiles = ref<aiService.AIProfile[]>([]);
const selectedId = ref<string>(AUTO_MODEL_ID);

/** 用户是否动过档位下拉框：动过才提交 costTier，否则交给服务端自动识别 */
const tierTouched = ref(false);
/** 新建且还没动过下拉：显示「自动（保存后分析）」，不拿占位值冒充分析结果 */
const showAutoTierPlaceholder = computed(() => selectedId.value === NEW_ID && !tierTouched.value);
const analyzing = ref(false);
const savingBudget = ref(false);
const issues = ref<aiService.CostCheckupIssue[]>([]);
const catalogAvailable = ref(false);
const budgetForm = reactive({ chatTokenLimit: 0, dailyTokenLimit: 0, dailyCostLimit: 0 });

interface AIProfileForm {
  id?: string;
  label: string;
  enabled: boolean;
  provider: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  maxTokens: number;
  temperature: number;
  costTier: number;
  costTierSource: 'auto' | 'manual';
  sortOrder: number;
}

const defaultForm = (): AIProfileForm => ({
  label: '',
  enabled: true,
  provider: 'openai',
  apiKey: '',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
  maxTokens: 2000,
  temperature: 0.7,
  // 0 只是新建时的「未定」占位，不会提交；档位由保存时的自动分析给出
  costTier: 0,
  costTierSource: 'auto',
  sortOrder: profiles.value.length,
});

const form = reactive<AIProfileForm>(defaultForm());

const selectedProfile = computed(() => profiles.value.find((p) => p.id === selectedId.value));

async function open() {
  aiSettingsModal.value?.show();
  await refreshList();
  // 体检与预算都只读，不与列表串行：哪个先回来先显示
  void refreshCheckup();
  void refreshBudget();
}

/** 体检不写库、不等定价目录：打开弹窗不该因为网络慢而卡住 */
async function refreshCheckup() {
  try {
    const result = await aiService.checkupCosts();
    issues.value = result?.issues || [];
    catalogAvailable.value = !!result?.catalog?.available;
  } catch {
    // 体检失败不影响配置编辑
  }
}

async function refreshBudget() {
  try {
    const budget = await aiService.getBudget();
    Object.assign(budgetForm, {
      chatTokenLimit: budget?.chatTokenLimit || 0,
      dailyTokenLimit: budget?.dailyTokenLimit || 0,
      dailyCostLimit: budget?.dailyCostLimit || 0,
    });
  } catch {
    // 预算读不到不影响配置编辑
  }
}

function close() {
  aiSettingsModal.value?.hide();
}

function handleModalClose() {
  // 关闭时把视图复位到 Auto，避免下次打开停在一个已被删掉的配置上
  selectedId.value = AUTO_MODEL_ID;
}

async function refreshList(keepId?: string) {
  loading.value = true;
  try {
    profiles.value = (await aiService.listProfiles()) || [];
    const wanted = keepId || selectedId.value;
    if (wanted === NEW_ID) return;
    if (wanted !== AUTO_MODEL_ID && !profiles.value.some((p) => p.id === wanted)) {
      selectedId.value = profiles.value[0]?.id || AUTO_MODEL_ID;
    } else {
      selectedId.value = wanted;
    }
    syncForm();
  } catch (e: any) {
    console.error('Failed to load AI profiles:', e);
    toast.error(e?.message || t('ai.saveFailed'));
  } finally {
    loading.value = false;
  }
}

/** 列表选中项 → 表单 */
function syncForm() {
  if (selectedId.value === AUTO_MODEL_ID || selectedId.value === NEW_ID) return;
  const p = selectedProfile.value;
  if (!p) return;
  tierTouched.value = false;
  Object.assign(form, defaultForm(), {
    id: p.id,
    label: p.label,
    enabled: p.enabled,
    provider: p.provider,
    apiKey: p.apiKey,
    baseUrl: p.baseUrl,
    model: p.model,
    maxTokens: p.maxTokens ?? 2000,
    temperature: p.temperature ?? 0.7,
    costTier: p.costTier ?? 3,
    costTierSource: p.costTierSource || 'auto',
    sortOrder: p.sortOrder ?? 0,
  });
}

function selectProfile(p: aiService.AIProfile) {
  selectedId.value = p.id;
  syncForm();
}

function startCreate() {
  selectedId.value = NEW_ID;
  tierTouched.value = false;
  Object.assign(form, defaultForm());
}

async function copyApiKey() {
  if (!form.apiKey) {
    toast.warning(t('ai.apiKeyRequired'));
    return;
  }
  if (await copy(form.apiKey)) toast.success(t('ai.copied'));
}

async function saveSettings() {
  if (!form.label.trim() || !form.model.trim()) {
    toast.warning(t('ai.modelRequired'));
    return;
  }
  if (!form.apiKey) {
    toast.warning(t('ai.apiKeyRequired'));
    return;
  }
  saving.value = true;
  try {
    const payload: any = { ...form };
    // 档位来源由服务端判定：带了 costTier 就是手填，不带就是自动识别。
    // 前端不能把自己的 costTierSource 一同提交，否则自动识别会被静默变成手填。
    delete payload.costTierSource;
    // 0 是新建时的占位值，不能当成用户选了数字
    if (!tierTouched.value || !form.costTier) delete payload.costTier;
    const saved = await aiService.saveProfile(payload);
    toast.success(t('ai.modelSaved'));
    selectedId.value = saved?.id || form.id || AUTO_MODEL_ID;
    await refreshList(selectedId.value);
    void refreshCheckup();
    publish(AI_PROFILES_CHANGED);
    emit('saved');
  } catch (e: any) {
    toast.error(e?.message || t('ai.saveFailed'));
  } finally {
    saving.value = false;
  }
}

async function removeModel() {
  const p = selectedProfile.value;
  if (!p) return;
  const ok = await modal.confirm(t('ai.deleteModelConfirm', { label: p.label || p.model }));
  if (!ok) return;
  saving.value = true;
  try {
    await aiService.deleteProfile(p.id);
    toast.success(t('ai.modelDeleted'));
    selectedId.value = AUTO_MODEL_ID;
    await refreshList(AUTO_MODEL_ID);
    void refreshCheckup();
    publish(AI_PROFILES_CHANGED);
    emit('saved');
  } catch (e: any) {
    toast.error(e?.message || t('ai.saveFailed'));
  } finally {
    saving.value = false;
  }
}

async function testConnection() {
  testing.value = true;
  try {
    const result = await aiService.testProfile({ ...form });
    if (result?.success) {
      toast.success(t('ai.testSuccess'));
    } else {
      toast.error(result?.message || t('ai.testFailed'));
    }
  } catch (e: any) {
    toast.error(e?.message || t('ai.testFailed'));
  } finally {
    testing.value = false;
  }
}

// ========== 成本分析 ==========

function issueText(issue: aiService.CostCheckupIssue): string {
  switch (issue.code) {
    case 'no-usable-model': return t('ai.issueNoUsableModel');
    case 'single-model': return t('ai.issueSingleModel');
    case 'uniform-tier': return t('ai.issueUniformTier');
    case 'no-cheap-model': return t('ai.issueNoCheapModel');
    case 'missing-price': return t('ai.issueMissingPrice', { n: issue.modelIds.length });
    default: return issue.code;
  }
}

function fmtPrice(value: number | null | undefined): string {
  if (value === null || value === undefined) return '-';
  if (value === 0) return '0';
  return value >= 1 ? value.toFixed(2) : value.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
}

const priceText = computed(() => {
  const p = selectedProfile.value;
  if (!p) return '';
  if (p.priceIn == null && p.priceOut == null) return t('ai.priceUnknown');
  return t('ai.priceInfo', { in: fmtPrice(p.priceIn), out: fmtPrice(p.priceOut) });
});

/** 重新分析：会等定价目录，所以只有用户主动点时迁就网络（此处最能接受） */
async function reanalyze() {
  analyzing.value = true;
  try {
    const result = await aiService.reanalyzeCosts();
    if (result?.profiles) profiles.value = result.profiles;
    issues.value = result?.issues || [];
    catalogAvailable.value = !!result?.catalog?.available;
    syncForm();
    toast.success(t('ai.analyzeDone', { n: result?.decisions?.length || 0 }));
    publish(AI_PROFILES_CHANGED);
    emit('saved');
  } catch (e: any) {
    toast.error(e?.message || t('ai.saveFailed'));
  } finally {
    analyzing.value = false;
  }
}

async function saveBudget() {
  savingBudget.value = true;
  try {
    await aiService.updateBudget({ ...budgetForm });
    toast.success(t('ai.budgetSaved'));
  } catch (e: any) {
    toast.error(e?.message || t('ai.saveFailed'));
  } finally {
    savingBudget.value = false;
  }
}

// Provider 预设配置
const providerPresets: Record<string, { baseUrl: string; model: string }> = {
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  anthropic: { baseUrl: 'https://api.anthropic.com', model: 'claude-3-5-sonnet-20241022' },
  tencent: { baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1', model: 'hunyuan-lite' },
  azure: { baseUrl: '', model: 'gpt-4o-mini' },
  custom: { baseUrl: '', model: '' },
};

function onProviderChange() {
  const preset = providerPresets[form.provider];
  if (preset) {
    form.baseUrl = preset.baseUrl;
    form.model = preset.model;
  }
}

defineExpose({ open, close });
</script>

<style scoped>
.ai-settings {
  display: flex;
  gap: 16px;
  min-height: 420px;
}

/* 左侧模型列表 */
.model-list {
  width: 220px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--border-color);
  padding-right: 12px;
}
.model-list-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  margin-bottom: 10px;
}
.model-list-title {
  font-weight: 600;
  font-size: 13px;
  white-space: nowrap;
}
.model-items {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 460px;
}
.model-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.15s;
}
.model-item:hover {
  background: rgb(var(--overlay-rgb) / 8%);
}
.model-item.active {
  border-color: var(--accent);
  background: rgb(var(--accent-rgb) / 12%);
}
.model-item.off {
  opacity: 0.55;
}
.model-item-main {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1;
}
.model-item-label {
  font-size: 13px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.model-item-sub {
  font-size: 11px;
  color: var(--text-secondary);
}
.tier-badge {
  flex-shrink: 0;
  min-width: 22px;
  text-align: center;
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 999px;
  background: rgb(var(--overlay-rgb) / 12%);
  color: var(--text-secondary);
}
.model-empty {
  font-size: 12px;
  color: var(--text-secondary);
  padding: 8px 2px;
  line-height: 1.5;
}

/* 右侧表单 */
.model-form {
  flex: 1;
  min-width: 0;
}
.ai-settings-form {
  padding: 0 0.25rem;
}
.auto-explain {
  padding: 4px 6px;
  line-height: 1.7;
  font-size: 13px;
  /* 体检 + 预算加起来比原来的说明高很多，不滚动会把底部按钮挤出去 */
  max-height: 460px;
  overflow-y: auto;
}

/* 档位来源标识：自动识别用虚线，手填用实线，一眼能分清谁会被重算 */
.tier-source {
  font-size: 11px;
  font-weight: 400;
  margin-left: 6px;
  padding: 1px 6px;
  border-radius: 999px;
  border: 1px dashed rgb(var(--overlay-rgb) / 40%);
  color: var(--text-secondary);
}
.tier-source.manual {
  border-style: solid;
  border-color: var(--accent);
  color: var(--accent);
}
.tier-badge.auto {
  border: 1px dashed rgb(var(--overlay-rgb) / 45%);
}

.checkup-box,
.budget-box {
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 12px;
}
.checkup-title {
  font-weight: 600;
  font-size: 12px;
  margin-bottom: 8px;
  color: var(--text-secondary);
}
.checkup-item {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  font-size: 12px;
  line-height: 1.6;
  margin-bottom: 4px;
}
.checkup-item.warn i {
  color: #f0ad4e;
}
.checkup-item.info i {
  color: var(--text-secondary);
}
.checkup-ok {
  font-size: 12px;
  color: #4caf50;
  margin-bottom: 12px;
}

.form-check-input:checked {
  background-color: var(--accent);
  border-color: var(--accent);
}

.form-text {
  font-size: 12px;
  display: block;
  margin-top: 4px;
}
</style>

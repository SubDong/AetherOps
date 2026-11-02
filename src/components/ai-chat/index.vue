<template>
  <div class="ai-chat-panel" :class="{ collapsed: !isOpen }">
    <!-- 头部 -->
    <div class="ai-chat-header">
      <div class="d-flex align-items-center gap-2">
        <!-- Tab 切换 -->
        <div class="ai-tab-bar">
          <button class="ai-tab" :class="{ active: activeTab === 'chat' }" @click="activeTab = 'chat'">
            <i class="bi bi-robot"></i> {{ t('ai.chat') }}
          </button>
          <button class="ai-tab" :class="{ active: activeTab === 'audit' }" @click="activeTab = 'audit'">
            <i class="bi bi-shield-check"></i> {{ t('audit.title') }}
          </button>
          <button class="ai-tab" :class="{ active: activeTab === 'monitor' }" @click="activeTab = 'monitor'">
            <i class="bi bi-activity"></i> {{ t('monitor.title') }}
          </button>
        </div>
      </div>
      <div class="d-flex gap-1">
        <template v-if="activeTab === 'chat'">
          <button class="btn-ai-action" @click="handleOpenSettings" :title="t('ai.settings')">
            <i class="bi bi-gear"></i>
          </button>
          <button class="btn-ai-action" @click="newChat" :title="t('ai.newChat')">
            <i class="bi bi-plus-square"></i>
          </button>
          <button class="btn-ai-action" @click="toggleChatPanel" :title="t('ai.chats')" :class="{ active: showChatPanel }">
            <i class="bi bi-chat-square-text"></i>
          </button>
          <span v-if="sessionTokens > 0" class="ai-session-tokens" :title="t('ai.sessionTokens')">
            <i class="bi bi-cpu"></i>
            <span>{{ formatTokens(sessionTokens) }}</span>
          </span>
          <span v-if="isAgentRunning" class="ai-run-status" :class="{ long: isRunningLong }">
            <span class="ai-run-dot"></span>
            <span class="ai-run-text">{{ t('ai.generating') }}</span>
            <span class="ai-run-time">{{ elapsedText }}</span>
          </span>
          <button v-if="isAgentRunning" class="btn-ai-action btn-stop" @click="handleStop" :title="t('ai.stopAgent')">
            <i class="bi bi-stop-circle"></i>
          </button>
          <button class="btn-ai-action" @click="handleClear" :title="t('ai.clearHistory')">
            <i class="bi bi-trash"></i>
          </button>
        </template>
        <button class="btn-ai-action" @click="handleClose" :title="t('common.close')">
          <i class="bi bi-x-lg"></i>
        </button>
      </div>
    </div>

    <!-- 对话状态栏：当前对话 + 本次使用哪个模型 -->
    <div v-if="activeTab === 'chat'" class="ai-chat-toolbar">
      <div class="ai-chat-title" :title="currentChatTitle">
        <i class="bi bi-chat-dots"></i>
        <span class="text-truncate">{{ currentChatTitle }}</span>
      </div>
      <select
        v-model="selectedModelId"
        class="ai-model-select"
        :title="selectedModelHint"
        @change="handleModelChange"
      >
        <option :value="AUTO_MODEL_ID">{{ t('ai.autoTitle') }}</option>
        <option v-for="p in usableProfiles" :key="p.id" :value="p.id">{{ modelOptionText(p) }}</option>
      </select>
      <button class="btn-ai-action" @click="toggleCostPanel" :title="t('ai.costTitle')" :class="{ active: showCostPanel }">
        <i class="bi bi-graph-up-arrow"></i>
      </button>
      <button class="btn-ai-action" @click="handleOpenSettings" :title="t('ai.modelList')">
        <i class="bi bi-sliders"></i>
      </button>
    </div>

    <!-- 没绑终端就把话说在前面：不说，模型会反复试工具，最后给用户编一句「终端会话已断开」 -->
    <div v-if="activeTab === 'chat' && !sessionId" class="ai-no-terminal">
      <i class="bi bi-plug"></i>
      <span>{{ t('ai.noTerminalBound') }}</span>
    </div>

    <!-- 消息列表 (Chat 模式) -->
    <div v-show="activeTab === 'chat'" class="ai-chat-messages" ref="messagesContainer" @click="handleMessagesClick">
      <div v-if="messages.length === 0" class="ai-chat-empty">
        <i class="bi bi-robot" style="font-size: 32px; opacity: 0.5;"></i>
        <p>{{ t('ai.agentHint') }}</p>
      </div>
      <div 
        v-for="(msg, index) in messages" 
        :key="index" 
        class="ai-message"
        :data-msg-index="index"
        :class="[msg.role, { 'system-info': msg.isSystemInfo }]"
      >
        <div class="ai-message-avatar">
          <i :class="msg.isSystemInfo ? 'bi bi-info-circle' : (msg.role === 'user' ? 'bi bi-person' : 'bi bi-robot')"></i>
        </div>
        <div class="ai-message-content">
          <!-- 用户消息中显示 Skill 标签 -->
          <div v-if="msg.skillName" class="skill-badge">
            <i class="bi bi-lightning-charge-fill"></i>
            <span>{{ msg.skillName }}</span>
          </div>

          <!-- 本轮实际使用的模型（Auto 换模型时标出来，便于理解） -->
          <div v-if="msg.modelLabel" class="ai-msg-model">
            <i class="bi bi-cpu"></i>
            <span>{{ msg.modelLabel }}</span>
            <span v-if="msg.autoRouted" class="ai-msg-model-auto">{{ t('ai.autoBadge') }}</span>
          </div>

          <!-- Agent 步骤（在文本上方，先执行后结论） -->
          <div v-if="msg.agentSteps && msg.agentSteps.length > 0" class="agent-steps">
            <template v-for="(step, stepIdx) in msg.agentSteps" :key="stepIdx">
              <!-- 思考中 -->
              <div v-if="step.type === 'thinking'" class="agent-step thinking-step">
                <div class="ai-loading">
                  <span></span><span></span><span></span>
                </div>
                <span class="step-label">{{ t('ai.agentThinking') }}</span>
              </div>
              
              <!-- 工具调用（默认折叠，紧凑显示） -->
              <div v-if="step.type === 'tool_call'" class="agent-step tool-call-step">
                <div class="step-header" @click="toggleStep(step)">
                  <i :class="step.collapsed ? 'bi bi-chevron-right' : 'bi bi-chevron-down'" class="step-chevron"></i>
                  <i class="bi bi-terminal step-icon"></i>
                  <code class="step-cmd">{{ getToolDisplayCmd(step) }}</code>
                  <i v-if="step.type === 'tool_call' && !step.result && isAgentRunning" class="step-status bi bi-arrow-repeat spin"></i>
                  <i v-else-if="step.result" :class="step.collapsed ? 'bi bi-check-circle' : 'bi bi-check-circle-fill'" class="step-status"></i>
                </div>
                <div v-if="!step.collapsed && step.result" class="step-result">
                  <pre>{{ step.result }}</pre>
                </div>
              </div>
            </template>
          </div>

          <!-- AI 回复文本 -->
          <div class="ai-message-text" v-if="msg.content" v-html="renderMarkdown(msg.content)"></div>
          <span v-if="msg.role === 'assistant' && msg.isRunning && msg.content" class="ai-caret"></span>
          <!-- 等待首个响应（无思考步骤时）的加载动画 -->
          <div v-if="msg.role === 'assistant' && msg.isRunning && !msg.content && !hasThinkingStep(msg)" class="ai-msg-gen">
            <span></span><span></span><span></span>
          </div>

          <!-- 失败重试 -->
          <div v-if="msg.role === 'assistant' && msg.isError && !msg.isRunning" class="ai-msg-error-actions">
            <button class="msg-retry-btn" @click="retryMessage(index)">
              <i class="bi bi-arrow-clockwise"></i>{{ t('ai.retry') }}
            </button>
          </div>

          <!-- AI 消息底部信息：复制 / 耗时 / token 消耗 -->
          <div v-if="msg.role === 'assistant' && !msg.isRunning && !msg.isSystemInfo && msg.content" class="ai-msg-meta">
            <button class="msg-meta-btn" @click="copyMessage(msg, index)" :title="t('ai.copyMessage')">
              <i :class="copiedIdx === index ? 'bi bi-check-lg' : 'bi bi-copy'"></i>
              <span v-if="copiedIdx === index">{{ t('ai.copied') }}</span>
            </button>
            <span v-if="msg.durationMs != null" class="msg-meta-item" :title="t('ai.duration')">
              <i class="bi bi-clock"></i>{{ formatDuration(msg.durationMs) }}
            </span>
            <span v-if="msg.tokens != null" class="msg-meta-item" :title="t('ai.tokens')">
              <i class="bi bi-cpu"></i>{{ formatTokens(msg.tokens) }} tokens
            </span>
          </div>
        </div>
      </div>
    </div>

    <!-- Skills 面板 -->
    <div v-if="showSkillsPanel" class="skills-panel">
      <div class="skills-panel-header">
        <span>{{ t('ai.selectSkill') }}</span>
        <button class="btn-ai-action" @click="showSkillsPanel = false">
          <i class="bi bi-x"></i>
        </button>
      </div>
      <div class="skills-grid">
        <div
          v-for="skill in skills"
          :key="skill.id"
          class="skill-item"
          :class="{ active: selectedSkill?.id === skill.id }"
          @click="toggleSkill(skill)"
        >
          <div class="skill-item-header">
            <i class="bi bi-lightning-charge-fill"></i>
            <span class="skill-name">{{ skill.name }}</span>
            <span v-if="skill.source === 'user'" class="skill-source">{{ t('ai.userSkill') }}</span>
          </div>
          <div v-if="skill.description" class="skill-desc">{{ skill.description }}</div>
        </div>
        <div v-if="skills.length === 0" class="skills-empty">
          {{ t('ai.noSkills') }}
        </div>
      </div>
    </div>

    <!-- 对话列表面板（与当前连接绑定） -->
    <div v-if="showChatPanel" class="history-panel">
      <div class="history-panel-header">
        <span>{{ t('ai.chatsForConnection') }}</span>
        <div class="d-flex align-items-center gap-1">
          <button class="btn-ai-action" @click="newChat" :title="t('ai.newChat')">
            <i class="bi bi-plus-lg"></i>
          </button>
          <button class="btn-ai-action" @click="showChatPanel = false">
            <i class="bi bi-x"></i>
          </button>
        </div>
      </div>
      <div class="history-list">
        <div
          v-for="c in chatList"
          :key="c.id"
          class="history-item"
          :class="{ active: c.id === currentChatId }"
          @click="switchChat(c.id)"
        >
          <div class="history-item-top">
            <span class="history-name text-truncate">{{ c.title || t('ai.unnamedChat') }}</span>
            <span class="history-time">{{ formatTime(c.updatedAt) }}</span>
          </div>
          <div class="history-preview">{{ c.preview || '—' }}</div>
          <div class="history-meta d-flex justify-content-between align-items-center">
            <span>
              {{ c.messageCount }} {{ t('ai.messages') }}
              <template v-if="chatModelLabel(c)"> · {{ chatModelLabel(c) }}</template>
              <template v-if="c.totalTokens"> · {{ formatTokens(c.totalTokens) }}</template>
            </span>
            <button class="chat-delete-btn" @click.stop="removeChat(c)" :title="t('ai.deleteChat')">
              <i class="bi bi-trash"></i>
            </button>
          </div>
        </div>
        <div v-if="chatList.length === 0" class="history-empty">
          {{ t('ai.noChats') }}
        </div>
      </div>
    </div>

    <!-- 成本面板：本对话 / 今日 / auto 节省 / 预算 -->
    <div v-if="showCostPanel" class="history-panel cost-panel">
      <div class="history-panel-header">
        <span>{{ t('ai.costTitle') }}</span>
        <div class="d-flex align-items-center gap-1">
          <button class="btn-ai-action" @click="refreshInsights" :title="t('ai.refresh')">
            <i class="bi bi-arrow-clockwise" :class="{ spin: loadingInsights }"></i>
          </button>
          <button class="btn-ai-action" @click="showCostPanel = false">
            <i class="bi bi-x"></i>
          </button>
        </div>
      </div>
      <div class="cost-body">
        <div class="cost-row">
          <span>{{ t('ai.costChat') }}</span>
          <strong>{{ formatTokens(insights?.chat?.totalTokens || 0) }} · {{ formatUsd(insights?.chat?.costUsd) }}</strong>
        </div>
        <div class="cost-row">
          <span>{{ t('ai.costToday') }}</span>
          <strong>{{ formatTokens(insights?.today?.totalTokens || 0) }} · {{ formatUsd(insights?.today?.costUsd) }}</strong>
        </div>
        <div v-if="insights?.savedUsd != null && insights.savedUsd > 0" class="cost-row saved">
          <span>{{ t('ai.costSaved') }}</span>
          <strong>{{ formatUsd(insights.savedUsd) }}</strong>
        </div>
        <div v-if="insights?.partial" class="cost-hint">{{ t('ai.costPartial') }}</div>

        <div class="cost-subtitle">{{ t('ai.costBudget') }}</div>
        <div class="cost-row">
          <span>{{ t('ai.budgetChatLimit') }}</span>
          <strong>{{ limitText(insights?.budget?.chatTokenLimit) }}</strong>
        </div>
        <div class="cost-row">
          <span>{{ t('ai.budgetDailyLimit') }}</span>
          <strong>{{ limitText(insights?.budget?.dailyTokenLimit) }}</strong>
        </div>
        <div class="cost-row">
          <span>{{ t('ai.budgetCostLimit') }}</span>
          <strong>{{ insights?.budget?.dailyCostLimit ? formatUsd(insights?.budget?.dailyCostLimit) : t('ai.unlimited') }}</strong>
        </div>

        <template v-if="insights?.byModel?.length">
          <div class="cost-subtitle">{{ t('ai.costByModel') }}</div>
          <div v-for="m in insights.byModel" :key="m.modelId" class="cost-model-row">
            <span class="text-truncate">{{ m.modelLabel }}</span>
            <span class="cost-model-num">{{ formatTokens(m.totalTokens) }} · {{ formatUsd(m.costUsd) }}</span>
          </div>
        </template>
        <div v-else class="cost-hint">{{ t('ai.costNoData') }}</div>
      </div>
    </div>

    <!-- 审计面板 (Audit 模式) -->
    <div v-show="activeTab === 'audit'" class="ai-audit-wrapper">
      <AuditPanel ref="auditPanelRef" />
    </div>

    <!-- 日志监控面板 (Monitor 模式) -->
    <div v-show="activeTab === 'monitor'" class="ai-audit-wrapper">
      <LogMonitor ref="logMonitorRef" :sessionId="props.sessionId" :connectionId="props.connectionId" @ws-send="(msg: any) => emit('ws-send', msg)" />
    </div>

    <!-- 已选 Skill 标签 -->
    <div v-if="selectedSkill && activeTab === 'chat'" class="selected-skill-bar">
      <div class="selected-skill-tag">
        <i class="bi bi-lightning-charge-fill"></i>
        <span>{{ selectedSkill.name }}</span>
        <button @click="clearSelectedSkill" class="skill-remove">
          <i class="bi bi-x"></i>
        </button>
      </div>
    </div>

    <!-- 输入区域 -->
    <div v-show="activeTab === 'chat'" class="ai-chat-input">
      <!-- 上边缘的拖拽手柄：textarea 原生的 resize 角既看不出来、又被 max-height 卡住，
           这里自己做一条，拖出高度后固定住，双击回到随内容自适应 -->
      <div
        class="ai-input-resizer"
        :title="t('ai.inputResizeHint')"
        @pointerdown="onInputResizeStart"
        @pointermove="onInputResizeMove"
        @pointerup="onInputResizeEnd"
        @pointercancel="onInputResizeEnd"
        @dblclick="resetInputHeight"
      ></div>
      <button class="btn-skill-toggle" @click="toggleSkillsPanel" :title="t('ai.skills')" :class="{ active: showSkillsPanel }">
        <i class="bi bi-lightning-charge"></i>
      </button>
      <textarea
        ref="inputRef"
        v-model="inputText"
        :placeholder="t('ai.inputPlaceholder')"
        @keydown.enter.exact="onEnterKey"
        @keydown.shift.enter="handleNewLine"
        @input="handleInput"
        rows="1"
        :disabled="isAgentRunning"
      ></textarea>
      <button 
        class="btn-send" 
        @click="handleSend"
        :disabled="!inputText.trim() || isAgentRunning"
      >
        <i class="bi bi-send-fill"></i>
      </button>
    </div>

    <!-- AI 面板右键菜单：跨源 webview 下原生右键菜单可能不出现/复制无效，自建以保证可用 -->
    <div
      v-if="contextMenuVisible"
      class="ai-msg-context-menu"
      :style="{ left: contextMenuX + 'px', top: contextMenuY + 'px' }"
      @click.stop
    >
      <div v-if="contextMenuSelection" class="ctx-item" @click="copySelectionFromMenu">
        <i class="bi bi-clipboard-check"></i> 复制
      </div>
      <div v-if="contextMenuMsgIndex >= 0" class="ctx-item" @click="copyMessageFromMenu">
        <i class="bi bi-copy"></i> 复制消息
      </div>
      <div v-if="contextMenuMsgIndex >= 0 || contextMenuInEditable" class="ctx-item" @click="selectAllFromMenu">
        <i class="bi bi-check2-square"></i> 全选
      </div>
      <div v-if="contextMenuInEditable" class="ctx-item" @click="pasteFromMenu">
        <i class="bi bi-clipboard-plus"></i> 粘贴
      </div>
    </div>
  </div>
</template>

<script lang="ts" setup>
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue';
import { useI18n } from 'vue-i18n';
import * as aiService from '@/service/ai';
import AuditPanel from '@/components/audit-panel/index.vue';
import LogMonitor from '@/components/log-monitor/index.vue';
import { escapeHtml, sanitizeHtml } from '@/utils/sanitize-html';
import { readClipboard } from '@/utils/vscode-clipboard';
import { toast } from '@/utils/toast';
import { modal } from '@/utils/modal';
import { subscribe, unsubscribe, AI_PROFILES_CHANGED } from '@/base/eventBus';

const { t, locale } = useI18n();

const props = defineProps<{
  sessionId: string;
  sessionName?: string;
  connectionId?: string;
  isOpen: boolean;
  getTerminalContext?: () => string;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'ws-send', msg: any): void;
  (e: 'open-settings'): void;
  (e: 'terminal-command', payload: { command: string; execute: boolean }): void;
}>();

// Skill 接口
interface SkillItem {
  id: string;
  name: string;
  description: string;
  tags: string[];
  source: 'system' | 'user';
}

// Agent 步骤接口
interface AgentStep {
  type: 'thinking' | 'tool_call' | 'tool_result' | 'message';
  tool?: string;
  args?: any;
  result?: string;
  content?: string;
  collapsed?: boolean;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  agentSteps?: AgentStep[];
  isRunning?: boolean;
  skillName?: string;
  /** 产生该消息时选中的 Skill ID（用于失败重试） */
  skillId?: string;
  isSystemInfo?: boolean;
  /** 本次回复总耗时（毫秒） */
  durationMs?: number;
  /** 本次回复 token 消耗总数 */
  tokens?: number;
  /** 本次回复是否以错误结束（显示重试按钮） */
  isError?: boolean;
  /** 本轮实际使用的模型名（Auto 下每轮可能不同） */
  modelLabel?: string;
  /** 本轮是否由 Auto 自动选型 */
  autoRouted?: boolean;
}

const activeTab = ref<'chat' | 'audit' | 'monitor'>('chat');
const messagesContainer = ref<HTMLElement>();
const inputRef = ref<HTMLTextAreaElement>();
const auditPanelRef = ref<InstanceType<typeof AuditPanel>>();
const logMonitorRef = ref<InstanceType<typeof LogMonitor>>();
const inputText = ref('');
const isAgentRunning = ref(false);
const messages = ref<ChatMessage[]>([]);

// 执行耗时统计：用于显示「生成中 / 执行较慢」状态
const agentStartTime = ref(0);
const now = ref(Date.now());
let elapsedTimer: ReturnType<typeof setInterval> | null = null;

const elapsedText = computed(() => {
  if (!agentStartTime.value) return '';
  const sec = Math.floor((now.value - agentStartTime.value) / 1000);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`;
});

// 超过 30s 视为执行较慢，提示用户可停止
const isRunningLong = computed(() => {
  if (!agentStartTime.value) return false;
  return now.value - agentStartTime.value > 30000;
});

function startElapsedTimer() {
  stopElapsedTimer();
  now.value = Date.now();
  elapsedTimer = setInterval(() => { now.value = Date.now(); }, 1000);
}
function stopElapsedTimer() {
  if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
}

function hasThinkingStep(msg: ChatMessage): boolean {
  return !!(msg.agentSteps && msg.agentSteps.some(s => s.type === 'thinking'));
}

// Skills 相关
const skills = ref<SkillItem[]>([]);
const selectedSkill = ref<SkillItem | null>(null);
const showSkillsPanel = ref(false);

// 模型配置与对话列表
const AUTO_MODEL_ID = aiService.AUTO_MODEL_ID;
const profiles = ref<aiService.AIProfile[]>([]);
const usableProfiles = computed(() => profiles.value.filter(p => p.enabled && p.apiKey));
const selectedModelId = ref<string>(AUTO_MODEL_ID);
const showChatPanel = ref(false);
/** 成本面板：与对话列表占同一个浮层位置，所以两者互斥 */
const showCostPanel = ref(false);
const insights = ref<aiService.CostInsights | null>(null);
const loadingInsights = ref(false);
const chatList = ref<aiService.AIChatMeta[]>([]);
/** 当前对话（存储 key）；空表示还没落库的新对话，首次发送时才创建 */
const currentChatId = ref('');
/** 模型配置变更的全局事件订阅 id */
let profilesEventId: string | symbol | null = null;

const currentChatTitle = computed(() => {
  const item = chatList.value.find((c) => c.id === currentChatId.value);
  return item?.title || t('ai.unnamedChat');
});

const selectedModelHint = computed(() => {
  if (selectedModelId.value === AUTO_MODEL_ID) return t('ai.autoHint');
  const p = usableProfiles.value.find((x) => x.id === selectedModelId.value);
  return p ? modelOptionText(p) : t('ai.selectModel');
});

/**
 * 下拉项文案：自定义名称 + 实际模型 ID。
 * 只写名称时看不出用的是哪个模型（同名配置换了模型界面毫无变化）；
 * 而后端保存时 label 常与 model 相同，所以要判重，避免出现「gpt-4o · gpt-4o」。
 */
function modelOptionText(p: aiService.AIProfile): string {
  const label = (p.label || '').trim();
  const model = (p.model || '').trim();
  if (!label) return model;
  if (!model || label === model) return label;
  return `${label} · ${model}`;
}

/** 对话条目上显示的模型：auto 或某个配置的名字 */
function chatModelLabel(chat: aiService.AIChatMeta): string {
  if (!chat.modelId || chat.modelId === AUTO_MODEL_ID) return t('ai.autoBadge');
  const p = profiles.value.find((x) => x.id === chat.modelId);
  return p ? p.label || p.model : '';
}

// 当前正在构建的 assistant 消息
let currentAssistantIdx = -1;

function ensureAssistantMessage(): number {
  if (currentAssistantIdx >= 0 && currentAssistantIdx < messages.value.length) {
    return currentAssistantIdx;
  }
  const msg: ChatMessage = {
    role: 'assistant',
    content: '',
    agentSteps: [],
    isRunning: true,
  };
  messages.value.push(msg);
  currentAssistantIdx = messages.value.length - 1;
  return currentAssistantIdx;
}

// 处理 Agent 事件（由父组件调用）
function handleAgentEvent(event: any) {
  // system_info 作为独立消息展示，不进入 assistant 消息流
  if (event.type === 'system_info') {
    messages.value.push({
      role: 'assistant',
      content: event.content || '',
      isSystemInfo: true,
      isRunning: false,
    });
    nextTick(() => scrollToBottom());
    return;
  }

  const idx = ensureAssistantMessage();
  const msg = messages.value[idx];
  if (!msg.agentSteps) msg.agentSteps = [];

  switch (event.type) {
    case 'model_selected':
      // 服务端每轮挑定模型后会先发这条，告知本轮用的是哪个（Auto 会换）
      msg.modelLabel = event.modelLabel || event.modelId || '';
      msg.autoRouted = !!event.route;
      break;

    case 'thinking':
      // 移除旧的 thinking 步骤（如果有）
      msg.agentSteps = msg.agentSteps.filter(s => s.type !== 'thinking');
      msg.agentSteps.push({ type: 'thinking' });
      break;

    case 'message':
      // 移除 thinking
      msg.agentSteps = msg.agentSteps.filter(s => s.type !== 'thinking');
      // 追加文本内容
      msg.content += event.content || '';
      break;

    case 'tool_call':
      // 移除 thinking
      msg.agentSteps = msg.agentSteps.filter(s => s.type !== 'thinking');
      msg.agentSteps.push({
        type: 'tool_call',
        tool: event.tool,
        args: event.args,
        collapsed: true, // 默认折叠，节省空间
      });
      break;

    case 'tool_result':
      // 找到最近的对应工具的 tool_call 步骤
      for (let i = msg.agentSteps.length - 1; i >= 0; i--) {
        if (msg.agentSteps[i].type === 'tool_call' && msg.agentSteps[i].tool === event.tool && !msg.agentSteps[i].result) {
          msg.agentSteps[i].result = event.result;
          // 保持折叠状态，用户可手动展开
          break;
        }
      }
      break;

    case 'done':
      msg.isRunning = false;
      msg.agentSteps = msg.agentSteps.filter(s => s.type !== 'thinking');
      msg.durationMs = agentStartTime.value ? Date.now() - agentStartTime.value : undefined;
      msg.tokens = event.usage?.totalTokens;
      if (event.content) {
        const c = event.content;
        // 部分 engine 在流式结束后又于 done 中重发全文，避免与已流式内容重复
        if (msg.content.includes(c)) {
          // 已包含完整内容，跳过
        } else if (c.startsWith(msg.content)) {
          // done 是流式的超集（末尾追加），用全文替换，避免重复前缀
          msg.content = c;
        } else {
          msg.content += c;
        }
      }
      isAgentRunning.value = false;
      stopElapsedTimer();
      currentAssistantIdx = -1;
      saveDisplayHistory();
      // 本轮的 token/金额刚记完账，面板开着就地刷新，用户不用自己点
      if (showCostPanel.value) void refreshInsights();
      break;

    case 'audit_entry':
      // 转发审计条目到审计面板
      if (event.auditEntry && auditPanelRef.value) {
        auditPanelRef.value.addRealtimeEntry(event.auditEntry);
      }
      return; // 不影响聊天消息流

    case 'error':
      msg.isRunning = false;
      msg.agentSteps = msg.agentSteps.filter(s => s.type !== 'thinking');
      msg.durationMs = agentStartTime.value ? Date.now() - agentStartTime.value : undefined;
      msg.isError = true;
      // 预算拦截带 code：用界面语言说清楚是哪一项超了，其余错误照旧回显服务端原文
      msg.content += `\n\n**${t('ai.errorLabel')}**: ${budgetErrorMessage(event.code) || event.error || t('ai.unknownError')}`;
      if (showCostPanel.value) void refreshInsights();
      isAgentRunning.value = false;
      stopElapsedTimer();
      currentAssistantIdx = -1;
      saveDisplayHistory();
      break;
  }

  scrollToBottom();
}

// 加载 Skills 列表
async function loadSkills() {
  try {
    const data = await aiService.getSkills();
    if (Array.isArray(data)) {
      skills.value = data;
    }
  } catch (e) {
    console.warn('Failed to load skills:', e);
  }
}

function toggleSkillsPanel() {
  showSkillsPanel.value = !showSkillsPanel.value;
}

function toggleSkill(skill: SkillItem) {
  if (selectedSkill.value?.id === skill.id) {
    selectedSkill.value = null;
  } else {
    selectedSkill.value = skill;
  }
  showSkillsPanel.value = false;
}

function clearSelectedSkill() {
  selectedSkill.value = null;
}

// 斜杠命令检测
function handleInput() {
  const text = inputText.value;
  if (text.startsWith('/') && !text.includes(' ')) {
    // 正在输入斜杠命令，尝试匹配
    const cmd = text.substring(1).toLowerCase();
    const match = skills.value.find(s => s.id.toLowerCase() === cmd);
    if (match) {
      selectedSkill.value = match;
      inputText.value = '';
    }
  }
}

/* ---------------- 输入框高度：默认随内容增高，也可以拖住上边缘固定高度 ---------------- */

/** 与 CSS 的 min-height 保持一致 */
const INPUT_MIN_HEIGHT = 40;
/** 输入区上方至少留给消息列表的高度 */
const INPUT_TOP_RESERVE = 140;
/** 用户拖出来的高度；0 表示跟随内容自适应 */
const manualInputHeight = ref(0);
let resizeStartY = 0;
let resizeStartHeight = 0;

/** 最高到窗口 70% 与「面板高度 - 消息区预留」中的较小者，别把消息区挤没 */
function maxInputHeight(): number {
  const panel = (inputRef.value?.closest('.ai-chat-panel') as HTMLElement | null) ?? null;
  const panelHeight = panel?.clientHeight || window.innerHeight;
  const limit = Math.min(Math.round(window.innerHeight * 0.7), panelHeight - INPUT_TOP_RESERVE);
  return Math.max(INPUT_MIN_HEIGHT * 2, limit);
}

function applyInputHeight(height: number) {
  const el = inputRef.value;
  if (!el) return;
  // 向上取整：亚像素高度会让内容多出半行，滚动条每帧一隐形地闪
  el.style.height = `${Math.ceil(height)}px`;
}

/**
 * 按内容同步输入框高度：单行时贴底，多行时逐行长高。
 * 先归零再读 scrollHeight——只有 height:auto 时读到的才是完整内容高度，
 * 否则拿到的是被当前高度截断后的值。
 */
function autoGrowInput() {
  // 用户拖过高度就完全按他拖的来：内容变化不再动高度，否则一输入就被压回内容高度
  if (manualInputHeight.value > 0) {
    applyInputHeight(Math.min(manualInputHeight.value, maxInputHeight()));
    return;
  }

  const el = inputRef.value;
  if (!el) return;
  // v-show 隐藏时 scrollHeight 为 0，此时量高度会把多行内容压成一行
  if (!el.offsetParent) return;

  el.style.height = 'auto';
  // 全局是 border-box，而 scrollHeight 不含边框，差这一点会每帧多出一条滚动条
  const border = el.offsetHeight - el.clientHeight;
  const contentHeight = el.scrollHeight + border;
  const target = Math.min(Math.max(contentHeight, INPUT_MIN_HEIGHT), maxInputHeight());
  applyInputHeight(target);
}

/** 按住上边缘往上拖 = 变高；指针捕获让拖到输入区外面也还能继续拖 */
function onInputResizeStart(e: PointerEvent) {
  const el = inputRef.value;
  const handle = e.currentTarget as HTMLElement | null;
  if (!el || !handle) return;
  e.preventDefault();
  handle.setPointerCapture?.(e.pointerId);
  resizeStartY = e.clientY;
  resizeStartHeight = el.offsetHeight;
}

function onInputResizeMove(e: PointerEvent) {
  if (!(e.currentTarget as HTMLElement | null)?.hasPointerCapture?.(e.pointerId)) return;
  const next = resizeStartHeight + (resizeStartY - e.clientY);
  manualInputHeight.value = Math.min(Math.max(Math.round(next), INPUT_MIN_HEIGHT), maxInputHeight());
  applyInputHeight(manualInputHeight.value);
}

function onInputResizeEnd(e: PointerEvent) {
  const handle = e.currentTarget as HTMLElement | null;
  handle?.releasePointerCapture?.(e.pointerId);
  // 拖回最矮等同于放弃固定高度，重新跟随内容
  if (manualInputHeight.value <= INPUT_MIN_HEIGHT) resetInputHeight();
}

/** 双击手柄：回到随内容自适应 */
function resetInputHeight() {
  manualInputHeight.value = 0;
  nextTick(autoGrowInput);
}

/** Enter 发送；输入法选词时的 Enter 是确认候选词，不能当成发送 */
function onEnterKey(e: KeyboardEvent) {
  // keyCode 229 是部分输入法在组合期间的兼容标记，isComposing 未必为 true
  if (e.isComposing || e.keyCode === 229) return;
  e.preventDefault();
  handleSend();
}

// 输入 / 清空 / 命令回填都会改变内容，高度跟着重新量
watch(inputText, () => nextTick(autoGrowInput));
// 从其他标签页切回来时元素才可见，隐藏时量不出真实高度
watch(activeTab, (tab) => { if (tab === 'chat') nextTick(autoGrowInput); });

// 发送消息
function handleSend() {
  const text = inputText.value.trim();
  if (!text || isAgentRunning.value) return;

  // 检查斜杠命令（带后续文本的情况：/skill-id 补充说明）
  let actualMessage = text;
  let activeSkill = selectedSkill.value;
  
  if (text.startsWith('/')) {
    const spaceIdx = text.indexOf(' ');
    const cmd = (spaceIdx > 0 ? text.substring(1, spaceIdx) : text.substring(1)).toLowerCase();
    const match = skills.value.find(s => s.id.toLowerCase() === cmd);
    if (match) {
      activeSkill = match;
      actualMessage = spaceIdx > 0 ? text.substring(spaceIdx + 1).trim() : match.description || match.name;
      if (!actualMessage) actualMessage = match.name;
    }
  }

  // 添加用户消息
  messages.value.push({
    role: 'user',
    content: actualMessage,
    skillName: activeSkill?.name,
    skillId: activeSkill?.id,
  });
  inputText.value = '';
  scrollToBottom();

  runAgent(actualMessage, activeSkill);

  // 发送后清除选中的 Skill
  selectedSkill.value = null;
}

/** 启动 Agent 执行（handleSend 与失败重试共用） */
async function runAgent(message: string, skill?: SkillItem | null) {
  const context = props.getTerminalContext?.() || '';

  isAgentRunning.value = true;
  agentStartTime.value = Date.now();
  startElapsedTimer();
  currentAssistantIdx = -1;

  let chatId = '';
  try {
    chatId = await ensureChat();
  } catch (e: any) {
    isAgentRunning.value = false;
    stopElapsedTimer();
    toast.error(e?.message || t('ai.agentError'));
    return;
  }

  emit('ws-send', {
    type: 'ai-agent-run',
    data: {
      // aiSessionId = 命令真正执行的终端；chatId = 这一轮属于哪个对话
      aiSessionId: props.sessionId,
      chatId,
      modelId: selectedModelId.value,
      message,
      context: context.substring(-3000),
      skillId: skill?.id,
      locale: locale.value,
    },
  });
}

/** 失败重试：重发该助手消息之前最近的一条用户消息 */
function retryMessage(index: number) {
  if (isAgentRunning.value) return;
  for (let i = index - 1; i >= 0; i--) {
    const m = messages.value[i];
    if (m.role === 'user' && !m.isSystemInfo) {
      const skill = m.skillId ? skills.value.find(s => s.id === m.skillId) || null : null;
      // 隐藏原错误消息的重试按钮，避免同一消息出现多个重试入口
      messages.value[index].isError = false;
      messages.value.push({
        role: 'user',
        content: m.content,
        skillName: m.skillName,
        skillId: m.skillId,
      });
      scrollToBottom();
      runAgent(m.content, skill);
      return;
    }
  }
}

function handleStop() {
  emit('ws-send', {
    type: 'ai-agent-stop',
    data: { aiSessionId: props.sessionId, chatId: currentChatId.value || undefined },
  });
}

function handleNewLine() {
  // Shift+Enter 换行
}

function handleClear() {
  if (messages.value.length === 0) return;
  messages.value = [];
  currentAssistantIdx = -1;
  if (!currentChatId.value) return;
  // 只清当前对话；面板里的摘要同步复位，避免还显示旧预览
  aiService.clearHistory(currentChatId.value).catch(() => {});
  const item = chatList.value.find((c) => c.id === currentChatId.value);
  if (item) {
    item.messageCount = 0;
    item.preview = '';
  }
}

// 保存对话显示历史到服务端（按对话存，不按终端会话）
function saveDisplayHistory() {
  const chatId = currentChatId.value;
  if (!chatId) return;
  const toSave = messages.value.map(m => ({
    role: m.role,
    content: m.content,
    skillName: m.skillName,
    skillId: m.skillId,
    isSystemInfo: m.isSystemInfo,
    isError: m.isError,
    durationMs: m.durationMs,
    tokens: m.tokens,
    agentSteps: m.agentSteps?.filter(s => s.type === 'tool_call').map(s => ({
      type: 'tool_call' as const,
      tool: s.tool,
      args: s.args,
      result: s.result,
      collapsed: true,
    })),
  }));
  aiService.saveDisplayHistory(chatId, toSave, props.sessionName)
    .then(() => refreshChatMeta(chatId, toSave))
    .catch(() => {});
}

/** 保存成功后乐观更新列表条目，并静默拉一次列表以采纳服务端生成的标题 */
function refreshChatMeta(chatId: string, saved: any[]) {
  const item = chatList.value.find((c) => c.id === chatId);
  if (item) {
    item.messageCount = saved.length;
    item.updatedAt = Date.now();
    const lastUser = [...saved].reverse().find((m) => m.role === 'user' && !m.isSystemInfo);
    if (lastUser) item.preview = String(lastUser.content).substring(0, 120);
  }
  aiService.listChats(props.connectionId).then((list) => {
    if (Array.isArray(list)) chatList.value = list;
  }).catch(() => {});
}

// 加载某个对话的消息
async function loadDisplayHistory(chatId: string) {
  try {
    const data = await aiService.getDisplayHistory(chatId);
    if (Array.isArray(data) && data.length > 0) {
      messages.value = data.map((m: any) => ({
        role: m.role,
        content: m.content,
        skillName: m.skillName,
        skillId: m.skillId,
        isSystemInfo: m.isSystemInfo,
        isError: m.isError,
        durationMs: m.durationMs,
        tokens: m.tokens,
        modelLabel: m.modelLabel,
        autoRouted: m.autoRouted,
        agentSteps: m.agentSteps?.map((s: any) => ({ ...s, collapsed: true })),
        isRunning: false,
      }));
      nextTick(() => scrollToBottom());
    } else {
      // 该对话还没消息：顺手把系统环境展示出来，方便直接提问
      await fetchAndShowSystemInfo();
    }
  } catch (e) {
    console.warn('Failed to load display history:', e);
  }
}

/** 主动获取系统环境信息并展示为第一条消息 */
async function fetchAndShowSystemInfo() {
  // 没绑终端时不去拉环境信息：服务端拿不到会话会回落成「跑服务的那台机器」，
  // 把它当成用户的环境报上去比不报更坑
  if (!props.sessionId) return;
  try {
    const sysContext = await aiService.getSystemContext(props.sessionId);
    if (sysContext && typeof sysContext === 'string' && sysContext.trim()) {
      messages.value.push({
        role: 'assistant',
        content: sysContext,
        isSystemInfo: true,
        isRunning: false,
      });
      nextTick(() => scrollToBottom());
    }
  } catch (e) {
    console.warn('Failed to fetch system context:', e);
  }
}

// ===== 模型配置 =====
async function loadProfiles() {
  try {
    const list = await aiService.listProfiles();
    profiles.value = Array.isArray(list) ? list : [];
  } catch (e) {
    console.warn('Failed to load AI profiles:', e);
    return;
  }
  // 选中的配置被删/被停用后回退到 Auto，避免发送时拿着一个无效 id
  if (selectedModelId.value === AUTO_MODEL_ID) return;
  if (!usableProfiles.value.some((p) => p.id === selectedModelId.value)) {
    selectedModelId.value = AUTO_MODEL_ID;
    rememberModel();
  }
}

// 用户上次在这个连接上选的模型：按连接记住，下次回来接着用
function modelStorageKey() {
  return `aetherops.ai.model.${props.connectionId || 'default'}`;
}

function readStoredModel(): string {
  try {
    return localStorage.getItem(modelStorageKey()) || AUTO_MODEL_ID;
  } catch {
    return AUTO_MODEL_ID;
  }
}

function rememberModel() {
  try {
    localStorage.setItem(modelStorageKey(), selectedModelId.value);
  } catch {
    /* 无法写本地存储时不影响功能 */
  }
}

// ===== 对话窗口（与连接绑定） =====
function resetChatState() {
  currentChatId.value = '';
  chatList.value = [];
  messages.value = [];
  currentAssistantIdx = -1;
  showChatPanel.value = false;
  selectedModelId.value = readStoredModel();
}

async function initializeChats() {
  await loadProfiles();
  await loadChatList(true);
}

async function loadChatList(autoSelect = false) {
  try {
    const list = await aiService.listChats(props.connectionId);
    chatList.value = Array.isArray(list) ? list : [];
  } catch (e) {
    console.warn('Failed to load chats:', e);
    return;
  }
  if (!autoSelect) return;
  // 回到这个连接时直接恢复最近一个对话，用户也可以再开面板挑别的
  const latest = chatList.value[0];
  if (latest) {
    await openChat(latest);
  } else {
    currentChatId.value = '';
    messages.value = [];
    currentAssistantIdx = -1;
    await fetchAndShowSystemInfo();
  }
}

async function openChat(chat: aiService.AIChatMeta) {
  currentChatId.value = chat.id;
  selectedModelId.value = chat.modelId || AUTO_MODEL_ID;
  rememberModel();
  messages.value = [];
  currentAssistantIdx = -1;
  showChatPanel.value = false;
  await loadDisplayHistory(chat.id);
}

async function switchChat(chatId: string) {
  // 运行中切走会让流式输出落到别的窗口里，直接不切
  if (isAgentRunning.value) return;
  const target = chatList.value.find((c) => c.id === chatId);
  if (!target) return;
  if (target.id === currentChatId.value) {
    showChatPanel.value = false;
    return;
  }
  await openChat(target);
}

/** 新建对话：先不落库，首次发送时才建行，避免列表里堆一堆空对话 */
function newChat() {
  if (isAgentRunning.value) return;
  currentChatId.value = '';
  messages.value = [];
  currentAssistantIdx = -1;
  showChatPanel.value = false;
  fetchAndShowSystemInfo();
}

async function removeChat(chat: aiService.AIChatMeta) {
  const title = chat.title || t('ai.unnamedChat');
  const ok = await modal.confirm(t('ai.deleteChatConfirm', { title }));
  if (!ok) return;
  try {
    await aiService.deleteChat(chat.id);
    toast.success(t('ai.chatDeleted'));
    chatList.value = chatList.value.filter((c) => c.id !== chat.id);
    if (currentChatId.value === chat.id) newChat();
  } catch (e: any) {
    toast.error(e?.message || t('ai.chatDeleted'));
  }
}

/** 本轮的存储 key：已有对话就用它，否则当场建一个并记住 */
async function ensureChat(): Promise<string> {
  if (currentChatId.value) return currentChatId.value;
  const created = await aiService.createChat({
    connectionId: props.connectionId || '',
    modelId: selectedModelId.value,
  });
  if (!created?.id) throw new Error('Failed to create chat');
  currentChatId.value = created.id;
  chatList.value = [created, ...chatList.value.filter((c) => c.id !== created.id)];
  return created.id;
}

function toggleChatPanel() {
  showCostPanel.value = false;
  showChatPanel.value = !showChatPanel.value;
  if (showChatPanel.value) loadChatList(false);
}

function toggleCostPanel() {
  showChatPanel.value = false;
  showCostPanel.value = !showCostPanel.value;
  if (showCostPanel.value) void refreshInsights();
}

/** 拉一次成本洞察：还没落库的新对话不传 chatId，服务端就只算今日与预算 */
async function refreshInsights() {
  if (loadingInsights.value) return;
  loadingInsights.value = true;
  try {
    insights.value = await aiService.getCostInsights(currentChatId.value || undefined);
  } catch (e) {
    console.warn('Failed to load cost insights:', e);
  } finally {
    loadingInsights.value = false;
  }
}

/** 单轮对话常常不到 1 美分，小于 0.01 时才多留两位小数，否则一律 $0.00 看不出变化 */
function formatUsd(value: number | null | undefined): string {
  if (value === null || value === undefined) return '-';
  if (value <= 0) return '$0';
  return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

/** 预算 0 表示不限，显示成 0 会被误读成「已经用完」 */
function limitText(value: number | null | undefined): string {
  return value ? formatTokens(value) : t('ai.unlimited');
}

/** 预算拦截文案按 code 本地化；返回 null 表示不是预算问题 */
function budgetErrorMessage(code?: string): string | null {
  if (code === 'chat-token-limit') return t('ai.budgetChatLimitHit');
  if (code === 'daily-token-limit') return t('ai.budgetDailyLimitHit');
  if (code === 'daily-cost-limit') return t('ai.budgetDailyCostLimitHit');
  return null;
}

/** 切换本次对话使用的模型，并写回该对话，下次打开保持 */
function handleModelChange() {
  rememberModel();
  const chatId = currentChatId.value;
  if (!chatId) return;
  const item = chatList.value.find((c) => c.id === chatId);
  if (item) item.modelId = selectedModelId.value;
  aiService.updateChat(chatId, { modelId: selectedModelId.value }).catch(() => {});
}

function formatTime(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return t('ai.justNow');
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function handleClose() {
  emit('close');
}

function handleOpenSettings() {
  emit('open-settings');
}

function toggleStep(step: AgentStep) {
  step.collapsed = !step.collapsed;
}

// 消息底部信息：复制 / 耗时 / token 格式化
const copiedIdx = ref(-1);
let copiedTimer: ReturnType<typeof setTimeout> | null = null;

async function copyMessage(msg: ChatMessage, index: number) {
  const ok = await copyPlainText(msg.content);
  if (!ok) return;
  copiedIdx.value = index;
  if (copiedTimer) clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => { copiedIdx.value = -1; }, 1500);
}

/** 通用剪贴板写入：clipboard API 优先，失败兜底到隐藏 textarea + execCommand
 * （用户手势内，跨源 webview 通常可用，且不依赖受限的 navigator.clipboard / 异步桥接） */
async function copyPlainText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (e) {
    console.warn('clipboard.writeText failed, fallback to execCommand:', e);
  }
  // 兜底：隐藏 textarea + execCommand
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.left = '0';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    return true;
  } catch (e) {
    console.warn('Failed to copy text:', e);
    return false;
  }
}

// ===== AI 面板右键菜单（跨源 webview 原生右键菜单可能不出现或复制无效，自建以保证可用）=====
const contextMenuVisible = ref(false);
const contextMenuX = ref(0);
const contextMenuY = ref(0);
const contextMenuSelection = ref('');
const contextMenuMsgIndex = ref(-1);
const contextMenuInEditable = ref(false);
let contextMenuTarget: HTMLTextAreaElement | HTMLInputElement | null = null;

const CTX_MENU_W = 170;
const CTX_MENU_H = 120;

/**
 * 弹出右键菜单。
 * 触发以 mousedown(button===2) 为主、contextmenu 为辅：部分 VSCode 系宿主会吞掉
 * contextmenu 事件（既不弹原生菜单也不向页面派发），仅依赖 contextmenu 会完全失效；
 * mousedown 是更底层的事件，右键必定触发。
 */
function showCtxMenuFor(e: MouseEvent) {
  const target = e.target as HTMLElement | null;
  if (!target) return;
  if (!target.closest('.ai-chat-panel')) return; // 仅本面板内生效，不影响终端等其它区域

  const editable = target.closest('textarea, input, [contenteditable="true"]') as
    | HTMLTextAreaElement
    | HTMLInputElement
    | null;
  const msgEl = target.closest('.ai-message') as HTMLElement | null;
  // 诊断日志：若右键后控制台没有任何 [aetherops][ctx] 输出，说明宿主根本没向页面派发右键事件
  console.log('[aetherops][ctx] right-click in ai panel', {
    hasMsg: !!msgEl,
    isEditable: !!editable,
    tag: (target.tagName || '').toLowerCase(),
  });

  contextMenuTarget = editable;
  contextMenuInEditable.value = !!editable;
  if (editable) {
    const st = (editable as any).selectionStart as number | undefined;
    const en = (editable as any).selectionEnd as number | undefined;
    contextMenuSelection.value =
      typeof st === 'number' && typeof en === 'number' && editable.value
        ? editable.value.slice(st, en)
        : '';
  } else {
    contextMenuSelection.value = window.getSelection()?.toString() || '';
  }
  contextMenuMsgIndex.value = msgEl
    ? Number(msgEl.getAttribute('data-msg-index') ?? '-1')
    : -1;

  // 靠近视口右/下边缘时回退，避免菜单被截断
  let x = e.clientX;
  let y = e.clientY;
  if (x + CTX_MENU_W > window.innerWidth) x = Math.max(0, window.innerWidth - CTX_MENU_W);
  if (y + CTX_MENU_H > window.innerHeight) y = Math.max(0, window.innerHeight - CTX_MENU_H);
  contextMenuX.value = x;
  contextMenuY.value = y;
  contextMenuVisible.value = true;
}

function onDocMouseDown(e: MouseEvent) {
  if (e.button !== 2) return; // 仅右键
  showCtxMenuFor(e);
}

function onDocMouseUp(e: MouseEvent) {
  if (e.button !== 2) return; // 仅右键
  // mousedown 可能被宿主吞掉时的兜底触发（幂等，与 mousedown 重复触发无害）
  showCtxMenuFor(e);
}

function onDocContextMenu(e: MouseEvent) {
  const target = e.target as HTMLElement | null;
  if (!target || !target.closest('.ai-chat-panel')) return;
  // 抑制宿主原生菜单，避免与自建菜单冲突（内容由 showCtxMenuFor 填充）
  e.preventDefault();
  showCtxMenuFor(e);
}

function hideCtxMenu() {
  contextMenuVisible.value = false;
  contextMenuSelection.value = '';
  contextMenuMsgIndex.value = -1;
  contextMenuInEditable.value = false;
  contextMenuTarget = null;
}

async function copySelectionFromMenu() {
  const text = contextMenuSelection.value;
  hideCtxMenu();
  if (text) await copyPlainText(text);
}

async function copyMessageFromMenu() {
  const idx = contextMenuMsgIndex.value;
  hideCtxMenu();
  if (idx >= 0 && messages.value[idx]) {
    await copyMessage(messages.value[idx], idx);
  }
}

function selectAllFromMenu() {
  const idx = contextMenuMsgIndex.value;
  const editable = contextMenuTarget;
  hideCtxMenu();
  if (editable) {
    editable.focus();
    editable.select();
    return;
  }
  const el = messagesContainer.value?.querySelector(
    `.ai-message[data-msg-index="${idx}"] .ai-message-text`
  ) as HTMLElement | null;
  if (!el) return;
  const sel = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(el);
  sel?.removeAllRanges();
  sel?.addRange(range);
}

async function pasteFromMenu() {
  const target = contextMenuTarget;
  hideCtxMenu();
  if (!target) return;
  try {
    const text = await readClipboard();
    if (!text) return;
    const start = target.selectionStart ?? target.value.length;
    const end = target.selectionEnd ?? target.value.length;
    target.value = target.value.slice(0, start) + text + target.value.slice(end);
    const pos = start + text.length;
    target.setSelectionRange(pos, pos);
    target.dispatchEvent(new Event('input', { bubbles: true }));
  } catch (e) {
    console.warn('Failed to paste text:', e);
  }
}

function onKeydownHideCtx(e: KeyboardEvent) {
  if (e.key === 'Escape') hideCtxMenu();
}

/** 代码块操作按钮点击（事件委托：v-html 内容无法直接绑定事件） */
function handleMessagesClick(e: MouseEvent) {
  const target = e.target as HTMLElement;
  const btn = target.closest?.('.code-action-btn') as HTMLElement | null;
  if (!btn) return;
  const codeEl = btn.closest('.code-block')?.querySelector('code');
  const command = (codeEl?.textContent || '').trim();
  if (!command) return;
  const action = btn.getAttribute('data-action');
  if (action === 'copy') {
    copyPlainText(command);
  } else if (action === 'insert') {
    emit('terminal-command', { command, execute: false });
  } else if (action === 'run') {
    emit('terminal-command', { command, execute: true });
  }
}

function formatDuration(ms: number): string {
  const sec = ms / 1000;
  if (sec < 10) return `${sec.toFixed(1)}s`;
  if (sec < 60) return `${Math.round(sec)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  if (tokens < 1000000) return `${(tokens / 1000).toFixed(1)}K`;
  return `${(tokens / 1000000).toFixed(1)}M`;
}

/** 当前会话 token 累计（全部消息 tokens 之和，含加载的历史） */
const sessionTokens = computed(() => messages.value.reduce((sum, m) => sum + (m.tokens || 0), 0));

function getToolDisplayCmd(step: AgentStep): string {
  if (step.tool === 'execute_command' && step.args?.command) {
    const cmd = step.args.command;
    return cmd.length > 40 ? cmd.substring(0, 40) + '...' : cmd;
  }
  if (step.tool === 'read_terminal') {
    return 'read terminal output';
  }
  return step.tool || 'unknown';
}

// Markdown 渲染
function renderMarkdown(text: string): string {
  if (typeof text !== 'string') return String(text ?? '');
  if (!text) return '';

  // 先提取代码块，防止内部内容被误处理
  const codeBlocks: string[] = [];
  let html = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push(
      `<pre class="code-block">` +
      `<span class="code-actions">` +
      `<button class="code-action-btn" data-action="run" title="${t('ai.executeCommand')}" aria-label="${t('ai.executeCommand')}"><i class="bi bi-play-fill"></i></button>` +
      `<button class="code-action-btn" data-action="insert" title="${t('ai.insertToTerminal')}" aria-label="${t('ai.insertToTerminal')}"><i class="bi bi-terminal"></i></button>` +
      `<button class="code-action-btn" data-action="copy" title="${t('ai.copyCode')}" aria-label="${t('ai.copyCode')}"><i class="bi bi-copy"></i></button>` +
      `</span>` +
      `<code class="language-${lang}">${escapeHtml(code.trim())}</code>` +
      `</pre>`
    );
    return `\x00CODEBLOCK${idx}\x00`;
  });

  // 处理表格
  html = html.replace(/((?:^|\n)\|.+\|(?:\n\|.+\|)+)/g, (tableBlock) => {
    const rows = tableBlock.trim().split('\n').filter(r => r.trim());
    if (rows.length < 2) return tableBlock;
    let table = '<table class="md-table">';
    rows.forEach((row, ri) => {
      // 跳过分隔行 (|---|---|)
      if (/^\|[\s\-:|]+\|$/.test(row.trim())) return;
      const cells = row.split('|').filter((_, i, arr) => i > 0 && i < arr.length - 1);
      const tag = ri === 0 ? 'th' : 'td';
      table += '<tr>' + cells.map(c => `<${tag}>${c.trim()}</${tag}>`).join('') + '</tr>';
    });
    table += '</table>';
    return '\n' + table + '\n';
  });

  // 标题
  html = html.replace(/^### (.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^## (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^# (.+)$/gm, '<h2>$1</h2>');

  // 粗体 / 斜体
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');

  // 行内代码
  html = html.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');

  // 链接
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

  // 无序列表
  html = html.replace(/(^|\n)((?:[-*] .+(?:\n|$))+)/g, (_, pre, block) => {
    const items = block.trim().split('\n')
      .map((l: string) => `<li>${l.replace(/^[-*] /, '')}</li>`).join('');
    return pre + `<ul>${items}</ul>`;
  });

  // 有序列表
  html = html.replace(/(^|\n)((?:\d+\. .+(?:\n|$))+)/g, (_, pre, block) => {
    const items = block.trim().split('\n')
      .map((l: string) => `<li>${l.replace(/^\d+\. /, '')}</li>`).join('');
    return pre + `<ol>${items}</ol>`;
  });

  // 换行
  html = html.replace(/\n/g, '<br>');

  // 恢复代码块
  html = html.replace(/\x00CODEBLOCK(\d+)\x00/g, (_, idx) => codeBlocks[parseInt(idx)]);

  return sanitizeHtml(html);
}

function scrollToBottom() {
  nextTick(() => {
    if (messagesContainer.value) {
      messagesContainer.value.scrollTop = messagesContainer.value.scrollHeight;
    }
  });
}

/** 处理监控事件（由父组件调用） */
function handleMonitorEvent(event: any) {
  if (logMonitorRef.value) {
    logMonitorRef.value.handleMonitorEvent(event);
  }
}

watch(() => props.isOpen, (val) => {
  if (val) {
    nextTick(() => {
      autoGrowInput();
      inputRef.value?.focus();
      scrollToBottom();
    });
    // 重新打开面板时刷一下列表：可能在别的标签页里新建过对话
    loadChatList(false);
  }
});

// 对话跟「连接」走而不是跟终端会话走：重连 / 换终端不应把对话切掉
watch(() => props.connectionId, () => {
  resetChatState();
  initializeChats();
}, { immediate: true });

onMounted(() => {
  if (props.isOpen) inputRef.value?.focus();
  // 多行输入：首次挂载就量一次高度
  autoGrowInput();
  // 窗口高度变了，上限跟着变
  window.addEventListener('resize', autoGrowInput);
  loadSkills();
  // 设置页增删模型后同步选择器
  profilesEventId = subscribe(AI_PROFILES_CHANGED, () => { loadProfiles(); });
  // 捕获阶段注册：mousedown 为主（宿主可能吞掉 contextmenu），contextmenu 用于抑制原生菜单
  document.addEventListener('mousedown', onDocMouseDown as EventListener, true);
  document.addEventListener('mouseup', onDocMouseUp as EventListener, true);
  document.addEventListener('contextmenu', onDocContextMenu as EventListener, true);
  document.addEventListener('click', hideCtxMenu);
  document.addEventListener('keydown', onKeydownHideCtx);
  messagesContainer.value?.addEventListener('scroll', hideCtxMenu);
});

onUnmounted(() => {
  stopElapsedTimer();
  window.removeEventListener('resize', autoGrowInput);
  if (copiedTimer) { clearTimeout(copiedTimer); copiedTimer = null; }
  if (profilesEventId) unsubscribe(profilesEventId);
  document.removeEventListener('mousedown', onDocMouseDown as EventListener, true);
  document.removeEventListener('mouseup', onDocMouseUp as EventListener, true);
  document.removeEventListener('contextmenu', onDocContextMenu as EventListener, true);
  document.removeEventListener('click', hideCtxMenu);
  document.removeEventListener('keydown', onKeydownHideCtx);
});

defineExpose({ handleAgentEvent, scrollToBottom, handleMonitorEvent });
</script>

<style scoped>
.ai-chat-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg-dark);
  border-left: 1px solid var(--border-color);
}
.ai-chat-panel.collapsed { display: none; }

.ai-chat-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border-color);
  background: rgb(var(--bg-input-rgb) / 50%);
}

.btn-ai-action {
  background: none;
  border: none;
  color: var(--text-secondary);
  padding: 4px 8px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 14px;
  transition: all 0.15s;
}
.btn-ai-action:hover {
  background: rgb(var(--overlay-rgb) / 10%);
  color: var(--text-primary);
}
.btn-ai-action.btn-stop { color: var(--danger); }
.btn-ai-action.btn-stop:hover { color: var(--danger); background: rgb(var(--danger-rgb) / 10%); }

.ai-chat-messages {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.ai-chat-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: var(--text-secondary);
  text-align: center;
}
.ai-chat-empty p { margin-top: 12px; font-size: 13px; }

.ai-message {
  display: flex;
  gap: 12px;
  max-width: 100%;
}
.ai-message.user { flex-direction: row-reverse; }

.ai-message-avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  font-size: 16px;
}
.ai-message.user .ai-message-avatar { background: var(--accent); color: var(--accent-fg); }
.ai-message.assistant .ai-message-avatar { background: rgb(var(--success-rgb) / 20%); color: var(--success); }

.ai-message-content {
  max-width: calc(100% - 48px);
  padding: 10px 14px;
  border-radius: 12px;
  font-size: 13px;
  line-height: 1.5;
}
.ai-message.user .ai-message-content {
  background: var(--accent);
  color: var(--accent-fg);
  border-top-right-radius: 4px;
}
.ai-message.assistant .ai-message-content {
  background: rgb(var(--border-strong-rgb) / 50%);
  color: var(--text-primary);
  border-top-left-radius: 4px;
}

.ai-message-text :deep(.code-block) {
  background: var(--bg-recess-strong);
  border-radius: 6px;
  padding: 12px;
  margin: 8px 0;
  overflow-x: auto;
  font-family: 'JetBrains Mono', monospace;
  font-size: 12px;
}
/* 代码块操作按钮（执行 / 插入 / 复制） */
.ai-message-text :deep(.code-block .code-actions) {
  display: flex;
  justify-content: flex-end;
  gap: 4px;
  margin: -4px -4px 6px;
  user-select: none;
}
.ai-message-text :deep(.code-action-btn) {
  background: none;
  border: none;
  padding: 2px 6px;
  border-radius: 4px;
  color: var(--text-secondary);
  font-size: 13px;
  cursor: pointer;
  transition: all 0.15s;
}
.ai-message-text :deep(.code-action-btn:hover) {
  background: rgb(var(--overlay-rgb) / 12%);
  color: var(--accent);
}

/* 失败重试按钮 */
.ai-msg-error-actions {
  margin-top: 8px;
}
.msg-retry-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
  font-size: 12px;
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  background: none;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.15s;
}
.msg-retry-btn:hover {
  border-color: var(--accent);
  color: var(--accent);
  background: rgb(var(--accent-rgb) / 8%);
}
.ai-message-text :deep(.inline-code) {
  background: var(--bg-recess-strong);
  padding: 2px 6px;
  border-radius: 4px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 12px;
}

/* Markdown 表格 */
.ai-message-text :deep(.md-table) {
  width: 100%;
  border-collapse: collapse;
  margin: 8px 0;
  font-size: 12px;
}
.ai-message-text :deep(.md-table th),
.ai-message-text :deep(.md-table td) {
  border: 1px solid rgb(var(--overlay-rgb) / 10%);
  padding: 5px 8px;
  text-align: left;
}
.ai-message-text :deep(.md-table th) {
  background: var(--bg-recess);
  font-weight: 600;
  color: var(--accent);
}
.ai-message-text :deep(.md-table tr:nth-child(even)) {
  background: rgb(var(--overlay-rgb) / 2%);
}

/* Markdown 标题 */
.ai-message-text :deep(h2) { font-size: 16px; font-weight: 600; margin: 12px 0 6px; }
.ai-message-text :deep(h3) { font-size: 14px; font-weight: 600; margin: 10px 0 4px; }
.ai-message-text :deep(h4) { font-size: 13px; font-weight: 600; margin: 8px 0 4px; }

/* Markdown 列表 */
.ai-message-text :deep(ul),
.ai-message-text :deep(ol) {
  margin: 4px 0;
  padding-left: 20px;
}
.ai-message-text :deep(li) {
  margin: 2px 0;
}

/* 链接 */
.ai-message-text :deep(a) {
  color: var(--accent);
  text-decoration: none;
}
.ai-message-text :deep(a:hover) {
  text-decoration: underline;
}

/* Agent 步骤样式 */
.agent-steps {
  display: flex;
  flex-direction: column;
  gap: 3px;
  margin-bottom: 8px;
}

.agent-step {
  border-radius: 4px;
  font-size: 12px;
}

.thinking-step {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  background: rgb(var(--warning-strong-rgb) / 8%);
  border-radius: 4px;
  color: var(--warning-strong);
}
.thinking-step .step-label { font-size: 11px; }

.tool-call-step {
  background: var(--bg-recess-soft);
  border-radius: 4px;
  overflow: hidden;
}

.step-header {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 4px 8px;
  cursor: pointer;
  transition: background 0.15s;
}
.step-header:hover { background: rgb(var(--overlay-rgb) / 4%); }

.step-chevron { color: var(--text-secondary); font-size: 10px; width: 10px; }
.step-icon { color: var(--success); font-size: 11px; }
.step-label { color: var(--text-secondary); font-size: 11px; white-space: nowrap; }
.step-cmd {
  color: var(--accent);
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}
.step-status {
  font-size: 11px;
  color: var(--success);
  flex-shrink: 0;
  margin-left: auto;
}

.step-result {
  border-top: 1px solid rgb(var(--overlay-rgb) / 6%);
  padding: 6px 8px;
  max-height: 150px;
  overflow-y: auto;
}
.step-result pre {
  margin: 0;
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  color: var(--text-secondary);
  white-space: pre-wrap;
  word-break: break-all;
}

.ai-loading {
  display: flex;
  gap: 3px;
}
.ai-loading span {
  width: 6px;
  height: 6px;
  background: var(--warning-strong);
  border-radius: 50%;
  animation: bounce 1.4s infinite ease-in-out both;
}
.ai-loading span:nth-child(1) { animation-delay: -0.32s; }
.ai-loading span:nth-child(2) { animation-delay: -0.16s; }

@keyframes bounce {
  0%, 80%, 100% { transform: scale(0); }
  40% { transform: scale(1); }
}

/* 会话级 token 累计徽标 */
.ai-session-tokens {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 9px;
  border-radius: 11px;
  font-size: 11px;
  color: var(--text-secondary);
  background: rgb(var(--overlay-rgb) / 8%);
  font-variant-numeric: tabular-nums;
  user-select: none;
}
.ai-session-tokens i {
  font-size: 11px;
  opacity: 0.8;
}

/* 头部生成状态 */
.ai-run-status {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 9px;
  border-radius: 11px;
  font-size: 11px;
  color: var(--warning-strong);
  background: rgb(var(--warning-strong-rgb) / 8%);
}
.ai-run-status.long {
  color: var(--danger);
  background: rgb(var(--danger-rgb) / 12%);
}
.ai-run-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  animation: pulse 1s infinite ease-in-out;
}
.ai-run-time {
  font-variant-numeric: tabular-nums;
  opacity: 0.75;
}
@keyframes pulse {
  0%, 100% { transform: scale(0.5); opacity: 0.45; }
  50% { transform: scale(1); opacity: 1; }
}

/* 助手消息：等待首个响应 / 流式光标 */
.ai-msg-gen {
  display: inline-flex;
  gap: 3px;
  margin-top: 4px;
}
.ai-msg-gen span {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-secondary);
  animation: bounce 1.4s infinite ease-in-out both;
}
.ai-msg-gen span:nth-child(1) { animation-delay: -0.32s; }
.ai-msg-gen span:nth-child(2) { animation-delay: -0.16s; }

.ai-caret {
  display: inline-block;
  width: 7px;
  height: 14px;
  margin-left: 2px;
  background: var(--accent);
  vertical-align: text-bottom;
  animation: blink 1s steps(2, start) infinite;
}
@keyframes blink {
  0%, 50% { opacity: 1; }
  50.01%, 100% { opacity: 0; }
}

/* 消息底部信息行：复制 / 耗时 / token 消耗 */
.ai-msg-meta {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 8px;
  padding-top: 6px;
  border-top: 1px solid rgb(var(--overlay-rgb) / 8%);
  font-size: 11px;
  color: var(--text-secondary);
  user-select: none;
}
.msg-meta-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: none;
  border: none;
  padding: 2px 4px;
  margin: -2px -4px;
  border-radius: 4px;
  color: var(--text-secondary);
  font-size: 11px;
  cursor: pointer;
  transition: all 0.15s;
}
.msg-meta-btn:hover {
  color: var(--text-primary);
  background: rgb(var(--overlay-rgb) / 8%);
}
.msg-meta-item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-variant-numeric: tabular-nums;
}
.msg-meta-item i { font-size: 11px; opacity: 0.8; }

/* 工具调用执行中旋转图标 */
.spin {
  animation: spin 1s linear infinite;
}
@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.ai-chat-input {
  position: relative;
  display: flex;
  align-items: flex-end;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--border-color);
  background: rgb(var(--bg-input-rgb) / 30%);
}

/* 拖拽手柄：贴在输入区上边缘，平时只显示一条细线，hover / 拖动时高亮 */
.ai-input-resizer {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 6px;
  cursor: ns-resize;
  touch-action: none;
}
.ai-input-resizer::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 50%;
  transform: translateX(-50%);
  width: 36px;
  height: 2px;
  border-radius: 1px;
  background: var(--border-strong);
  opacity: 0;
  transition: opacity 0.15s;
}
.ai-chat-input:hover .ai-input-resizer::after,
.ai-input-resizer:hover::after {
  opacity: 1;
  background: var(--accent);
}
.ai-chat-input textarea {
  flex: 1;
  background: var(--bg-recess);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 10px 14px;
  color: var(--text-primary);
  font-size: 13px;
  line-height: 1.5;
  /* 高度全部由脚本控制（autoGrowInput 按内容 / 用户拖拽高度），
     关掉原生 resize 与 max-height，否则手动拖出来的高度会被压回去 */
  resize: none;
  min-height: 40px;
  max-height: none;
  overflow-y: auto;
  outline: none;
  font-family: inherit;
}
.ai-chat-input textarea:focus { border-color: var(--accent); }
.ai-chat-input textarea:disabled { opacity: 0.6; }

.btn-send {
  width: 40px;
  height: 40px;
  border: none;
  border-radius: 8px;
  background: var(--accent);
  color: var(--accent-fg);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 16px;
  transition: all 0.15s;
  flex-shrink: 0;
}
.btn-send:hover:not(:disabled) { background: var(--accent-hover); }
.btn-send:disabled { opacity: 0.5; cursor: not-allowed; }

/* Skills 按钮 */
.btn-skill-toggle {
  width: 36px;
  height: 36px;
  border: none;
  border-radius: 8px;
  background: rgb(var(--overlay-rgb) / 5%);
  color: var(--text-secondary);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 16px;
  transition: all 0.15s;
  flex-shrink: 0;
}
.btn-skill-toggle:hover { background: rgb(var(--overlay-rgb) / 10%); color: var(--warning); }
.btn-skill-toggle.active { color: var(--warning); background: rgb(var(--warning-rgb) / 10%); }

/* Skills 面板 */
.skills-panel {
  border-top: 1px solid var(--border-color);
  background: rgb(var(--bg-dark-rgb) / 95%);
  max-height: 200px;
  overflow-y: auto;
}
.skills-panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 16px;
  font-size: 12px;
  color: var(--text-secondary);
  border-bottom: 1px solid rgb(var(--overlay-rgb) / 5%);
}
.skills-grid {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px 8px;
}
.skill-item {
  padding: 8px 10px;
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.12s;
}
.skill-item:hover { background: rgb(var(--overlay-rgb) / 6%); }
.skill-item.active { background: rgb(var(--warning-rgb) / 10%); border: 1px solid rgb(var(--warning-rgb) / 20%); }
.skill-item-header {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-primary);
}
.skill-item-header i { color: var(--warning); font-size: 12px; }
.skill-name { font-weight: 500; }
.skill-source {
  font-size: 10px;
  color: var(--text-secondary);
  background: rgb(var(--overlay-rgb) / 6%);
  padding: 1px 5px;
  border-radius: 4px;
  margin-left: auto;
}
.skill-desc {
  font-size: 11px;
  color: var(--text-secondary);
  margin-top: 3px;
  padding-left: 18px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.skills-empty {
  padding: 16px;
  text-align: center;
  color: var(--text-secondary);
  font-size: 12px;
}

/* 已选 Skill 栏 */
.selected-skill-bar {
  padding: 4px 16px 0;
  background: rgb(var(--bg-input-rgb) / 30%);
}
.selected-skill-tag {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 8px 3px 10px;
  background: rgb(var(--warning-rgb) / 12%);
  border: 1px solid rgb(var(--warning-rgb) / 25%);
  border-radius: 12px;
  font-size: 12px;
  color: var(--warning);
}
.selected-skill-tag i { font-size: 11px; }
.skill-remove {
  background: none;
  border: none;
  color: rgb(var(--warning-rgb) / 60%);
  cursor: pointer;
  padding: 0 2px;
  font-size: 13px;
  line-height: 1;
  display: flex;
  align-items: center;
}
.skill-remove:hover { color: var(--warning); }

/* Skill 徽章在用户消息中 */
.skill-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  background: rgba(255,255,255,0.15);
  border-radius: 10px;
  font-size: 11px;
  margin-bottom: 6px;
  color: rgba(255,255,255,0.9);
}
.skill-badge i { font-size: 10px; color: var(--warning); }

/* 对话状态栏：当前对话 + 模型选择 */
.ai-chat-toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--border-color);
  font-size: 12px;
}
.ai-chat-title {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  flex: 1;
  color: var(--text-secondary);
}
.ai-chat-title i { flex-shrink: 0; }
.ai-model-select {
  max-width: min(190px, 50%);
  flex-shrink: 0;
  background: var(--bg-recess);
  color: var(--text-primary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  font-size: 11px;
  padding: 2px 4px;
  outline: none;
  cursor: pointer;
}
/* 原生下拉弹层不在 select 盒子里渲染，而且会沿用 select 那层半透明底色
   （--bg-recess 是 rgba），弹层下面透出的浅色一混，浅灰文字就糊成一片；
   所以 option 得自备不透明底色，不能只靠 select 的 color 继承 */
.ai-model-select option {
  background-color: var(--bg-sidebar);
  color: var(--text-primary);
}
.ai-model-select option:checked {
  background-color: var(--bg-input);
  color: var(--accent);
}

/* 未绑终端的提示条：只说「不能执行命令」，不跟着模型说「会话已断开」 */
.ai-no-terminal {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 5px 12px;
  border-bottom: 1px solid var(--border-color);
  background: rgb(var(--accent-rgb) / 8%);
  font-size: 11px;
  color: var(--text-secondary);
}
.ai-no-terminal i { flex-shrink: 0; font-size: 11px; color: var(--warning); }

/* 消息上的模型标识 */
.ai-msg-model {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 10px;
  color: var(--text-secondary);
  margin-bottom: 6px;
}
.ai-msg-model-auto {
  padding: 0 5px;
  border-radius: 999px;
  background: rgb(var(--accent-rgb) / 15%);
  color: var(--accent);
}

/* 历史对话面板 */
.history-panel {
  border-top: 1px solid var(--border-color);
  background: rgb(var(--bg-dark-rgb) / 95%);
  max-height: 240px;
  overflow-y: auto;
}
.history-panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 16px;
  font-size: 12px;
  color: var(--text-secondary);
  border-bottom: 1px solid rgb(var(--overlay-rgb) / 5%);
}
.history-list {
  display: flex;
  flex-direction: column;
  padding: 4px 0;
}
.history-item {
  padding: 8px 16px;
  cursor: pointer;
  transition: background 0.12s;
  border-bottom: 1px solid rgb(var(--overlay-rgb) / 3%);
}
.history-item:hover { background: rgb(var(--overlay-rgb) / 6%); }
.history-item.active {
  background: rgb(var(--accent-rgb) / 10%);
  box-shadow: inset 2px 0 0 var(--accent);
}
.history-item:last-child { border-bottom: none; }
.chat-delete-btn {
  background: none;
  border: none;
  padding: 0 2px;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 11px;
  opacity: 0;
  transition: opacity 0.12s, color 0.12s;
}
.history-item:hover .chat-delete-btn { opacity: 1; }
.chat-delete-btn:hover { color: var(--danger); }
.history-item-top {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 3px;
}
.history-name {
  font-size: 12px;
  font-weight: 500;
  color: var(--text-primary);
}
.history-time {
  font-size: 10px;
  color: var(--text-secondary);
}
.history-preview {
  font-size: 11px;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.history-meta {
  font-size: 10px;
  color: var(--text-muted);
  margin-top: 2px;
}
.history-empty {
  padding: 20px;
  text-align: center;
  color: var(--text-secondary);
  font-size: 12px;
}

.btn-ai-action.active {
  color: var(--accent);
  background: rgb(var(--accent-rgb) / 10%);
}

/* 成本面板（与对话列表同在浮层位置，高度放宽些：要放预算和按模型明细） */
.cost-panel {
  max-height: 320px;
}
.cost-body {
  padding: 8px 16px 10px;
}
.cost-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 3px 0;
  font-size: 11px;
  color: var(--text-secondary);
}
.cost-row strong {
  font-size: 12px;
  color: var(--text-primary);
  font-weight: 500;
  white-space: nowrap;
}
/* 省下来的钱用正向色标出来，否则它和一行普通统计没区别 */
.cost-row.saved strong {
  color: var(--success, #3fb950);
}
.cost-subtitle {
  margin: 10px 0 3px;
  font-size: 10px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-muted);
}
.cost-hint {
  margin-top: 6px;
  font-size: 10px;
  line-height: 1.5;
  color: var(--text-muted);
}
.cost-model-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 2px 0;
  font-size: 11px;
  color: var(--text-secondary);
}
.cost-model-num {
  flex: none;
  font-variant-numeric: tabular-nums;
  color: var(--text-primary);
}

/* Tab 切换栏 */
.ai-tab-bar {
  display: flex;
  gap: 2px;
  background: var(--bg-recess);
  border-radius: 6px;
  padding: 2px;
}
.ai-tab {
  background: none;
  border: none;
  color: var(--text-secondary);
  padding: 4px 12px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
  display: flex;
  align-items: center;
  gap: 4px;
  transition: all 0.15s;
  white-space: nowrap;
}
.ai-tab:hover { color: var(--text-primary); }
.ai-tab.active {
  background: rgb(var(--overlay-rgb) / 10%);
  color: var(--text-primary);
}
.ai-tab i { font-size: 12px; }

/* 审计面板包装器 */
.ai-audit-wrapper {
  flex: 1;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

/* 系统信息消息 */
.ai-message.system-info .ai-message-avatar i {
  color: var(--accent);
}
.ai-message.system-info .ai-message-content {
  background: rgb(var(--accent-rgb) / 6%);
  border: 1px solid rgb(var(--accent-rgb) / 15%);
}
.ai-message.system-info .ai-message-text {
  font-size: 11px;
  line-height: 1.6;
  white-space: pre-wrap;
  color: var(--text-secondary);
}

/* AI 面板右键菜单（颜色均带兜底值，主题变量缺失时也保证可见） */
.ai-msg-context-menu {
  position: fixed;
  z-index: 9999;
  min-width: 150px;
  background: rgb(var(--bg-input-rgb, 45 45 45));
  border: 1px solid var(--border-color, #555);
  border-radius: 6px;
  padding: 4px 0;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.35);
  font-size: 13px;
  user-select: none;
}
.ctx-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 14px;
  cursor: pointer;
  color: var(--text-primary, #eee);
  white-space: nowrap;
}
.ctx-item:hover {
  background: rgb(var(--overlay-rgb, 255 255 255) / 10%);
}
.ctx-item i {
  font-size: 13px;
  opacity: 0.8;
}
</style>

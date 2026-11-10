<template>
  <div class="aprompt-mask" @click.self="cancel">
    <div class="aprompt-card" role="dialog" aria-modal="true">
      <div v-if="title" class="aprompt-title">{{ title }}</div>
      <div v-if="message" class="aprompt-message">{{ message }}</div>
      <input
        ref="inputRef"
        v-model="value"
        class="aprompt-input"
        :type="inputType"
        :placeholder="placeholder"
        autocomplete="off"
        spellcheck="false"
        @keydown.enter.prevent="submit"
        @keydown.esc.prevent="cancel"
      />
      <div v-if="error" class="aprompt-error">{{ error }}</div>
      <div class="aprompt-actions">
        <button type="button" class="aprompt-btn" @click="cancel">{{ cancelText }}</button>
        <button type="button" class="aprompt-btn primary" @click="submit">{{ confirmText }}</button>
      </div>
    </div>
  </div>
</template>

<script lang="ts" setup>
import { nextTick, onMounted, ref } from 'vue';

const props = withDefaults(
  defineProps<{
    title?: string;
    message?: string;
    placeholder?: string;
    inputType?: 'text' | 'password';
    confirmText?: string;
    cancelText?: string;
    /** 最少字符数；0 表示不校验 */
    minLength?: number;
    /** 长度不足时的提示，缺省用一句通用文案 */
    minLengthError?: string;
  }>(),
  {
    title: '',
    message: '',
    placeholder: '',
    inputType: 'text',
    confirmText: 'OK',
    cancelText: 'Cancel',
    minLength: 0,
    minLengthError: '',
  },
);

const emit = defineEmits<{
  (e: 'confirm', value: string): void;
  (e: 'cancel'): void;
}>();

const value = ref('');
const error = ref('');
const inputRef = ref<HTMLInputElement>();

onMounted(() => {
  nextTick(() => {
    inputRef.value?.focus();
    inputRef.value?.select();
  });
});

function submit() {
  const text = value.value;
  // 空值也允许提交：服务端会按「没带口令」处理，这里只做长度下限校验，
  // 避免把「口令是否为空」的规则在前后端各写一份
  if (props.minLength > 0 && text.length < props.minLength) {
    error.value = props.minLengthError || `At least ${props.minLength} characters`;
    return;
  }
  emit('confirm', text);
}

function cancel() {
  emit('cancel');
}
</script>

<style scoped>
.aprompt-mask {
  position: fixed;
  inset: 0;
  z-index: 30000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.55);
}

.aprompt-card {
  width: min(420px, calc(100vw - 32px));
  padding: 20px;
  border-radius: 10px;
  background: #252526;
  border: 1px solid #3c3c3c;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
  color: #e6e6e6;
  font-size: 13px;
}

.aprompt-title {
  font-size: 15px;
  font-weight: 600;
  margin-bottom: 8px;
}

.aprompt-message {
  color: #b6b6b6;
  line-height: 1.6;
  margin-bottom: 12px;
  word-break: break-word;
}

.aprompt-input {
  width: 100%;
  box-sizing: border-box;
  padding: 8px 10px;
  border-radius: 6px;
  border: 1px solid #4a4a4a;
  background: #1e1e1e;
  color: #e6e6e6;
  font-size: 13px;
  outline: none;
}

.aprompt-input:focus {
  border-color: #0d6efd;
}

.aprompt-error {
  margin-top: 8px;
  color: #f48771;
  font-size: 12px;
}

.aprompt-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
}

.aprompt-btn {
  padding: 6px 14px;
  border-radius: 6px;
  border: 1px solid #4a4a4a;
  background: transparent;
  color: #d6d6d6;
  font-size: 13px;
  cursor: pointer;
}

.aprompt-btn:hover {
  background: #333;
}

.aprompt-btn.primary {
  border-color: #0d6efd;
  background: #0d6efd;
  color: #fff;
}

.aprompt-btn.primary:hover {
  background: #0b5ed7;
}
</style>

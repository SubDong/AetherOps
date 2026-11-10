import { createApp } from 'vue';
import type { App } from 'vue';
import PromptDialog from './index.vue';
import i18n from '@/utils/i18n';

/**
 * 通用输入弹窗。
 *
 * 为什么不给 components/modal 加一个 prompt：那套弹窗的 ModalOptions 是
 * 按钮型确认框，塞进「输入框 + 回车提交 + 长度校验」会把它的职责摊薄；
 * 而这里需要的用法（终端口令）只有一处，独立成组件更容易收场。
 *
 * 返回值：确认 → 输入的文本（可能是空串）；取消 / 关闭 → null。
 */
export interface PromptOptions {
  title?: string;
  message?: string;
  placeholder?: string;
  inputType?: 'text' | 'password';
  confirmText?: string;
  cancelText?: string;
  minLength?: number;
  minLengthError?: string;
}

export function prompt(options: PromptOptions = {}): Promise<string | null> {
  if (typeof document === 'undefined') return Promise.resolve(null);

  const mount = document.createElement('div');
  document.body.appendChild(mount);

  let app: App<Element> | null = null;
  let settled = false;
  let settle: (value: string | null) => void = () => {};
  const result = new Promise<string | null>((resolve) => {
    settle = resolve;
  });

  const finish = (value: string | null) => {
    if (settled) return;
    settled = true;
    settle(value);
    // 卸载放到下一个任务：当前调用栈还在组件自身的事件处理里，
    // 当场 unmount 会让 Vue 正在派发的这个事件失去宿主
    setTimeout(() => {
      try {
        app?.unmount();
      } catch {
        /* 已卸载则忽略 */
      }
      mount.remove();
    }, 0);
  };

  app = createApp(PromptDialog, {
    ...options,
    onConfirm: (value: string) => finish(value),
    onCancel: () => finish(null),
  });
  app.use(i18n);
  app.mount(mount);

  return result;
}

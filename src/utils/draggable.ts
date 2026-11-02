import { computed, onBeforeUnmount, onMounted, ref, type Ref } from 'vue';

/**
 * 弹窗标题栏拖动。
 *
 * 位移写在元素的 left/top 上（元素本身 position: relative），不用 transform：
 * Bootstrap 打开动画就是靠 .modal-dialog 的 transform 做的，抢了它动画就没了；
 * 而 transform 还会给内部元素建新的包含块，容易把绝对定位的浮层带偏。
 */

/** 拖出去之后至少留这么多像素在视口里，否则窗口抓不回来也关不掉 */
const DEFAULT_MIN_VISIBLE = 48;

/** 标题栏上这些元素自己要吃指针事件，不能当拖拽把手 */
const INTERACTIVE_SELECTOR = 'button, a, input, textarea, select, label, [contenteditable="true"]';

/**
 * 真正看得见的那块卡片。
 * Bootstrap 的 .modal-dialog-centered 自己也压着 `min-height: calc(100% - 3.5rem)`，
 * 并且用 flex 把 .modal-content 居中，所以 dialog 元素几乎和视口一样高：
 * 拿它量边界会得出「顶部只能上移 28px」的死板结论，向上拖就跟黏住一样。
 */
const DEFAULT_CONTENT_SELECTOR = '.modal-content';

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

export function useDraggableDialog(
  dialogRef: Ref<HTMLElement | null | undefined>,
  minVisible: number = DEFAULT_MIN_VISIBLE,
  contentSelector: string | null = DEFAULT_CONTENT_SELECTOR,
) {
  const offsetX = ref(0);
  const offsetY = ref(0);
  const dragging = ref(false);

  let pointerId: number | null = null;
  let handle: HTMLElement | null = null;
  let startX = 0;
  let startY = 0;
  let originX = 0;
  let originY = 0;

  /** 量边界只看卡片本身，不看撑满视口的那层 flex 外壳 */
  function visualBox(): HTMLElement | null {
    const el = dialogRef.value;
    if (!el) return null;
    return (contentSelector ? el.querySelector<HTMLElement>(contentSelector) : null) ?? el;
  }

  /**
   * 把位移夹在视口内：顶部不允许越过视口上沿（标题栏必须能看见），
   * 其余三边至少留 minVisible。卡片本身比视口还大时 min > max，
   * 这时不夹取——否则大弹窗会彻底拖不动。
   */
  function clampOffset(nextX: number, nextY: number) {
    const box = visualBox();
    if (!box) return { x: nextX, y: nextY };
    const rect = box.getBoundingClientRect();
    // rect 已经含当前位移，减回去才是元素安放时的原始位置
    const left = rect.left - offsetX.value;
    const top = rect.top - offsetY.value;
    const minX = minVisible - (left + rect.width);
    const maxX = window.innerWidth - minVisible - left;
    // 上边界是「标题栏贴视口顶」，不是「留 48px」
    const minY = -top;
    const maxY = window.innerHeight - minVisible - top;
    return {
      x: minX <= maxX ? clamp(nextX, minX, maxX) : nextX,
      y: minY <= maxY ? clamp(nextY, minY, maxY) : nextY,
    };
  }

  function onPointerDown(e: PointerEvent) {
    // 只认左键，中键/右键留给各自的默认行为
    if (e.button !== 0) return;
    if ((e.target as HTMLElement | null)?.closest(INTERACTIVE_SELECTOR)) return;
    const el = e.currentTarget as HTMLElement | null;
    if (!el) return;
    // 阻止默认的文本选择，否则拖到标题文字上会一层蓝底
    e.preventDefault();
    pointerId = e.pointerId;
    handle = el;
    startX = e.clientX;
    startY = e.clientY;
    originX = offsetX.value;
    originY = offsetY.value;
    dragging.value = true;
    // 指针捕获：光标甩出标题栏甚至甩出窗口，move/up 依然回到这里
    el.setPointerCapture?.(e.pointerId);
    document.body.style.userSelect = 'none';
  }

  function onPointerMove(e: PointerEvent) {
    if (!dragging.value || e.pointerId !== pointerId) return;
    const next = clampOffset(originX + (e.clientX - startX), originY + (e.clientY - startY));
    offsetX.value = next.x;
    offsetY.value = next.y;
  }

  function stopDrag(e: PointerEvent) {
    if (pointerId === null || e.pointerId !== pointerId) return;
    try {
      handle?.releasePointerCapture?.(pointerId);
    } catch {
      // 指针已经没了，忽略
    }
    pointerId = null;
    handle = null;
    dragging.value = false;
    document.body.style.userSelect = '';
  }

  /** 每次打开都要归位，否则下次弹出来还停在上次拖到的地方 */
  function resetDrag() {
    offsetX.value = 0;
    offsetY.value = 0;
    dragging.value = false;
  }

  const dragStyle = computed(() => ({ left: `${offsetX.value}px`, top: `${offsetY.value}px` }));

  /** 窗口变小后原来合法的位置可能已把弹窗推出视口，重算一次 */
  function handleWindowResize() {
    if (dragging.value) return;
    const next = clampOffset(offsetX.value, offsetY.value);
    offsetX.value = next.x;
    offsetY.value = next.y;
  }

  onMounted(() => window.addEventListener('resize', handleWindowResize));

  onBeforeUnmount(() => {
    window.removeEventListener('resize', handleWindowResize);
    document.body.style.userSelect = '';
  });

  return {
    offsetX,
    offsetY,
    dragging,
    dragStyle,
    onPointerDown,
    onPointerMove,
    onPointerUp: stopDrag,
    resetDrag,
  };
}

export interface FloatingDragOptions {
  /** 限定在某个容器内移动；不传就按整个视口算（fixed 浮层） */
  container?: () => HTMLElement | null | undefined;
  /** 离可视边界的最小距离 */
  margin?: number;
}

/**
 * 自由浮层拖动（搜索条、悬浮面板这类不是弹窗的小窗）。
 *
 * 和 useDraggableDialog 的区别：浮层自己带 position: absolute / fixed，
 * 位移直接写 left/top，不再靠「原位置 + 偏移」的 relative 方案，
 * 所以能把当前位置夹在容器（或视口）里，拖多快都不会飞出去。
 */
export function useDraggableFloating(options: FloatingDragOptions = {}) {
  const elRef = ref<HTMLElement | null>(null);
  const left = ref(0);
  const top = ref(0);
  /** 首次摆位完成前先藏起来，否则会先在 (0, 0) 闪一下 */
  const placed = ref(false);
  const dragging = ref(false);

  let pointerId: number | null = null;
  let handle: HTMLElement | null = null;
  let startPointerX = 0;
  let startPointerY = 0;
  let startLeft = 0;
  let startTop = 0;

  const margin = options.margin ?? 8;

  function area() {
    const el = elRef.value;
    const container = options.container?.();
    return {
      width: container ? container.clientWidth : window.innerWidth,
      height: container ? container.clientHeight : window.innerHeight,
      elWidth: el?.offsetWidth || 0,
      elHeight: el?.offsetHeight || 0,
    };
  }

  function clampTo(x: number, y: number) {
    const { width, height, elWidth, elHeight } = area();
    return {
      x: clamp(x, margin, Math.max(margin, width - elWidth - margin)),
      y: clamp(y, margin, Math.max(margin, height - elHeight - margin)),
    };
  }

  function place(x: number, y: number) {
    const next = clampTo(x, y);
    left.value = next.x;
    top.value = next.y;
    placed.value = true;
  }

  /** 摆到右上角：默认位置在工具栏按钮下方，不挡终端内容 */
  function placeTopRight(topOffset = 56, rightOffset = 12) {
    const { width, elWidth } = area();
    place(width - elWidth - rightOffset, topOffset);
  }

  function onPointerDown(e: PointerEvent) {
    if (e.button !== 0) return;
    // 输入框、按钮自己要吃指针事件，只有空白区/图标能拖
    if ((e.target as HTMLElement | null)?.closest(INTERACTIVE_SELECTOR)) return;
    const el = e.currentTarget as HTMLElement | null;
    if (!el) return;
    e.preventDefault();
    pointerId = e.pointerId;
    handle = el;
    startPointerX = e.clientX;
    startPointerY = e.clientY;
    startLeft = left.value;
    startTop = top.value;
    dragging.value = true;
    el.setPointerCapture?.(e.pointerId);
    document.body.style.userSelect = 'none';
  }

  function onPointerMove(e: PointerEvent) {
    if (!dragging.value || e.pointerId !== pointerId) return;
    place(startLeft + (e.clientX - startPointerX), startTop + (e.clientY - startPointerY));
  }

  function onPointerUp(e: PointerEvent) {
    if (pointerId === null || e.pointerId !== pointerId) return;
    try {
      handle?.releasePointerCapture?.(pointerId);
    } catch {
      // 指针已经没了，忽略
    }
    pointerId = null;
    handle = null;
    dragging.value = false;
    document.body.style.userSelect = '';
  }

  /** 关掉再打开时回到初始坐标，不沿用上次拖到的位置 */
  function reset() {
    placed.value = false;
    left.value = 0;
    top.value = 0;
    dragging.value = false;
  }

  /** 容器或窗口变小后，原坐标可能已经把浮层挤出可视范围 */
  function reclamp() {
    if (!placed.value || dragging.value) return;
    const { width, height } = area();
    // 容器被隐藏（比如切到别的 tab）时尺寸为 0，别把浮层挤到左上角去
    if (width <= 0 || height <= 0) return;
    place(left.value, top.value);
  }

  const dragStyle = computed(() => ({ left: `${left.value}px`, top: `${top.value}px` }));

  let observer: ResizeObserver | null = null;

  onMounted(() => {
    window.addEventListener('resize', reclamp);
    const container = options.container?.();
    if (container && typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(reclamp);
      observer.observe(container);
    }
  });

  onBeforeUnmount(() => {
    window.removeEventListener('resize', reclamp);
    observer?.disconnect();
    document.body.style.userSelect = '';
  });

  return {
    elRef,
    left,
    top,
    placed,
    dragging,
    dragStyle,
    place,
    placeTopRight,
    reset,
    onPointerDown,
    onPointerMove,
    onPointerUp,
  };
}

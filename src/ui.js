// Small DOM helpers for the patcher wizard: element building, pagination,
// progress/ETA and cross-origin-isolation setup.

const ISOLATION_KEY = 'arkham-ps3-isolation-reloaded';

export function h(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (key === 'html') node.innerHTML = value;
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function link(href, text, extra = '') {
  return h('a', { href, class: extra, target: href.startsWith('http') ? '_blank' : null, rel: 'noreferrer' }, text);
}

export function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let size = bytes / 1024;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index++;
  }
  return `${size.toFixed(size >= 100 ? 0 : size >= 10 ? 1 : 2)} ${units[index]}`;
}

export function formatDuration(milliseconds) {
  const seconds = Math.max(0, Math.round((Number(milliseconds) || 0) / 1000));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}

export function detectMobile() {
  const ua = navigator.userAgent || '';
  const coarse = matchMedia('(pointer: coarse)').matches;
  return /Android|iPhone|iPad|iPod|Mobile|Silk/i.test(ua) || (coarse && Math.min(screen.width, screen.height) < 900);
}

export function supportsFolderPicker() {
  return typeof window.showDirectoryPicker === 'function' && !detectMobile();
}

/**
 * Enables cross-origin isolation with a service worker when the host cannot
 * send COOP/COEP headers (GitHub Pages). Returns true when isolated, false
 * when a reload was started, and null when the browser cannot do it.
 */
export async function ensureCrossOriginIsolation() {
  if (globalThis.crossOriginIsolated) return true;
  // SharedArrayBuffer is hidden until the document is isolated, so the service
  // worker has to be the first thing that runs here.
  if (!('serviceWorker' in navigator)) return null;

  try {
    await navigator.serviceWorker.register('/arkhamrevived/ps3-tutorial/coi-sw.js', {
      scope: '/arkhamrevived/ps3-tutorial/',
    });
    await Promise.race([
      navigator.serviceWorker.ready,
      new Promise(resolve => setTimeout(resolve, 8000)),
    ]);
    if (!navigator.serviceWorker.controller) {
      await new Promise(resolve => {
        const timer = setTimeout(resolve, 4000);
        navigator.serviceWorker.addEventListener('controllerchange', () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
      });
    }
    if (!globalThis.crossOriginIsolated && sessionStorage.getItem(ISOLATION_KEY) !== '1') {
      sessionStorage.setItem(ISOLATION_KEY, '1');
      location.reload();
      return false;
    }
  } catch (error) {
    console.warn('Could not enable cross-origin isolation:', error);
  }
  return globalThis.crossOriginIsolated ? true : null;
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = h('a', { href: url, download: filename });
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 120000);
}

export function toast(message, { kind = 'info', timeout = 8000 } = {}) {
  let host = document.querySelector('.ak-toasts');
  if (!host) {
    host = h('div', { class: 'ak-toasts' });
    document.body.append(host);
  }
  const item = h('div', { class: `ak-toast ak-toast-${kind}` }, message);
  host.append(item);
  if (timeout) {
    setTimeout(() => {
      item.classList.add('ak-toast-out');
      setTimeout(() => item.remove(), 300);
    }, timeout);
  }
  return item;
}

/** Progress panel with an overall bar, a sub-step line, elapsed time and ETA. */
export class TaskProgress {
  constructor() {
    this.totalWeight = 0;
    this.phases = new Map();
    this.current = null;
    this.startedAt = 0;
    this.overall = 0;
    this.finished = false;

    this.bar = h('div', { class: 'ak-bar' }, h('div', { class: 'ak-bar-fill' }));
    this.status = h('p', { class: 'ak-progress-status' }, 'Preparing…');
    this.detail = h('p', { class: 'ak-progress-detail' }, '');
    this.eta = h('span', { class: 'ak-progress-eta' }, 'ETA -');
    this.elapsed = h('span', { class: 'ak-progress-elapsed' }, 'Elapsed 0:00');
    this.subBar = h('div', { class: 'ak-bar ak-bar-sub' }, h('div', { class: 'ak-bar-fill' }));
    this.log = h('pre', { class: 'ak-progress-log', hidden: true });
    this.cancelButton = h('button', { type: 'button', class: 'ak-button ak-button-ghost', hidden: true }, 'Cancel');
    this.node = h('div', { class: 'ak-progress' },
      this.status,
      this.bar,
      this.subBar,
      h('div', { class: 'ak-progress-meta' }, this.eta, this.elapsed),
      this.detail,
      this.log,
      h('div', { class: 'ak-progress-actions' }, this.cancelButton),
    );

    this.timer = setInterval(() => this.tick(), 500);
  }

  begin(phases, { cancellable = false, onCancel } = {}) {
    this.phases = new Map(phases.map(phase => [phase.id, { ...phase, fraction: 0 }]));
    this.totalWeight = phases.reduce((sum, phase) => sum + phase.weight, 0);
    this.startedAt = performance.now();
    this.finished = false;
    this.overall = 0;
    this.current = phases[0]?.id ?? null;
    if (cancellable) {
      this.cancelButton.hidden = false;
      this.cancelButton.onclick = () => {
        this.cancelButton.disabled = true;
        this.cancelButton.textContent = 'Cancelling…';
        onCancel?.();
      };
    } else {
      this.cancelButton.hidden = true;
    }
    this.tick();
  }

  setPhase(id, status) {
    this.current = id;
    if (status) this.status.textContent = status;
    this.detail.textContent = '';
    this.setSubFraction(0);
  }

  setStatus(status) {
    this.status.textContent = status;
  }

  setDetail(text) {
    this.detail.textContent = text ?? '';
  }

  setFraction(fraction) {
    const phase = this.phases.get(this.current);
    if (!phase) return;
    phase.fraction = Math.max(0, Math.min(1, Number(fraction) || 0));
    this.setSubFraction(phase.fraction);
    this.tick();
  }

  setSubFraction(fraction) {
    this.subBar.firstElementChild.style.width = `${Math.max(0, Math.min(1, fraction)) * 100}%`;
  }

  setProgress(done, total, label) {
    if (!total) return;
    this.setFraction(done / total);
    if (label) this.setDetail(label);
  }

  appendLog(line) {
    this.log.hidden = false;
    const text = this.log.textContent ? `${this.log.textContent}\n${line}` : line;
    this.log.textContent = text;
    this.log.scrollTop = this.log.scrollHeight;
  }

  finish() {
    this.finished = true;
    for (const phase of this.phases.values()) phase.fraction = 1;
    this.tick();
    clearInterval(this.timer);
    this.cancelButton.hidden = true;
  }

  fail(message) {
    this.finished = true;
    this.status.textContent = 'Failed';
    this.status.classList.add('ak-error-text');
    this.detail.textContent = message;
    this.cancelButton.hidden = true;
    clearInterval(this.timer);
  }

  tick() {
    if (!this.phases.size) return;
    let weighted = 0;
    for (const phase of this.phases.values()) weighted += phase.weight * phase.fraction;
    this.overall = this.totalWeight ? weighted / this.totalWeight : 0;
    this.bar.firstElementChild.style.width = `${this.overall * 100}%`;

    const elapsed = performance.now() - this.startedAt;
    this.elapsed.textContent = `Elapsed ${formatDuration(elapsed)}`;
    if (this.finished) {
      this.eta.textContent = 'ETA done';
      this.status.textContent = this.status.classList.contains('ak-error-text') ? this.status.textContent : 'Complete';
      return;
    }
    if (this.overall > 0.02 && this.overall < 1) {
      const remaining = (elapsed / this.overall) * (1 - this.overall);
      this.eta.textContent = `ETA ${formatDuration(remaining)}`;
    } else {
      this.eta.textContent = 'ETA -';
    }
  }

  dispose() {
    clearInterval(this.timer);
    this.node.remove();
  }
}

/** The paginated step container. Pages are plain DOM nodes plus metadata. */
export class Wizard {
  constructor(root, { onPage, canLeave } = {}) {
    this.root = root;
    this.steps = [];
    this.index = 0;
    this.onPage = onPage;
    this.canLeave = canLeave ?? (() => true);
    this.pageHost = h('div', { class: 'ak-page-host' });
    this.stepLabel = h('span', { class: 'ak-step-label' });
    this.dots = h('div', { class: 'ak-dots' });
    this.back = h('button', { type: 'button', class: 'ak-button ak-button-ghost' }, 'Back');
    this.next = h('button', { type: 'button', class: 'ak-button' }, 'Next');
    this.back.addEventListener('click', () => this.go(this.index - 1));
    this.next.addEventListener('click', () => {
      const step = this.steps[this.index];
      if (step?.onNext) {
        step.onNext();
        return;
      }
      this.go(this.index + 1);
    });
    this.node = h('div', { class: 'ak-wizard' },
      h('div', { class: 'ak-wizard-head' }, this.dots, this.stepLabel),
      this.pageHost,
      h('div', { class: 'ak-wizard-nav' }, this.back, this.next),
    );
    root.append(this.node);
  }

  setSteps(steps, { keep = true } = {}) {
    const currentId = keep ? this.steps[this.index]?.id : null;
    this.steps = steps;
    const nextIndex = currentId ? steps.findIndex(step => step.id === currentId) : 0;
    this.index = Math.max(0, nextIndex);
    this.render();
  }

  go(index) {
    if (index < 0 || index >= this.steps.length) return;
    if (index !== this.index && !this.canLeave()) return;
    this.index = index;
    this.render();
    this.node.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  goToId(id) {
    const index = this.steps.findIndex(step => step.id === id);
    if (index >= 0) this.go(index);
  }

  nextId() {
    return this.steps[this.index + 1]?.id ?? null;
  }

  previousId() {
    return this.steps[this.index - 1]?.id ?? null;
  }

  render() {
    const step = this.steps[this.index];
    this.pageHost.replaceChildren(step ? step.render() : h('p', {}, 'Nothing to show.'));
    this.stepLabel.textContent = step ? `Step ${this.index + 1} of ${this.steps.length}` : '';
    const canLeave = this.canLeave();
    this.back.disabled = this.index === 0 || !canLeave;
    const nextLabel = step?.nextLabel?.(this) ?? 'Next';
    this.next.textContent = nextLabel ?? 'Next';
    this.next.hidden = !nextLabel;
    this.next.disabled = Boolean(step?.canNext && !step.canNext());

    this.dots.replaceChildren(...this.steps.map((item, index) => h('button', {
      type: 'button',
      class: `ak-dot${index === this.index ? ' ak-dot-current' : ''}${index < this.index ? ' ak-dot-done' : ''}`,
      title: item.title ?? '',
      'aria-label': item.title ?? `Step ${index + 1}`,
      disabled: !canLeave,
      onclick: () => this.go(index),
    })));
    this.onPage?.(step, this);
  }

  refresh() {
    this.render();
  }
}

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FreasonPoll = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const DEFAULT_API_BASE = 'https://vote.67.230.177.86.sslip.io:8443';
  const POLL_SLUGS = Object.freeze(['jucheng', 'sengui', 'tingshan', 'xiangxi']);
  const STORAGE_KEY = 'freason-august-2026-poll-v3';
  const MARKER_RE = /^(pending|retry):(vote|withdraw):(jucheng|sengui|tingshan|xiangxi):([A-Za-z0-9._~-]+)$/;

  class OperationConflictError extends Error {
    constructor(message) {
      super(message || 'Poll operation ID conflict');
      this.name = 'OperationConflictError';
      this.status = 409;
    }
  }

  function isValidSlug(value) {
    return POLL_SLUGS.includes(value);
  }

  function randomOperationId() {
    const cryptoRef = typeof crypto !== 'undefined' ? crypto : null;
    if (cryptoRef && typeof cryptoRef.randomUUID === 'function') return cryptoRef.randomUUID();
    if (cryptoRef && typeof cryptoRef.getRandomValues === 'function') {
      const bytes = cryptoRef.getRandomValues(new Uint8Array(16));
      bytes[6] = (bytes[6] & 15) | 64;
      bytes[8] = (bytes[8] & 63) | 128;
      const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  }

  function readCounts(payload) {
    const counts = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload.counts : null;
    if (!counts || typeof counts !== 'object' || Array.isArray(counts)) throw new Error('Unrecognized poll response');
    const keys = Object.keys(counts);
    if (keys.length !== POLL_SLUGS.length || !POLL_SLUGS.every((slug) => keys.includes(slug))) {
      throw new Error('Unrecognized poll response');
    }
    const result = {};
    POLL_SLUGS.forEach((slug) => {
      if (!Number.isSafeInteger(counts[slug]) || counts[slug] < 0) throw new Error('Unrecognized poll response');
      result[slug] = counts[slug];
    });
    return result;
  }

  function readOperationResult(payload, operation) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || typeof payload.applied !== 'boolean') {
      throw new Error('Unrecognized poll response');
    }
    if (payload.operation_id !== operation.operation_id || payload.option !== operation.option || payload.action !== operation.action) {
      throw new Error('Mismatched operation response');
    }
    return {
      operation_id: payload.operation_id,
      option: payload.option,
      action: payload.action,
      applied: payload.applied,
      counts: readCounts(payload)
    };
  }

  function createPollClient(options) {
    const settings = options || {};
    const fetchImpl = settings.fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    const apiBase = String(settings.apiBase || DEFAULT_API_BASE).replace(/\/$/, '');
    const timeoutMs = Number(settings.timeoutMs) || 6500;
    if (!fetchImpl) throw new Error('Fetch is unavailable');

    async function request(path, requestOptions, reader) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(apiBase + path, { ...requestOptions, signal: controller.signal });
        if (response.status === 409) throw new OperationConflictError();
        if (!response.ok) throw new Error(`Poll request failed (${response.status})`);
        return reader(await response.json());
      } finally {
        clearTimeout(timer);
      }
    }

    return {
      loadAll() {
        return request('/v1/results', {
          method: 'GET', mode: 'cors', cache: 'no-store', credentials: 'omit',
          headers: { Accept: 'application/json' }
        }, readCounts);
      },
      operate(operation) {
        if (!operation || typeof operation.operation_id !== 'string' || !isValidSlug(operation.option) || !['vote', 'withdraw'].includes(operation.action)) {
          return Promise.reject(new Error('Invalid poll operation'));
        }
        return request('/v1/operation', {
          method: 'POST', mode: 'cors', cache: 'no-store', credentials: 'omit',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify({
            operation_id: operation.operation_id,
            option: operation.option,
            action: operation.action
          })
        }, (payload) => readOperationResult(payload, operation));
      }
    };
  }

  function safeStorage(storage) {
    try {
      const probe = STORAGE_KEY + '-probe';
      storage.setItem(probe, '1');
      storage.removeItem(probe);
      return storage;
    } catch (_) {
      return null;
    }
  }

  function parseMarker(value) {
    const match = MARKER_RE.exec(String(value || ''));
    if (!match) return null;
    return {
      kind: match[1],
      operation: { action: match[2], option: match[3], operation_id: match[4] }
    };
  }

  function marker(kind, operation) {
    return `${kind}:${operation.action}:${operation.option}:${operation.operation_id}`;
  }

  function sameOperation(left, right) {
    return Boolean(left && right && left.operation_id === right.operation_id && left.option === right.option && left.action === right.action);
  }

  function createVoteState(storage, tokenFactory) {
    let selected = null;
    let busy = false;
    let pending = null;
    let retry = null;
    const makeToken = tokenFactory || randomOperationId;

    function syncFromStorage() {
      if (!storage) return null;
      try {
        const saved = storage.getItem(STORAGE_KEY);
        const parsed = parseMarker(saved);
        selected = isValidSlug(saved) ? saved : (parsed && parsed.operation.action === 'withdraw' ? parsed.operation.option : null);
        busy = Boolean(parsed && parsed.kind === 'pending');
        pending = busy ? parsed.operation : null;
        retry = parsed && parsed.kind === 'retry' ? parsed.operation : null;
        return saved;
      } catch (_) {
        storage = null;
        selected = null;
        busy = false;
        pending = null;
        retry = null;
        return null;
      }
    }

    if (storage) syncFromStorage();

    function begin(action, slug) {
      if (!storage || busy || !isValidSlug(slug) || !['vote', 'withdraw'].includes(action)) return null;
      syncFromStorage();
      if (busy) return null;
      if (retry) {
        if (retry.action !== action || retry.option !== slug) return null;
        const retrying = retry;
        const pendingValue = marker('pending', retrying);
        try {
          storage.setItem(STORAGE_KEY, pendingValue);
          if (storage.getItem(STORAGE_KEY) !== pendingValue) {
            syncFromStorage();
            return null;
          }
          busy = true;
          pending = retrying;
          retry = null;
          return { ...retrying };
        } catch (_) {
          storage = null;
          return null;
        }
      }
      if ((action === 'vote' && selected) || (action === 'withdraw' && selected !== slug)) return null;
      if (action === 'withdraw' && !selected) return null;
      const operation = { operation_id: String(makeToken()), option: slug, action };
      const pendingValue = marker('pending', operation);
      try {
        storage.setItem(STORAGE_KEY, pendingValue);
        if (storage.getItem(STORAGE_KEY) !== pendingValue) {
          syncFromStorage();
          return null;
        }
        busy = true;
        pending = operation;
        retry = null;
        return { ...operation };
      } catch (_) {
        storage = null;
        return null;
      }
    }

    function commit(operation) {
      if (!storage || !busy || !sameOperation(operation, pending)) return false;
      const pendingValue = marker('pending', operation);
      try {
        if (storage.getItem(STORAGE_KEY) !== pendingValue) {
          syncFromStorage();
          return false;
        }
        if (operation.action === 'vote') storage.setItem(STORAGE_KEY, operation.option);
        else storage.removeItem(STORAGE_KEY);
        selected = operation.action === 'vote' ? operation.option : null;
        busy = false;
        pending = null;
        retry = null;
        return true;
      } catch (_) {
        storage = null;
        busy = false;
        pending = null;
        return false;
      }
    }

    function fail(operation) {
      if (!sameOperation(operation, pending)) return false;
      try {
        if (storage && storage.getItem(STORAGE_KEY) === marker('pending', operation)) {
          storage.setItem(STORAGE_KEY, marker('retry', operation));
        }
      } catch (_) {
        storage = null;
      }
      selected = operation.action === 'withdraw' ? operation.option : null;
      busy = false;
      pending = null;
      retry = operation;
      return true;
    }

    function conflict(operation) {
      if (!sameOperation(operation, pending)) return false;
      const pendingValue = marker('pending', operation);
      try {
        if (storage && storage.getItem(STORAGE_KEY) === pendingValue) {
          storage.removeItem(STORAGE_KEY);
        } else if (storage) {
          syncFromStorage();
          return false;
        }
      } catch (_) {
        storage = null;
      }
      selected = operation.action === 'withdraw' ? operation.option : null;
      busy = false;
      pending = null;
      retry = null;
      return true;
    }

    return {
      hasStorage() { return Boolean(storage); },
      getSelected() { return selected; },
      isBusy() { return busy; },
      getPending() { return pending ? { ...pending } : null; },
      getRetry() { return retry ? { ...retry } : null; },
      begin,
      commit,
      fail,
      conflict,
      clear() {
        try { if (storage) storage.removeItem(STORAGE_KEY); } catch (_) { storage = null; }
        selected = null;
        busy = false;
        pending = null;
        retry = null;
      },
      sync() {
        syncFromStorage();
        return selected;
      }
    };
  }

  function startPoll(options) {
    const settings = options || {};
    const documentRef = settings.documentRef || document;
    const windowRef = Object.prototype.hasOwnProperty.call(settings, 'windowRef') ? settings.windowRef : (typeof window !== 'undefined' ? window : null);
    let storageCandidate = settings.storage;
    if (!Object.prototype.hasOwnProperty.call(settings, 'storage')) {
      try { storageCandidate = window.localStorage; } catch (_) { storageCandidate = null; }
    }
    const storage = safeStorage(storageCandidate);
    const client = settings.client || createPollClient(settings.clientOptions);
    const status = documentRef.getElementById('poll-status');
    const cards = Array.from(documentRef.querySelectorAll('[data-poll-slug]'));
    const buttons = Array.from(documentRef.querySelectorAll('[data-vote]'));
    const counts = new Map(Array.from(documentRef.querySelectorAll('[data-count]')).map((node) => [node.dataset.count, node]));
    const voteState = createVoteState(storage, settings.tokenFactory);
    let countEpoch = 0;

    function announce(message) {
      if (status) status.textContent = message;
    }

    function renderSelection() {
      const selected = voteState.getSelected();
      const pending = voteState.getPending();
      const retry = voteState.getRetry();
      cards.forEach((card) => card.classList.toggle('is-selected', card.dataset.pollSlug === selected));
      buttons.forEach((button) => {
        const slug = button.dataset.vote;
        const isSelected = slug === selected;
        const isPending = Boolean(pending && pending.option === slug);
        const isFailed = Boolean(retry && retry.option === slug);
        if (!voteState.hasStorage() || voteState.isBusy()) button.disabled = true;
        else if (selected) button.disabled = !isSelected;
        else if (retry) button.disabled = !isFailed;
        else button.disabled = false;
        const label = button.firstChild;
        if (label) {
          if (isPending && pending.action === 'withdraw') label.textContent = '正在撤回… ';
          else if (isPending) label.textContent = '正在投票… ';
          else if (isFailed && retry.action === 'withdraw') label.textContent = '撤回失败，请重试 ';
          else if (isFailed) label.textContent = '投票失败，请重试 ';
          else if (isSelected) label.textContent = '撤回这一票 ';
          else label.textContent = '投这一处 ';
        }
        button.setAttribute('aria-pressed', String(isSelected));
      });
    }

    function renderCount(slug, value) {
      const node = counts.get(slug);
      if (node) {
        node.textContent = String(value);
        node.setAttribute('aria-label', `当前${value}票`);
      }
      const button = buttons.find((item) => item.dataset.vote === slug);
      if (button) {
        const base = button.dataset.baseLabel || (typeof button.getAttribute === 'function' && button.getAttribute('aria-label')) || '投票';
        button.dataset.baseLabel = base.replace(/，当前\d+票$/, '');
        button.setAttribute('aria-label', `${button.dataset.baseLabel}，当前${value}票`);
      }
    }

    function renderCounts(snapshot) {
      POLL_SLUGS.forEach((slug) => renderCount(slug, snapshot[slug]));
    }

    async function loadCounts(announceState = true) {
      const requestEpoch = ++countEpoch;
      try {
        const snapshot = await client.loadAll();
        if (countEpoch !== requestEpoch) return snapshot;
        renderCounts(snapshot);
        if (announceState) {
          if (!voteState.hasStorage()) announce('浏览器未开放本地存储，暂时不能投票；票数与房源链接仍可查看。');
          else if (voteState.getRetry()) announce(voteState.getRetry().action === 'withdraw' ? '撤回失败，请重试；原选择仍然保留。' : '投票失败，请重试；不会重复计票。');
          else if (voteState.getSelected()) announce('你已投过一票；可点绿色选项撤回，再选择另一处。');
          else announce('票数已更新。选中喜欢的一处，之后也可以撤回重选。');
        }
        return snapshot;
      } catch (_) {
        if (announceState && countEpoch === requestEpoch) announce('暂时无法读取共享票数，可能是网络限制；看房源和页面其他内容不受影响。');
        return null;
      }
    }

    async function perform(operation) {
      countEpoch += 1;
      renderSelection();
      announce(operation.action === 'withdraw' ? '正在撤回这一票…' : '正在送出这一票…');
      try {
        await client.operate(operation);
        countEpoch += 1;
        const committed = voteState.commit(operation);
        renderSelection();
        if (!committed) {
          voteState.sync();
          await loadCounts(false);
          announce('操作已记入共享票数；本页选择状态已按其他页面同步。');
          return false;
        }
        const refreshed = await loadCounts(false);
        if (operation.action === 'withdraw') announce('已撤回这一票，现在可以选择另一处。');
        else announce('已记下你的选择。点绿色选项可以撤回后重选。');
        if (!refreshed) announce(operation.action === 'withdraw' ? '已撤回这一票；共享票数暂时无法刷新。' : '已记下你的选择；共享票数暂时无法刷新。');
        return true;
      } catch (error) {
        countEpoch += 1;
        if (error instanceof OperationConflictError) {
          voteState.conflict(operation);
          announce('操作编号冲突，未更改共享票数；请重新点击生成新的操作编号。');
          return false;
        }
        voteState.fail(operation);
        if (operation.action === 'withdraw') announce('撤回失败，请重试；原选择仍然保留。看房源和页面其他内容不受影响。');
        else announce('这一票暂时没有送出，请重试；看房源和页面其他内容不受影响。');
        return false;
      } finally {
        renderSelection();
      }
    }

    function vote(slug) {
      const action = voteState.getSelected() === slug ? 'withdraw' : 'vote';
      const operation = voteState.begin(action, slug);
      if (!operation) return Promise.resolve(false);
      return perform(operation);
    }

    buttons.forEach((button) => {
      button.addEventListener('click', () => vote(button.dataset.vote));
    });
    documentRef.querySelectorAll('[data-listing-link]').forEach((link) => {
      link.addEventListener('click', (event) => event.stopPropagation());
    });
    if (windowRef && typeof windowRef.addEventListener === 'function') {
      windowRef.addEventListener('storage', (event) => {
        if (event.key !== STORAGE_KEY) return;
        const selected = voteState.sync();
        renderSelection();
        if (voteState.getRetry()) announce('另一页面的操作需要重试；不会使用新的操作编号重复计票。');
        else if (selected) announce('这台设备已在另一个页面完成选择；可点绿色选项撤回。');
        else announce('另一页面已撤回选择，现在可以重新投票。');
        loadCounts(false);
      });
    }

    const interrupted = voteState.getPending();
    renderSelection();
    if (!voteState.hasStorage()) announce('浏览器未开放本地存储，暂时不能投票；仍可查看票数和房源。');
    loadCounts();
    if (interrupted) perform(interrupted);

    return { loadCounts, vote, getSelected: () => voteState.getSelected() };
  }

  return {
    DEFAULT_API_BASE,
    POLL_SLUGS,
    STORAGE_KEY,
    OperationConflictError,
    isValidSlug,
    randomOperationId,
    readCounts,
    readOperationResult,
    createPollClient,
    createVoteState,
    startPoll
  };
});

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FreasonPoll = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const DEFAULT_API_BASE = 'https://api.counterapi.dev/v1/freason-august-2026';
  const POLL_SLUGS = Object.freeze(['jucheng', 'sengui', 'tingshan', 'xiangxi']);
  const STORAGE_KEY = 'freason-august-2026-poll-v1';

  function isValidSlug(value) {
    return POLL_SLUGS.includes(value);
  }

  function readCount(payload) {
    const isObject = payload !== null && typeof payload === 'object' && !Array.isArray(payload);
    const data = isObject && payload.data !== null && typeof payload.data === 'object' && !Array.isArray(payload.data)
      ? payload.data
      : null;
    const candidates = isObject ? [
      payload.count,
      payload.value,
      payload.up_count,
      data && data.count,
      data && data.value,
      data && data.up_count
    ] : [];
    const isNumericCount = (value) => {
      if (typeof value === 'number') return Number.isFinite(value);
      if (typeof value === 'string') return value.trim() !== '' && Number.isFinite(Number(value));
      return false;
    };
    const count = candidates.find(isNumericCount);
    if (count === undefined) throw new Error('Unrecognized counter response');
    return Math.max(0, Math.trunc(Number(count)));
  }

  function createCounterClient(options) {
    const settings = options || {};
    const fetchImpl = settings.fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    const apiBase = String(settings.apiBase || DEFAULT_API_BASE).replace(/\/$/, '');
    const timeoutMs = Number(settings.timeoutMs) || 6500;
    if (!fetchImpl) throw new Error('Fetch is unavailable');

    async function request(slug, increment) {
      if (!isValidSlug(slug)) throw new Error('Unknown poll option');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const path = increment ? `/${slug}/up/` : `/${slug}/`;
      try {
        const response = await fetchImpl(apiBase + path, {
          method: 'GET',
          mode: 'cors',
          cache: 'no-store',
          credentials: 'omit',
          headers: { Accept: 'application/json' },
          signal: controller.signal
        });
        if (!increment && response.status === 400) return 0;
        if (!response.ok) throw new Error(`Counter request failed (${response.status})`);
        return readCount(await response.json());
      } finally {
        clearTimeout(timer);
      }
    }

    return {
      getCount(slug) { return request(slug, false); },
      increment(slug) { return request(slug, true); },
      async loadAll() {
        const settled = await Promise.allSettled(POLL_SLUGS.map((slug) => request(slug, false)));
        return POLL_SLUGS.map((slug, index) => ({ slug, result: settled[index] }));
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

  function pendingSlug(value) {
    const match = /^pending:(jucheng|sengui|tingshan|xiangxi):[^:]+$/.exec(String(value || ''));
    return match ? match[1] : null;
  }

  function createVoteState(storage, tokenFactory) {
    let selected = null;
    let busy = false;
    let pendingValue = null;
    const makeToken = tokenFactory || (() => {
      if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
      return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    });

    function syncFromStorage() {
      if (!storage) return null;
      try {
        const saved = storage.getItem(STORAGE_KEY);
        if (isValidSlug(saved)) selected = saved;
        else {
          const interrupted = pendingSlug(saved);
          selected = interrupted || null;
        }
        return saved;
      } catch (_) {
        storage = null;
        return null;
      }
    }

    if (storage) syncFromStorage();

    return {
      hasStorage() { return Boolean(storage); },
      getSelected() { return selected; },
      isBusy() { return busy; },
      begin(slug) {
        if (!storage || busy || selected || !isValidSlug(slug)) return false;
        try {
          const current = storage.getItem(STORAGE_KEY);
          if (isValidSlug(current) || pendingSlug(current)) {
            syncFromStorage();
            return false;
          }
          pendingValue = `pending:${slug}:${String(makeToken())}`;
          storage.setItem(STORAGE_KEY, pendingValue);
          if (storage.getItem(STORAGE_KEY) !== pendingValue) {
            pendingValue = null;
            syncFromStorage();
            return false;
          }
          busy = true;
          return true;
        } catch (_) {
          pendingValue = null;
          return false;
        }
      },
      commit(slug) {
        if (!storage || !busy || !isValidSlug(slug)) return false;
        if (storage.getItem(STORAGE_KEY) !== pendingValue) {
          busy = false;
          pendingValue = null;
          syncFromStorage();
          return false;
        }
        storage.setItem(STORAGE_KEY, slug);
        selected = slug;
        busy = false;
        pendingValue = null;
        return true;
      },
      rollback() {
        if (storage && busy && storage.getItem(STORAGE_KEY) === pendingValue) storage.removeItem(STORAGE_KEY);
        busy = false;
        pendingValue = null;
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
    const client = settings.client || createCounterClient(settings.clientOptions);
    const status = documentRef.getElementById('poll-status');
    const cards = Array.from(documentRef.querySelectorAll('[data-poll-slug]'));
    const buttons = Array.from(documentRef.querySelectorAll('[data-vote]'));
    const counts = new Map(Array.from(documentRef.querySelectorAll('[data-count]')).map((node) => [node.dataset.count, node]));
    const voteState = createVoteState(storage, settings.tokenFactory);
    const countVersions = new Map(POLL_SLUGS.map((slug) => [slug, 0]));

    function announce(message) {
      if (status) status.textContent = message;
    }

    function renderSelection() {
      const selected = voteState.getSelected();
      cards.forEach((card) => card.classList.toggle('is-selected', card.dataset.pollSlug === selected));
      buttons.forEach((button) => {
        button.disabled = Boolean(selected) || voteState.isBusy() || !voteState.hasStorage();
        const isSelected = button.dataset.vote === selected;
        const label = button.firstChild;
        if (label) label.textContent = isSelected ? '已选这处 ' : '投这一处 ';
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

    async function loadCounts() {
      const startedAt = new Map(countVersions);
      const rows = await client.loadAll();
      let failures = 0;
      rows.forEach(({ slug, result }) => {
        if (result.status === 'fulfilled' && countVersions.get(slug) === startedAt.get(slug)) renderCount(slug, result.value);
        else if (result.status !== 'fulfilled') failures += 1;
      });
      if (!voteState.hasStorage()) announce('浏览器未开放本地存储，暂时不能投票；票数与房源链接仍可查看。');
      else if (voteState.getSelected()) announce('你已投过一票，绿色卡片是这台设备的选择。');
      else if (failures === 0) announce('票数已更新。选中喜欢的一处，每台设备只能投一票。');
      else if (failures < POLL_SLUGS.length) announce('部分票数暂时没有读到，仍可投票或直接看房源。');
      else announce('暂时无法读取共享票数，可能是网络限制；看房源和页面其他内容不受影响。');
      return rows;
    }

    async function vote(slug) {
      if (!voteState.begin(slug)) return false;
      renderSelection();
      announce('正在送出这一票…');
      try {
        const value = await client.increment(slug);
        countVersions.set(slug, countVersions.get(slug) + 1);
        if (!voteState.commit(slug)) throw new Error('Vote ownership changed');
        renderCount(slug, value);
        announce('已记下你的选择。绿色卡片是这台设备投出的选项。');
        return true;
      } catch (_) {
        voteState.rollback();
        announce('这一票暂时没有送出，请稍后再试；看房源和页面其他内容不受影响。');
        return false;
      } finally {
        renderSelection();
      }
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
        if (selected) announce('这台设备已在另一个页面完成或开始投票，为避免重复已锁定选择。');
      });
    }

    renderSelection();
    if (!voteState.hasStorage()) announce('浏览器未开放本地存储，暂时不能投票；仍可查看票数和房源。');
    loadCounts().catch(() => {
      announce('暂时无法读取共享票数，可能是网络限制；看房源和页面其他内容不受影响。');
    });

    return { loadCounts, vote, getSelected: () => voteState.getSelected() };
  }

  return { DEFAULT_API_BASE, POLL_SLUGS, STORAGE_KEY, isValidSlug, readCount, createCounterClient, createVoteState, startPoll };
});

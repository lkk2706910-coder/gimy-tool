/* Gimy 追劇站 — 前端邏輯
 * - 從同源的 data/videos.json 載入影劇資料 (由 GitHub Actions 爬蟲產生)
 * - 搜尋、分類過濾、排序
 * - 最愛 (localStorage)，並偵測最愛影劇的「新集數」
 * - 透過瀏覽器 Notification API 提醒新集數
 */
(() => {
  'use strict';

  const FAV_KEY = 'gimy.favorites.v1';
  const $ = (sel) => document.querySelector(sel);

  const state = {
    videos: [],
    meta: {},
    view: 'all', // 'all' | 'favorites'
    category: '全部',
    search: '',
    sort: 'time-desc',
  };

  // ---------- localStorage: 最愛 ----------
  function loadFavs() {
    try {
      return JSON.parse(localStorage.getItem(FAV_KEY)) || {};
    } catch {
      return {};
    }
  }
  function saveFavs(favs) {
    localStorage.setItem(FAV_KEY, JSON.stringify(favs));
  }
  let favs = loadFavs();

  function isFav(id) {
    return Object.prototype.hasOwnProperty.call(favs, id);
  }
  function addFav(v) {
    favs[v.id] = {
      id: v.id,
      name: v.name,
      // 記錄「加入當下」看到的進度，作為日後比對新集數的基準
      seenEpisodes: v.episodes || 0,
      seenRemarks: v.remarks || '',
      seenUpdateTime: v.updateTime || '',
      notifiedUpdateTime: v.updateTime || '',
      addedAt: new Date().toISOString(),
    };
    saveFavs(favs);
  }
  function removeFav(id) {
    delete favs[id];
    saveFavs(favs);
  }
  // 將某最愛標記為「已看到最新進度」(清除新集數標記)
  function markSeen(v) {
    const f = favs[v.id];
    if (!f) return;
    f.seenEpisodes = v.episodes || 0;
    f.seenRemarks = v.remarks || '';
    f.seenUpdateTime = v.updateTime || '';
    f.notifiedUpdateTime = v.updateTime || '';
    saveFavs(favs);
  }

  // 判斷某影劇相對於最愛快照是否有新集數
  function hasNewEpisode(v) {
    const f = favs[v.id];
    if (!f) return false;
    if ((v.episodes || 0) > (f.seenEpisodes || 0)) return true;
    if (v.remarks && f.seenRemarks && v.remarks !== f.seenRemarks) {
      // remarks 變了 (例如「更新至19集」→「更新至20集」或「完結」) 也視為更新
      if ((v.updateTime || '') > (f.seenUpdateTime || '')) return true;
    }
    return false;
  }

  // ---------- 資料載入 ----------
  async function loadData() {
    const bust = `?t=${Date.now()}`;
    const [videos, meta] = await Promise.all([
      fetch(`data/videos.json${bust}`).then((r) => (r.ok ? r.json() : [])).catch(() => []),
      fetch(`data/meta.json${bust}`).then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
    ]);
    state.videos = Array.isArray(videos) ? videos : [];
    state.meta = meta || {};
  }

  // ---------- 過濾 / 排序 ----------
  function categories() {
    const set = new Set();
    state.videos.forEach((v) => v.type && set.add(v.type));
    return ['全部', ...[...set].sort((a, b) => a.localeCompare(b, 'zh-Hant'))];
  }

  function filtered() {
    let list = state.videos;
    if (state.view === 'favorites') {
      list = list.filter((v) => isFav(v.id));
    }
    if (state.category !== '全部') {
      list = list.filter((v) => v.type === state.category);
    }
    const q = state.search.trim().toLowerCase();
    if (q) {
      list = list.filter((v) =>
        [v.name, v.actor, v.director, v.type, v.area]
          .filter(Boolean)
          .some((s) => s.toLowerCase().includes(q))
      );
    }
    return sortList(list);
  }

  function sortList(list) {
    const arr = [...list];
    const cmp = {
      'time-desc': (a, b) => (b.updateTime || '').localeCompare(a.updateTime || ''),
      'time-asc': (a, b) => (a.updateTime || '').localeCompare(b.updateTime || ''),
      'ep-desc': (a, b) => (b.episodes || 0) - (a.episodes || 0),
      'ep-asc': (a, b) => (a.episodes || 0) - (b.episodes || 0),
      'name-asc': (a, b) => (a.name || '').localeCompare(b.name || '', 'zh-Hant'),
      'score-desc': (a, b) => (parseFloat(b.score) || 0) - (parseFloat(a.score) || 0),
    }[state.sort];
    return cmp ? arr.sort(cmp) : arr;
  }

  // ---------- 算繪 ----------
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );
  }

  function cardHTML(v) {
    const fav = isFav(v.id);
    const isNew = fav && hasNewEpisode(v);
    const posterInner = v.pic
      ? `<img src="${esc(v.pic)}" alt="${esc(v.name)}" loading="lazy" referrerpolicy="no-referrer"
            onerror="this.style.display='none';this.nextElementSibling.style.display='flex';" />
         <div class="poster-fallback" style="display:none">${esc(v.name)}</div>`
      : `<div class="poster-fallback">${esc(v.name)}</div>`;

    const meta = [
      v.type && esc(v.type),
      v.area && esc(v.area),
      v.year && esc(v.year),
      v.score && `<span class="score">★ ${esc(v.score)}</span>`,
    ]
      .filter(Boolean)
      .join('<span>·</span>');

    const detail = v.detailUrl || '#';
    const play = v.playUrl || v.detailUrl || '#';

    return `
      <article class="card" data-id="${esc(v.id)}">
        <div class="poster">
          ${isNew ? '<span class="new-flag">NEW 新集數</span>' : ''}
          <button class="fav-toggle ${fav ? 'on' : ''}" data-fav="${esc(v.id)}"
                  title="${fav ? '移除最愛' : '加入最愛'}" aria-label="加入最愛">${fav ? '❤' : '♡'}</button>
          ${posterInner}
          ${v.remarks ? `<span class="remarks-tag">${esc(v.remarks)}</span>` : ''}
        </div>
        <div class="card-body">
          <div class="card-title" title="${esc(v.name)}">${esc(v.name)}</div>
          <div class="card-meta">${meta}</div>
          <div class="card-time">${v.updateTime ? '更新 ' + esc(v.updateTime) : ''}</div>
          <div class="card-actions">
            <a class="primary" href="${esc(play)}" target="_blank" rel="noopener" data-seen="${esc(v.id)}" title="直接播放最新一集">▶ 觀看</a>
            <button class="ep-btn" data-eps="${esc(v.id)}" title="選集（最新在最上面）">選集</button>
            <a href="${esc(detail)}" target="_blank" rel="noopener" data-seen="${esc(v.id)}">詳情</a>
          </div>
        </div>
      </article>`;
  }

  function render() {
    $('#fav-count').textContent = Object.keys(favs).length;
    if (state.view === 'calendar') {
      renderCalendar();
      renderMeta();
      return;
    }
    const list = filtered();
    const grid = $('#grid');
    const empty = $('#empty');
    grid.classList.remove('calendar-mode');

    grid.innerHTML = list.map(cardHTML).join('');
    $('#result-count').textContent = `共 ${list.length} 部影劇`;

    if (!list.length) {
      empty.hidden = false;
      empty.textContent =
        state.view === 'favorites'
          ? '尚未加入任何最愛。點擊影劇右上角的 ♡ 即可收藏，並在有新集數時收到提醒。'
          : '找不到符合的影劇，換個關鍵字或分類試試。';
    } else {
      empty.hidden = true;
    }

    $('#fav-count').textContent = Object.keys(favs).length;
    renderMeta();
  }

  function renderMeta() {
    const el = $('#data-meta');
    const m = state.meta || {};
    if (m.lastUpdated) {
      const d = new Date(m.lastUpdated);
      el.textContent = `資料更新：${d.toLocaleString('zh-TW', { hour12: false })}${m.count ? `（共 ${m.count} 筆）` : ''}`;
    } else if (m.source === 'seed') {
      el.textContent = '目前顯示示範資料，爬蟲首次執行後將更新為真實資料。';
    } else {
      el.textContent = '';
    }
  }

  function renderCategories() {
    const wrap = $('#cat-filter');
    wrap.innerHTML = categories()
      .map(
        (c) =>
          `<button class="cat-chip ${c === state.category ? 'active' : ''}" data-cat="${esc(c)}">${esc(c)}</button>`
      )
      .join('');
  }

  // ---------- 追劇週曆 ----------
  const WEEK_NAMES = ['', '週一', '週二', '週三', '週四', '週五', '週六', '週日'];

  function todayWeekday() {
    const d = new Date().getDay(); // 0=日 … 6=六
    return d === 0 ? 7 : d;
  }

  function isFinished(v) {
    return /完結|完结|大結局|大结局|全集|全\d+集/.test(v.remarks || '');
  }

  function calRowHTML(v) {
    const isNew = isFav(v.id) && hasNewEpisode(v);
    const poster = v.pic
      ? `<img src="${esc(v.pic)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.visibility='hidden'">`
      : '';
    const sub = [v.type, v.remarks].filter(Boolean).map(esc).join(' · ');
    const upd = v.updateTime ? ` · 🕒最近更新 ${esc(v.updateTime.slice(5, 16).replace('-', '/'))}` : '';
    return `
      <div class="cal-row">
        <div class="cal-poster">${poster}</div>
        <div class="cal-info">
          <div class="cal-name">${isNew ? '<span class="cal-new">NEW</span> ' : ''}${esc(v.name)}</div>
          <div class="cal-sub">${sub}${upd}</div>
        </div>
        <div class="cal-act">
          <a class="primary" href="${esc(v.playUrl || v.detailUrl)}" target="_blank" rel="noopener" data-seen="${esc(v.id)}">▶</a>
          <button class="ep-btn" data-eps="${esc(v.id)}">選集</button>
        </div>
      </div>`;
  }

  function renderCalendar() {
    const grid = $('#grid');
    const empty = $('#empty');
    grid.classList.add('calendar-mode');
    const favVideos = state.videos.filter((v) => isFav(v.id));

    $('#result-count').textContent = `我的最愛更新時間表（${favVideos.length} 部）`;

    if (!favVideos.length) {
      grid.innerHTML = '';
      empty.hidden = false;
      empty.textContent = '尚未加入任何最愛。先到「全部」收藏想追的劇，這裡就會排出每週更新時間表。';
      return;
    }
    empty.hidden = true;

    const days = { 1: [], 2: [], 3: [], 4: [], 5: [], 6: [], 7: [] };
    const irregular = [];
    const finished = [];
    for (const v of favVideos) {
      if (Array.isArray(v.weekdays) && v.weekdays.length) {
        v.weekdays.forEach((d) => days[d] && days[d].push(v));
      } else if (isFinished(v)) {
        finished.push(v);
      } else {
        irregular.push(v);
      }
    }
    const today = todayWeekday();
    const section = (title, list, opts = {}) => `
      <section class="cal-day${opts.today ? ' is-today' : ''}">
        <h3 class="cal-day-title">${esc(title)}${opts.today ? ' <span class="cal-today">今天</span>' : ''}
          <span class="cal-count">${list.length}</span></h3>
        <div class="cal-list">${
          list.length ? list.map(calRowHTML).join('') : '<div class="cal-none">本日無更新</div>'
        }</div>
      </section>`;

    let html = '';
    for (let d = 1; d <= 7; d++) html += section(WEEK_NAMES[d], days[d], { today: d === today });
    if (irregular.length) html += section('🔁 不定期 / 未標示', irregular);
    if (finished.length) html += section('✅ 已完結', finished);
    grid.innerHTML = `<div class="cal-wrap">${html}</div>`;
  }

  // ---------- 新集數提醒 ----------
  function detectUpdates() {
    const updated = state.videos.filter((v) => isFav(v.id) && hasNewEpisode(v));
    const banner = $('#update-banner');
    if (!updated.length) {
      banner.hidden = true;
      return [];
    }
    const names = updated.slice(0, 5).map((v) => v.name);
    const more = updated.length > 5 ? ` 等 ${updated.length} 部` : '';
    banner.hidden = false;
    banner.innerHTML =
      `🔔 你的最愛有新集數：<b>${names.map(esc).join('、')}</b>${more}！ ` +
      `<button id="goto-fav" class="ghost-btn" style="margin-left:8px">查看</button> ` +
      `<button id="mark-all" class="ghost-btn">全部標示已讀</button>`;

    $('#goto-fav').onclick = () => switchView('favorites');
    $('#mark-all').onclick = () => {
      updated.forEach(markSeen);
      detectUpdates();
      render();
    };
    return updated;
  }

  function fireNotifications(updated) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    updated.forEach((v) => {
      const f = favs[v.id];
      // 只在「比上次通知過的時間更新」時才再次通知，避免重複打擾
      if (f && (v.updateTime || '') > (f.notifiedUpdateTime || '')) {
        try {
          const n = new Notification(`《${v.name}》有新集數！`, {
            body: v.remarks ? `${v.remarks}` : '快去 Gimy 追劇站看看吧',
            icon: v.pic || undefined,
            tag: `gimy-${v.id}`,
          });
          n.onclick = () => {
            window.focus();
            window.open(v.playUrl || v.detailUrl, '_blank', 'noopener');
          };
        } catch {
          /* 某些環境不支援帶 icon 的通知 */
        }
        f.notifiedUpdateTime = v.updateTime || '';
      }
    });
    saveFavs(favs);
  }

  // ---------- 視圖切換 ----------
  function switchView(view) {
    state.view = view;
    document.querySelectorAll('.tab[data-view]').forEach((t) =>
      t.classList.toggle('active', t.dataset.view === view)
    );
    render();
  }

  // ---------- 事件 ----------
  function bindEvents() {
    // 搜尋 (debounce)
    let timer;
    $('#search').addEventListener('input', (e) => {
      clearTimeout(timer);
      const val = e.target.value;
      timer = setTimeout(() => {
        state.search = val;
        render();
      }, 180);
    });

    // 排序
    $('#sort').addEventListener('change', (e) => {
      state.sort = e.target.value;
      render();
    });

    // 分頁標籤
    document.querySelectorAll('.tab[data-view]').forEach((t) =>
      t.addEventListener('click', () => switchView(t.dataset.view))
    );

    // 分類 chip (事件委派)
    $('#cat-filter').addEventListener('click', (e) => {
      const chip = e.target.closest('[data-cat]');
      if (!chip) return;
      state.category = chip.dataset.cat;
      renderCategories();
      render();
    });

    // 卡片內的最愛切換 / 標記已看 (事件委派)
    $('#grid').addEventListener('click', (e) => {
      const epBtn = e.target.closest('[data-eps]');
      if (epBtn) {
        const v = state.videos.find((x) => x.id === epBtn.dataset.eps);
        if (v) openEpisodeModal(v);
        return;
      }
      const favBtn = e.target.closest('[data-fav]');
      if (favBtn) {
        const id = favBtn.dataset.fav;
        const v = state.videos.find((x) => x.id === id);
        if (!v) return;
        if (isFav(id)) removeFav(id);
        else addFav(v);
        detectUpdates();
        render();
        return;
      }
      // 點「觀看 / 詳情」時，視為已看到最新進度，清除新集數標記
      const seen = e.target.closest('[data-seen]');
      if (seen) {
        const v = state.videos.find((x) => x.id === seen.dataset.seen);
        if (v && isFav(v.id)) {
          markSeen(v);
          // 不立即重繪 (讓連結正常開啟)，下次互動會反映
          setTimeout(() => {
            detectUpdates();
            render();
          }, 50);
        }
      }
    });

    // 通知權限
    $('#notify-btn').addEventListener('click', requestNotify);
  }

  function refreshNotifyBtn() {
    const btn = $('#notify-btn');
    if (!('Notification' in window)) {
      btn.textContent = '🔕 不支援通知';
      btn.disabled = true;
      return;
    }
    if (Notification.permission === 'granted') {
      btn.textContent = '🔔 通知已開啟';
      btn.classList.add('enabled');
    } else if (Notification.permission === 'denied') {
      btn.textContent = '🔕 通知已封鎖';
    } else {
      btn.textContent = '🔔 開啟通知';
    }
  }

  async function requestNotify() {
    if (!('Notification' in window)) return;
    if (Notification.permission === 'default') {
      await Notification.requestPermission();
    }
    refreshNotifyBtn();
    if (Notification.permission === 'granted') {
      fireNotifications(state.videos.filter((v) => isFav(v.id) && hasNewEpisode(v)));
    }
  }

  // ---------- 選集視窗 (最新集在最上面) ----------
  const epCache = {};

  function ensureModal() {
    let modal = $('#ep-modal');
    if (modal) return modal;
    modal = document.createElement('div');
    modal.id = 'ep-modal';
    modal.className = 'ep-modal';
    modal.hidden = true;
    modal.innerHTML = `
      <div class="ep-backdrop" data-close></div>
      <div class="ep-dialog" role="dialog" aria-modal="true">
        <div class="ep-head">
          <div class="ep-title"></div>
          <button class="ep-close" data-close aria-label="關閉">✕</button>
        </div>
        <div class="ep-sub"></div>
        <div class="ep-list"></div>
      </div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click', (e) => {
      if (e.target.closest('[data-close]')) closeEpisodeModal();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !modal.hidden) closeEpisodeModal();
    });
    return modal;
  }

  function closeEpisodeModal() {
    const modal = $('#ep-modal');
    if (modal) modal.hidden = true;
    document.body.style.overflow = '';
  }

  async function openEpisodeModal(v) {
    const modal = ensureModal();
    modal.querySelector('.ep-title').textContent = v.name;
    modal.querySelector('.ep-sub').textContent = '載入選集中…';
    modal.querySelector('.ep-list').innerHTML = '';
    modal.hidden = false;
    document.body.style.overflow = 'hidden';

    // 開啟選集視為已看到最新進度，清除新集數標記
    if (isFav(v.id)) {
      markSeen(v);
      detectUpdates();
    }

    let data = epCache[v.id];
    if (!data) {
      try {
        const res = await fetch(`data/episodes/${encodeURIComponent(v.id)}.json`);
        data = res.ok ? await res.json() : null;
      } catch {
        data = null;
      }
      epCache[v.id] = data || { episodes: [] };
      data = epCache[v.id];
    }

    const eps = (data && data.episodes) || [];
    const sub = modal.querySelector('.ep-sub');
    const list = modal.querySelector('.ep-list');

    if (!eps.length) {
      sub.textContent = '目前沒有這部的選集資料，可前往原站查看。';
      list.innerHTML = `<a class="ep-fallback" href="${esc(v.detailUrl)}" target="_blank" rel="noopener">前往 Gimy 詳情頁 →</a>`;
      return;
    }

    const total = data.count || eps.length;
    sub.textContent =
      `共 ${total} 集，最新在最上面` + (total > eps.length ? `（顯示最新 ${eps.length} 集）` : '');
    // 反轉成「最新在前」
    const reversed = eps.slice().reverse();
    list.innerHTML = reversed
      .map(
        (ep, i) =>
          `<a class="ep-item${i === 0 ? ' newest' : ''}" href="${esc(ep.url)}" target="_blank" rel="noopener">${
            i === 0 ? '🆕 ' : ''
          }${esc(ep.label)}</a>`
      )
      .join('');
  }

  // ---------- 啟動 ----------
  async function init() {
    bindEvents();
    refreshNotifyBtn();
    await loadData();
    renderCategories();
    render();
    const updated = detectUpdates();
    fireNotifications(updated);
  }

  init();
})();

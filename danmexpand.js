// ==UserScript==
// @name         B站直播弹幕拓展
// @namespace    local.bili-danmexpand
// @version      1.8.0
// @description  举报、回复、加1、收藏功能
// @match        https://live.bilibili.com/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @grant        GM_removeValueChangeListener
// @grant        unsafeWindow
// @noframes
// @license      MIT
// ==/UserScript==

(function(){
'use strict';
'use strict';

/** Local-only favorites. Await ready before reading list/exportData. Mutations
 * return a Promise of { ok, reason, item?, duplicate?, ... }; a failed write
 * leaves the previously saved in-memory list intact. */
function createBiliFavoriteStore(env = {}) {
  const KEY = 'bili_danmaku_favorites_v1';
  const SCHEMA = 'bili-danmaku-favorites';
  const LIMIT = 1000;
  const globals = typeof globalThis === 'object' ? globalThis : {};
  const now = typeof env.now === 'function' ? env.now : Date.now;
  const subscribers = new Set();
  let items = [], queue = Promise.resolve(), disposed = false, readFailure = '', listenerID = null, storageListener = null, serial = 0;

  function api(name, short) {
    if (typeof env[name] === 'function') return env[name].bind(env);
    if (env.GM && typeof env.GM[short] === 'function') return env.GM[short].bind(env.GM);
    if (typeof globals[name] === 'function') return globals[name].bind(globals);
    if (globals.GM && typeof globals.GM[short] === 'function') return globals.GM[short].bind(globals.GM);
    return null;
  }
  const gmGet = api('GM_getValue', 'getValue'), gmSet = api('GM_setValue', 'setValue');
  const gmListen = api('GM_addValueChangeListener', 'addValueChangeListener');
  const gmUnlisten = api('GM_removeValueChangeListener', 'removeValueChangeListener');
  const useGM = Boolean(gmGet && gmSet);
  let local = null;
  if (!useGM) { try { local = env.localStorage || globals.localStorage || null; } catch {} }
  const eventTarget = env.eventTarget || env.window || globals.window || globals;
  const addEvent = typeof env.addEventListener === 'function' ? env.addEventListener.bind(env) :
    typeof eventTarget.addEventListener === 'function' ? eventTarget.addEventListener.bind(eventTarget) : null;
  const removeEvent = typeof env.removeEventListener === 'function' ? env.removeEventListener.bind(env) :
    typeof eventTarget.removeEventListener === 'function' ? eventTarget.removeEventListener.bind(eventTarget) : null;
  let requestLock = null;
  try {
    const locks = env.navigator?.locks || globals.navigator?.locks;
    if (typeof locks?.request === 'function') requestLock = locks.request.bind(locks);
  } catch {}

  const own = (obj, name) => obj && typeof obj === 'object' ? Object.getOwnPropertyDescriptor(obj, name)?.value : undefined;
  const copy = item => ({ ...item });
  const list = () => items.map(copy);
  const normalize = text => text.replace(/\r\n?/g, '\n').trim();
  function iso(value = now()) {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
  }
  function optionalText(value, limit) {
    return typeof value === 'string' ? Array.from(normalize(value)).slice(0, limit).join('') : '';
  }
  function content(value) {
    if (typeof value !== 'string') return { ok: false, reason: '收藏内容必须是文字' };
    const text = normalize(value), length = Array.from(text).length;
    return length >= 1 && length <= 1000 ? { ok: true, text } : { ok: false, reason: '收藏内容需为 1 至 1000 个字符' };
  }
  function makeID(used) {
    const crypto = env.crypto || globals.crypto;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const id = crypto?.randomUUID?.();
        if (typeof id === 'string' && id && !used.has(id)) return id;
      } catch {}
    }
    let id;
    do { id = `fav-${Number(now()).toString(36)}-${(++serial).toString(36)}-${Math.random().toString(36).slice(2, 12)}`; }
    while (used.has(id));
    return id;
  }
  function sanitize(value, used, stamp = iso()) {
    const checked = content(own(value, 'text'));
    if (!checked.ok) return null;
    const givenID = own(value, 'id');
    const id = typeof givenID === 'string' && /^[a-zA-Z0-9_-]{1,120}$/.test(givenID) && !used.has(givenID) ? givenID : makeID(used);
    used.add(id);
    const room = own(value, 'room');
    return {
      id, text: checked.text, author: optionalText(own(value, 'author'), 100),
      room: typeof room === 'number' && Number.isFinite(room) ? String(room) : optionalText(room, 100),
      source: optionalText(own(value, 'source'), 500),
      createdAt: own(value, 'createdAt') == null ? stamp : iso(own(value, 'createdAt')),
      updatedAt: own(value, 'updatedAt') == null ? stamp : iso(own(value, 'updatedAt'))
    };
  }
  function unpack(value, allowArray = false) {
    if (typeof value === 'string') {
      if (value.length > 8 * 1024 * 1024) throw new Error('导入或存储数据过大');
      value = JSON.parse(value);
    }
    if (allowArray && Array.isArray(value)) return value;
    if (!value || typeof value !== 'object' || own(value, 'schema') !== SCHEMA || own(value, 'version') !== 1 || !Array.isArray(own(value, 'items'))) {
      throw new Error('数据格式不正确，需要版本 1 的弹幕收藏 JSON');
    }
    return own(value, 'items');
  }
  function loaded(value) {
    if (value == null || value === '') return [];
    const raw = unpack(value), used = new Set(), texts = new Set(), result = [], stamp = iso();
    for (const entry of raw) {
      const item = sanitize(entry, used, stamp);
      if (!item || texts.has(item.text)) continue;
      texts.add(item.text); result.push(item);
      if (result.length === LIMIT) break;
    }
    return result;
  }
  function notify(result = { ok: true, reason: '' }) {
    if (disposed) return;
    for (const fn of subscribers) { try { fn(list(), result); } catch {} }
  }
  function failure(reason, extra = {}) { return { ok: false, reason, ...extra }; }
  async function read() {
    if (useGM) return await gmGet(KEY, null);
    if (!local || typeof local.getItem !== 'function') throw new Error('浏览器没有可用的本地存储');
    return local.getItem(KEY);
  }
  async function persist(next) {
    const value = { schema: SCHEMA, version: 1, items: next.map(copy) };
    if (useGM) {
      if (await gmSet(KEY, value) === false) throw new Error('收藏保存未成功');
    } else {
      if (!local || typeof local.setItem !== 'function') throw new Error('浏览器没有可用的本地存储');
      if (local.setItem(KEY, JSON.stringify(value)) === false) throw new Error('收藏保存未成功');
    }
  }
  async function commit(next, result) {
    try { await persist(next); }
    catch { return failure('本地保存失败，收藏未修改'); }
    items = next;
    notify(result);
    return result;
  }
  function enqueue(job, needsRead = true) {
    const result = queue.then(async () => {
      await ready;
      if (disposed) return failure('收藏存储已停止');
      if (!needsRead) {
        try { return await job(); } catch { return failure('收藏数据无法处理'); }
      }
      const modify = async () => {
        if (disposed) return failure('收藏存储已停止');
        let latest;
        try { latest = loaded(await read()); }
        catch { readFailure = '无法读取最新收藏，未保存任何修改'; return failure(readFailure); }
        if (disposed) return failure('收藏存储已停止');
        const refreshed = JSON.stringify(items) !== JSON.stringify(latest);
        // The write is based on current persistent data, not a potentially stale
        // per-tab snapshot. A rejected write retains this successfully read list.
        items = latest; readFailure = '';
        let outcome;
        try { outcome = await job(); } catch { outcome = failure('收藏数据无法处理'); }
        // commit already notifies after a successful write. When the operation
        // did not commit, still expose any newly read remote changes to the UI.
        if (refreshed && items === latest) notify({ ok: true, reason: '已同步其他页面的收藏' });
        return outcome;
      };
      if (!requestLock) return modify();
      try { return await requestLock(KEY, { mode: 'exclusive' }, modify); }
      catch { return failure('无法取得收藏存储锁，未保存任何修改'); }
    });
    queue = result.catch(() => {});
    return result;
  }
  function refreshRemote() {
    // Reread when this queued update executes: an older event must not replace
    // the result of a more recent completed local write.
    void enqueue(async () => {
      try {
        const latest = loaded(await read());
        if (disposed) return;
        items = latest; readFailure = ''; notify();
      }
      catch { readFailure = '无法读取收藏，未保存任何修改'; }
    }, false);
  }
  async function removeGMListener() {
    if (listenerID == null || !gmUnlisten) return;
    const id = listenerID; listenerID = null;
    try { await gmUnlisten(id); } catch {}
  }
  const ready = (async () => {
    try { items = loaded(await read()); }
    catch { readFailure = '无法读取收藏，未保存任何修改'; }
    if (!disposed && useGM && gmListen) {
      try {
        listenerID = await gmListen(KEY, (_name, _old, _next, remote) => { if (remote === true && !disposed) refreshRemote(); });
        if (disposed) await removeGMListener();
      } catch {}
    } else if (!disposed && !useGM && local && addEvent) {
      storageListener = event => {
        if (event.key !== KEY && event.key !== null) return;
        if (event.storageArea && event.storageArea !== local) return;
        refreshRemote();
      };
      try { addEvent('storage', storageListener); } catch { storageListener = null; }
    }
    const result = readFailure ? failure(readFailure) : { ok: true, reason: '' };
    notify(result);
    return result;
  })();

  function add(data) {
    return enqueue(async () => {
      const checked = content(own(data, 'text'));
      if (!checked.ok) return checked;
      const existing = items.find(item => item.text === checked.text);
      if (existing) return failure('这条内容已经收藏', { item: copy(existing), duplicate: true });
      if (items.length >= LIMIT) return failure('最多收藏 1000 条，请先删除部分收藏');
      const item = sanitize({ text: checked.text, author: own(data, 'author'), room: own(data, 'room'), source: own(data, 'source') }, new Set(items.map(item => item.id)));
      return commit([...items, item], { ok: true, reason: '已收藏', item: copy(item) });
    });
  }
  function update(id, patch) {
    return enqueue(async () => {
      const index = items.findIndex(item => item.id === id);
      if (index < 0) return failure('没有找到这条收藏');
      const previous = items[index], textValue = own(patch, 'text'), authorValue = own(patch, 'author');
      const checked = content(textValue === undefined ? previous.text : textValue);
      if (!checked.ok) return checked;
      const duplicate = items.find(item => item.id !== id && item.text === checked.text);
      if (duplicate) return failure('已有相同内容的收藏', { item: copy(duplicate), duplicate: true });
      if (authorValue !== undefined && typeof authorValue !== 'string') return failure('作者必须是文字');
      const author = authorValue === undefined ? previous.author : optionalText(authorValue, 100);
      if (checked.text === previous.text && author === previous.author) return { ok: true, reason: '内容未改变', item: copy(previous) };
      const item = { ...previous, text: checked.text, author, updatedAt: iso() };
      const next = items.slice(); next[index] = item;
      return commit(next, { ok: true, reason: '已保存修改', item: copy(item) });
    });
  }
  function remove(id) {
    return enqueue(async () => {
      const existing = items.find(item => item.id === id);
      if (!existing) return failure('没有找到这条收藏');
      return commit(items.filter(item => item.id !== id), { ok: true, reason: '已删除', item: copy(existing) });
    });
  }
  function clear() {
    return enqueue(async () => items.length ? commit([], { ok: true, reason: '已清空收藏' }) : { ok: true, reason: '收藏已经为空' });
  }
  function importItems(data) {
    return enqueue(async () => {
      let raw;
      try { raw = unpack(data, true); } catch { return failure('导入失败，需要有效的版本 1 弹幕收藏 JSON'); }
      const next = items.slice(), texts = new Set(items.map(item => item.text)), used = new Set(items.map(item => item.id)), stamp = iso();
      let added = 0, duplicates = 0, skipped = 0;
      for (const entry of raw) {
        const item = sanitize(entry, used, stamp);
        if (!item) { skipped++; continue; }
        if (texts.has(item.text)) { duplicates++; continue; }
        if (next.length >= LIMIT) { skipped++; continue; }
        texts.add(item.text); next.push(item); added++;
      }
      const result = { ok: true, reason: `已导入 ${added} 条，重复 ${duplicates} 条，跳过 ${skipped} 条`, added, duplicates, skipped };
      return added ? commit(next, result) : result;
    });
  }
  function exportData() { return { schema: SCHEMA, version: 1, exportedAt: iso(), items: list() }; }
  function subscribe(fn) {
    if (typeof fn !== 'function') throw new TypeError('subscriber must be a function');
    if (disposed) return () => {};
    subscribers.add(fn);
    return () => subscribers.delete(fn);
  }
  function dispose() {
    if (disposed) return;
    disposed = true; subscribers.clear();
    if (storageListener && removeEvent) { try { removeEvent('storage', storageListener); } catch {} }
    storageListener = null;
    void removeGMListener();
  }

  return { ready, list, add, update, remove, clear, importItems, exportData, subscribe, dispose };
}

'use strict';

function installBiliHoverActions(options = {}) {
  const page = options.pageWindow || window;
  const doc = page.document || document;
  const DOM_SELECTOR = '.bili-danmaku-x-dm.bili-danmaku-x-show';
  const PATCH_METHODS = ['handleSocketMessage', 'resize', 'onResize', 'set'];
  const hooks = [];
  let engine = null, enginePageKey = '', selection = null, disposed = false;
  let pollTimer, cooldownTimer, layoutFrame = null, repeatBusy = false, repeatUntil = 0, reportBusy = false;
  let lastPointer = null, pendingReport = null, nativeRuntime = null, appReportModulePromise = null;
  let hoverCursor = null;

  const host = doc.createElement('div');
  host.setAttribute('data-bili-favorite-hover-menu', '');
  host.style.cssText = 'position:fixed;z-index:2147483647;display:none;pointer-events:auto;';
  const shadow = host.attachShadow({ mode: 'closed' });
  const style = doc.createElement('style');
  style.textContent = `
    :host{color-scheme:dark;font:13px/1.4 -apple-system,BlinkMacSystemFont,"Microsoft YaHei",sans-serif}
    *{box-sizing:border-box}.menu{position:relative;display:flex;align-items:center;gap:3px;padding:5px 8px;background:#151515;border:1px solid #363636;border-radius:19px;box-shadow:0 3px 12px #0007;white-space:nowrap}
    .menu::before{content:"";position:absolute;top:-11px;left:var(--bdf-hover-arrow-left,50%);transform:translateX(-50%);border:6px solid transparent;border-bottom-color:#151515}
    :host([data-above="true"]) .menu::before{top:auto;bottom:-11px;border-bottom-color:transparent;border-top-color:#151515}
    button{font:inherit;color:#eee;cursor:pointer;border:0;background:transparent;border-radius:4px;padding:5px 11px;line-height:1.4}
    button:hover{background:#373737;color:#fff}button:focus-visible{outline:2px solid #00aeec;outline-offset:-1px}button:disabled{color:#797979;cursor:default;background:transparent}
  `;
  const menu = doc.createElement('div');
  menu.className = 'menu';
  menu.setAttribute('role', 'toolbar');
  menu.setAttribute('aria-label', '弹幕操作');
  function makeButton(label, kind) {
    const node = doc.createElement('button');
    node.type = 'button'; node.textContent = label;
    node.setAttribute('aria-label', label);
    node.addEventListener('pointerdown', event => {
      lastPointer = { x: event.clientX, y: event.clientY }; event.stopPropagation();
    });
    node.addEventListener('click', event => {
      event.preventDefault(); event.stopPropagation();
      // Sending and opening a native report both require a real user click.
      if (disposed || !selection || (kind === 'repeat' || kind === 'report') && event.isTrusted !== true) return;
      void runAction(kind);
    });
    return node;
  }
  const reportButton = makeButton('举报', 'report');
  const replyButton = makeButton('回复', 'reply');
  const repeatButton = makeButton('加1', 'repeat');
  const collectButton = makeButton('收藏', 'collect');
  menu.append(reportButton, replyButton, repeatButton, collectButton);
  shadow.append(style, menu);

  function mountHost() {
    const full = doc.fullscreenElement;
    const parent = full?.ownerDocument === doc ? full : doc.body || doc.documentElement;
    if (parent && host.parentNode !== parent) parent.appendChild(host);
  }
  mountHost();

  function containerFor(candidate) {
    try {
      const node = candidate?.config?.container || candidate?.layerWrap;
      return node?.ownerDocument === doc && typeof node.getBoundingClientRect === 'function' ? node : null;
    } catch { return null; }
  }
  function roomMatches(candidate) {
    try {
      const target = String(candidate?.opts?.roomId || candidate?.opts?.roomid || candidate?.opts?.rid || '');
      const live = page.BilibiliLive;
      const current = String(live?.ROOMID || ''), short = String(live?.SHORT_ROOMID || '');
      if (!/^\d+$/.test(target) || !/^\d+$/.test(current) || Number(current) <= 0) return true;
      return target === current || Boolean(short && target === short);
    } catch { return true; }
  }
  function renderList() {
    try {
      const adapter = engine?.danmaku;
      const manager = adapter?.core?.manager || adapter?.magic?.core?.manager;
      return Array.isArray(manager?.visualArray) ? manager.visualArray : [];
    } catch { return []; }
  }
  function restoreHooks() {
    for (const hook of hooks.splice(0)) {
      try {
        if (Object.getOwnPropertyDescriptor(hook.proto, hook.name)?.value === hook.wrapper) {
          Object.defineProperty(hook.proto, hook.name, hook.before);
        }
      } catch {}
    }
  }
  function capture(candidate) {
    const container = containerFor(candidate);
    if (disposed || !container || !container.isConnected || !candidate?.danmaku || !roomMatches(candidate)) return;
    if (engine && engine !== candidate) closeMenu();
    engine = candidate; enginePageKey = page.location.pathname;
    restoreHooks();
  }
  function pollEngine() {
    if (disposed) return;
    pollPendingReport();
    const container = containerFor(engine);
    if (engine && (!container?.isConnected || engine.destroyed === true || !roomMatches(engine) || enginePageKey !== page.location.pathname)) {
      closeMenu(); engine = null; enginePageKey = '';
    }
    if (engine) {
      if (selection && !isCurrent(selection)) closeMenu();
      else if (selection) { try { forcePause(selection); updateControls(); } catch { closeMenu(); } }
      return;
    }
    let proto;
    try { proto = page.LiveDanmakuEngine?.default?.prototype; } catch { return; }
    if (!proto) return;
    for (const name of PATCH_METHODS) {
      if (hooks.some(hook => hook.proto === proto && hook.name === name)) continue;
      let before;
      try { before = Object.getOwnPropertyDescriptor(proto, name); } catch { continue; }
      if (typeof before?.value !== 'function' || before.writable === false && before.configurable === false) continue;
      const original = before.value;
      const wrapper = function (...args) {
        try { capture(this); } catch {}
        return Reflect.apply(original, this, args);
      };
      try {
        Object.defineProperty(proto, name, { ...before, value: wrapper });
        hooks.push({ proto, name, before, wrapper });
      } catch {}
    }
  }

  function pointInside(rect, x, y, margin = 0) {
    return rect && rect.width > 0 && rect.height > 0 && x >= rect.left - margin && x <= rect.right + margin &&
      y >= rect.top - margin && y <= rect.bottom + margin;
  }
  function elementRect(element) {
    try { return element?.isConnected ? element.getBoundingClientRect() : null; } catch { return null; }
  }
  function clearHoverCursor() {
    const patch = hoverCursor;
    hoverCursor = null;
    if (!patch) return;
    try {
      // Only restore a value we still own; native controls can change it later.
      const style = patch.element.style;
      if (style.getPropertyValue('cursor') !== 'pointer' || style.getPropertyPriority('cursor') !== 'important') return;
      if (patch.value) style.setProperty('cursor', patch.value, patch.priority);
      else style.removeProperty('cursor');
    } catch {}
  }
  function updateHoverCursor(event = null) {
    const context = selection;
    const point = event ? { x: event.clientX, y: event.clientY } : lastPointer;
    if (!context || !context.held || !isCurrent(context) || !point ||
        !pointInside(elementRect(context.element), point.x, point.y)) {
      clearHoverCursor(); return;
    }
    let target;
    try {
      // Danmaku can have pointer-events:none. Style the actual hit surface
      // underneath it without changing native hit testing or click handlers.
      if (event && typeof event.composedPath === 'function') {
        target = event.composedPath().find(node => node?.nodeType === 1 && node.ownerDocument === doc);
      }
      target ||= doc.elementFromPoint(point.x, point.y);
      if (!target?.isConnected || !target.style || target === host || host.contains(target) ||
          target.closest('button, input, textarea, select, a, [role="button"], [role="dialog"], #bdf-panel-root-v1, #bdf-button-root-v1')) {
        clearHoverCursor(); return;
      }
      if (hoverCursor?.element !== target) {
        clearHoverCursor();
        hoverCursor = { element: target, value: target.style.getPropertyValue('cursor'), priority: target.style.getPropertyPriority('cursor') };
      }
      const value = target.style.getPropertyValue('cursor'), priority = target.style.getPropertyPriority('cursor');
      if (value === 'pointer' && priority === 'important') return;
      // If the player changed its idle cursor while held, preserve that newer
      // native value for release rather than restoring an old snapshot.
      hoverCursor.value = value; hoverCursor.priority = priority;
      target.style.setProperty('cursor', 'pointer', 'important');
    } catch { clearHoverCursor(); }
  }
  function isOrdinary(render) {
    try {
      const data = render?.textData, element = render?.element;
      const rawMode = Number(data?.rawMode ?? data?.mode);
      if (!data || !element?.isConnected || render.isHide || data.on === false || ![1, 4, 5, 6].includes(rawMode)) return false;
      if (element.ownerDocument !== doc || !element.matches(DOM_SELECTOR)) return false;
      return typeof data.text === 'string' && Boolean(data.text.trim()) &&
        typeof render.mouseEnter === 'function' && typeof render.mouseLeave === 'function';
    } catch { return false; }
  }
  function findRender(x, y) {
    const candidates = [];
    for (const render of renderList()) {
      if (!isOrdinary(render)) continue;
      const rect = elementRect(render.element);
      if (pointInside(rect, x, y)) candidates.push({ render, rect });
    }
    if (!candidates.length) return null;
    // When messages overlap, prefer the actual topmost DOM message if it
    // participates in pointer hit testing. The layer itself remains untouched.
    try {
      for (const node of doc.elementsFromPoint(x, y)) {
        const found = candidates.find(candidate => candidate.render.element === node || candidate.render.element.contains(node));
        if (found) return found.render;
      }
    } catch {}
    candidates.sort((a, b) => {
      let za = 0, zb = 0;
      try { za = Number(page.getComputedStyle(a.render.element).zIndex) || 0; } catch {}
      try { zb = Number(page.getComputedStyle(b.render.element).zIndex) || 0; } catch {}
      return zb - za;
    });
    return candidates[0].render;
  }
  function stringValue(value) { return typeof value === 'string' || typeof value === 'number' ? String(value) : ''; }
  function snapshot(render) {
    const data = render.textData, user = data.modeInfo?.user;
    const primaryUID = stringValue(user?.uid || data.uid);
    const uid = /^\d+$/.test(primaryUID) && /[1-9]/.test(primaryUID) ? primaryUID : '';
    const name = user?.base?.name || data.uname || user?.name;
    const author = typeof name === 'string' ? name : '';
    const id = stringValue(data.dmid || data.modeInfo?._extra?.id_str);
    let room = '';
    try { room = stringValue(engine?.opts?.roomId || engine?.opts?.roomid || engine?.opts?.rid); } catch {}
    if (!room) {
      try { room = (page.location.pathname.match(/^\/(?:blanc\/)?(\d+)(?:\/|$)/) || [])[1] || ''; } catch {}
    }
    let pageKey = '';
    try { pageKey = page.location.pathname; } catch {}
    return { text: data.text, uid, author, room, id, pageKey, source: 'player' };
  }
  function canReport(context) {
    // The page report module is loaded on click, not used as a hover prerequisite.
    if (!isCurrent(context)) return false;
    const uid = stringValue(context.data.uid);
    if (!/^\d+$/.test(uid) || !/[1-9]/.test(uid) ||
        (typeof context.data.uid === 'number' && !Number.isSafeInteger(context.data.uid))) return false;
    let self = '';
    try { self = stringValue(page.BilibiliLive?.UID || context.engine.opts?.uid || context.engine.opts?.userId); } catch {}
    return !self || self !== uid;
  }
  function reportDataFor(context) {
    const data = context.data;
    let extra = data.modeInfo?._extra;
    if (!extra && typeof data.modeInfo?.extra === 'string' && data.modeInfo.extra.length < 262144) {
      try { extra = JSON.parse(data.modeInfo.extra); } catch {}
    }
    const rawId = extra?.id_str;
    const id = typeof rawId === 'string' ? rawId : Number.isSafeInteger(rawId) ? String(rawId) : '';
    const copy = { ...data, id_str: /^\d+$/.test(id) && /[1-9]/.test(id) ? id : '' };
    // Preserve the exact native sender, text and signature. A local render ID
    // must never be passed as a real report ID; an unknown original ID stays empty.
    for (const key of ['checkInfo', 'voiceConfig', 'emoticonOptions']) {
      if (copy[key] && typeof copy[key] === 'object') copy[key] = Object.freeze({ ...copy[key] });
    }
    return Object.freeze(copy);
  }
  function nativeReportIsOpen() {
    return [...doc.querySelectorAll('.danmaku-report-panel, .web-player-report-wrap')]
      .some(node => node.isConnected && node.getClientRects().length);
  }
  function captureNativeRuntime() {
    if (nativeRuntime) return nativeRuntime;
    const chunks = page.webpackChunklive_room;
    if (!Array.isArray(chunks) || typeof chunks.push !== 'function') throw new Error('页面原生模块尚未准备好');
    let captured = null;
    // A unique nonempty ID makes the webpack runtime callback run. No site
    // module is replaced; remove this empty registration from the visible queue.
    const marker = `bdf_report_runtime_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const entry = [[marker], {}, runtime => { captured = runtime; }];
    try { chunks.push(entry); }
    finally {
      const index = chunks.indexOf(entry);
      if (index >= 0) chunks.splice(index, 1);
    }
    if (typeof captured !== 'function' || typeof captured.e !== 'function') throw new Error('无法获得页面原生模块');
    nativeRuntime = captured;
    return nativeRuntime;
  }
  function loadAppReportModule(runtime) {
    if (appReportModulePromise) return appReportModulePromise;
    // These are the same chunks loaded by the site's native report() method.
    // Its own loader resolves the current CDN paths/hashes and component styles.
    const loading = Promise.all([runtime.e(6160), runtime.e(5775)]).then(() => {
      const module = runtime(26160);
      if (typeof module?.openReportPanel !== 'function') throw new Error('页面原生举报窗口不可用');
      return module;
    });
    appReportModulePromise = loading;
    void loading.catch(() => { if (appReportModulePromise === loading) appReportModulePromise = null; });
    return loading;
  }
  function appReportInfoFor(context, data) {
    let extra = data.modeInfo?._extra;
    if (!extra && typeof data.modeInfo?.extra === 'string' && data.modeInfo.extra.length < 262144) {
      try { extra = JSON.parse(data.modeInfo.extra); } catch {}
    }
    const source = data.sourceRoomId || data.source_room_id || extra?.source_room_id;
    const sourceText = stringValue(source);
    return Object.freeze({
      title: '举报弹幕', url: '/xlive/web-ucenter/v1/dMReport/Report',
      reportUrl: '/xlive/web-ucenter/v1/dMReport/ForReason', id: 0, token: '', type: 'danmaku',
      username: stringValue(data.uname) || context.snapshot.author || stringValue(data.uid),
      uid: data.uid, content: data.text, ts: data.checkInfo?.ts, sign: data.checkInfo?.ct,
      dmType: data.dmType ?? 0, fileId: stringValue(data.voiceConfig?.file_id || data.emoticonOptions?.emoticon_unique),
      imgUrl: stringValue(data.emoticonOptions?.url), idStr: data.id_str,
      sourceRoomId: /^\d+$/.test(sourceText) && /[1-9]/.test(sourceText) ? source : 0
    });
  }
  function matchingReportPanel(info, before) {
    const displayText = value => String(value ?? '').replace(/\s+/gu, ' ').trim();
    for (const node of doc.querySelectorAll('.danmaku-report-panel')) {
      if (before.has(node) || !node.isConnected || !node.getClientRects().length ||
          !node.querySelector('form[name="danmaku-report-form"]')) continue;
      let props = null;
      try {
        const seen = new Set(), queue = [node.__vue__];
        while (queue.length && seen.size < 16) {
          const vm = queue.shift();
          if (!vm || seen.has(vm)) continue;
          seen.add(vm);
          if (vm.$el === node && vm.$props && Object.prototype.hasOwnProperty.call(vm.$props, 'uid')) { props = vm.$props; break; }
          if (vm.$parent) queue.push(vm.$parent);
          if (Array.isArray(vm.$children)) queue.push(...vm.$children);
        }
      } catch {}
      if (props) {
        if (stringValue(props.uid) === stringValue(info.uid) && props.content === info.content &&
            stringValue(props.idStr) === stringValue(info.idStr) &&
            (info.ts == null || stringValue(props.ts) === stringValue(info.ts)) &&
            (info.sign == null || props.sign === info.sign) &&
            stringValue(props.sourceRoomId) === stringValue(info.sourceRoomId)) return node;
        continue;
      }
      // DOM wrappers can hide Vue expandos. This is only mounted-window feedback;
      // the immutable payload passed directly to the native opener fixes its target.
      const name = node.querySelector('.username'), message = node.querySelector('.danmaku-content');
      if (!name || !message || displayText(name.innerText) !== displayText(info.username)) continue;
      if (info.imgUrl ? message.querySelector('img')?.getAttribute('src') === info.imgUrl :
          displayText(message.innerText) === displayText(info.content)) return node;
    }
    return null;
  }
  function reportContextValid(context) {
    return !disposed && engine === context.engine && context.snapshot.pageKey === page.location.pathname &&
      roomMatches(context.engine) && containerFor(context.engine)?.isConnected && context.engine.destroyed !== true;
  }
  function pollPendingReport() {
    const pending = pendingReport;
    if (!pending) return;
    try {
      const valid = reportContextValid(pending.context);
      if (!valid || matchingReportPanel(pending.data, pending.before)) {
        pendingReport = null; reportBusy = false;
        if (selection === pending.context) closeMenu();
        updateControls();
      }
    } catch {}
  }
  function waitReportPanel(data, before, context) {
    return new Promise(resolve => {
      let timer, expiry, finished = false;
      const done = value => {
        if (finished) return;
        finished = true; clearInterval(timer); clearTimeout(expiry); resolve(value);
      };
      const check = () => {
        try {
          if (!reportContextValid(context)) {
            done(false); return;
          }
          if (matchingReportPanel(data, before)) done(true);
        } catch { done(false); }
      };
      timer = setInterval(check, 50); expiry = setTimeout(() => done(false), 15000); check();
    });
  }
  async function reportDanmaku(context) {
    if (reportBusy || pendingReport || nativeReportIsOpen() || !canReport(context)) return false;
    // Freeze the chosen sender/message before any native login or chunk loading.
    const info = appReportInfoFor(context, reportDataFor(context));
    let ownPending = null;
    reportBusy = true; updateControls();
    try {
      const runtime = captureNativeRuntime(), auth = runtime(14198);
      if (!auth?.loginStatus || typeof auth.login !== 'function') return false;
      if (!auth.loginStatus.isLogin) { auth.login(); return false; }
      const module = await loadAppReportModule(runtime);
      if (!reportContextValid(context) || nativeReportIsOpen()) return false;
      if (!auth.loginStatus.isLogin) { auth.login(); return false; }
      const self = stringValue(page.BilibiliLive?.UID || context.engine.opts?.uid || context.engine.opts?.userId);
      if (self && self === stringValue(info.uid)) return false;
      // A native popup manager may reuse a previously hidden panel. Only
      // exclude panels already visible before this invocation.
      const before = new Set([...doc.querySelectorAll('.danmaku-report-panel')]
        .filter(node => node.isConnected && node.getClientRects().length));
      const pending = { context, data: info, before };
      // The native opener returns void and can mount on a later Vue tick. Keep
      // the lock before invocation; never fall back to the old player dialog.
      pendingReport = pending; ownPending = pending;
      module.openReportPanel(info);
      const opened = await waitReportPanel(info, before, context);
      if ((opened || !reportContextValid(context)) && pendingReport === pending) pendingReport = null;
      return opened;
    } catch {
      if (ownPending && pendingReport === ownPending && !nativeReportIsOpen()) pendingReport = null;
      return false;
    }
    finally {
      // A UI wait deadline cannot cancel the site's pending reason request.
      // Keep its lock until a late dialog appears or this player/page is gone.
      reportBusy = Boolean(pendingReport); updateControls();
    }
  }
  function patchOwn(context, key, replacement) {
    const target = context.render, before = Object.getOwnPropertyDescriptor(target, key);
    const next = before && 'value' in before ? { ...before, value: replacement } :
      { configurable: true, enumerable: before?.enumerable ?? false, writable: true, value: replacement };
    Object.defineProperty(target, key, next);
    context.patches.push({ key, before, replacement });
  }
  function patchHeldPosition(context) {
    const target = context.render, before = Object.getOwnPropertyDescriptor(target, 'x');
    // Keep the native accessor intact after release, even if layout writes x
    // during the hold. A writable numeric shadow would lose its identity.
    if (before && (!before.configurable || 'value' in before)) return;
    let descriptor = before, proto = Object.getPrototypeOf(target);
    while (!descriptor && proto) {
      descriptor = Object.getOwnPropertyDescriptor(proto, 'x'); proto = Object.getPrototypeOf(proto);
    }
    const getter = function () { return context.heldX; };
    const setter = function (value) {
      if (typeof descriptor?.set === 'function') Reflect.apply(descriptor.set, this, [value]);
      else this._x = value;
    };
    Object.defineProperty(target, 'x', { configurable: true, enumerable: before?.enumerable ?? false, get: getter, set: setter });
    context.patches.push({ key: 'x', before, getter, setter });
  }
  function restoreOwn(context) {
    for (const patch of context.patches.reverse()) {
      try {
        const current = Object.getOwnPropertyDescriptor(context.render, patch.key);
        const owned = patch.getter ? current?.get === patch.getter && current?.set === patch.setter : current?.value === patch.replacement;
        if (!owned) continue;
        if (patch.before) Object.defineProperty(context.render, patch.key, patch.before);
        else delete context.render[patch.key];
      } catch {}
    }
    context.patches.length = 0;
  }
  function forcePause(context) {
    const render = context.render;
    if (!render.isHover) render.isHover = true;
    if (render.stopTime !== context.pauseStartedAt) render.stopTime = context.pauseStartedAt;
    if (Number.isFinite(context.heldX) && render._x !== context.heldX) render._x = context.heldX;
    // Keep expiration ahead of the live clock as well as guarding shouldDestroy.
    // finishPause resets this baseline before native mouseLeave compensates once.
    const elapsed = Math.max(0, (Date.now() - context.pauseStartedAt) / 1000);
    for (const [key, initial] of Object.entries(context.clock)) {
      if (Number.isFinite(initial) && render[key] !== initial + elapsed) render[key] = initial + elapsed;
    }
    function setStyle(name, value) {
      if (context.element.style.getPropertyValue(name) !== value || context.element.style.getPropertyPriority(name) !== 'important') {
        context.element.style.setProperty(name, value, 'important');
      }
    }
    setStyle('animation-play-state', 'paused'); setStyle('-webkit-animation-play-state', 'paused');
    if (context.frozenTransform) setStyle('transform', context.frozenTransform);
    pauseMotion(context);
    updateHoverCursor();
  }
  function elementAnimations(context) {
    try {
      return context.element.getAnimations().filter(animation => animation.effect?.target === context.element);
    } catch { return []; }
  }
  function rememberMotion(context, animation) {
    if (context.motion.has(animation)) return context.motion.get(animation);
    const name = typeof animation.animationName === 'string' ? animation.animationName : '';
    const prior = name ? context.motionPhases.get(name) : null;
    const entry = { time: prior ? prior.time : animation.currentTime,
      wasRunning: prior ? prior.wasRunning : animation.playState === 'running', owned: false };
    context.motion.set(animation, entry);
    if (name && !prior) {
      context.motionPhases.set(name, { time: entry.time, wasRunning: entry.wasRunning });
      // Ordinary messages use only a few animation names. Keep the fallback
      // bounded if another renderer repeatedly creates differently named ones.
      if (context.motionPhases.size > 16) context.motionPhases.delete(context.motionPhases.keys().next().value);
    }
    return entry;
  }
  function pauseMotion(context) {
    const animations = elementAnimations(context), current = new Set(animations);
    for (const animation of context.motion.keys()) {
      if (!current.has(animation) || animation.playState === 'idle') context.motion.delete(animation);
    }
    for (const animation of animations) {
      if (animation.playState === 'idle') continue;
      const entry = rememberMotion(context, animation);
      try {
        if (entry.time != null && animation.currentTime !== entry.time) animation.currentTime = entry.time;
        // CSS animations already obey our paused style. Avoid taking over their
        // play/pause controls, so a later website-wide pause remains effective.
        if (typeof animation.animationName !== 'string' && animation.playState !== 'paused') {
          animation.pause(); entry.owned = true;
        }
      } catch {}
    }
  }
  function releaseMotion(context) {
    const current = new Set(elementAnimations(context));
    for (const [animation, entry] of context.motion) {
      // Canceled/replaced animations must never be revived onto a recycled node.
      if (!current.has(animation) || animation.playState === 'idle') continue;
      try {
        if (entry.time != null) animation.currentTime = entry.time;
        if (entry.owned && entry.wasRunning) animation.play();
        else if (entry.owned && !entry.wasRunning) animation.pause();
      } catch {}
    }
    context.motion.clear(); context.motionPhases.clear();
  }
  function startPauseWatch(context) {
    if (!context.held || selection !== context || disposed) return;
    const enforce = () => {
      if (!context.held || selection !== context || disposed) return;
      if (!isCurrent(context)) { closeMenu(); return; }
      try {
        forcePause(context);
        if (context.fixed) {
          // Fixed messages can be recentered or moved by native player resize.
          positionMenu();
          if (selection === context && lastPointer && !pointerStillInside(lastPointer)) closeMenu();
        }
      } catch { closeMenu(); }
    };
    context.observer = new MutationObserver(enforce);
    context.observer.observe(context.element, { attributes: true, attributeFilter: ['class', 'style'] });
    const frame = () => {
      context.watchFrame = null; enforce();
      if (context.held && selection === context && !disposed) context.watchFrame = page.requestAnimationFrame(frame);
    };
    context.watchFrame = page.requestAnimationFrame(frame);
  }
  function isCurrent(context) {
    if (disposed || !context || engine !== context.engine) return false;
    try {
      return roomMatches(context.engine) && context.snapshot.pageKey === page.location.pathname && isOrdinary(context.render) && context.render.element === context.element &&
        context.render.textData === context.data && context.data.text === context.snapshot.text &&
        Number(context.data.rawMode ?? context.data.mode) === context.mode &&
        renderList().includes(context.render);
    } catch { return false; }
  }
  function reusedByAnother(context) {
    return renderList().some(render => render !== context.render && render?.element === context.element);
  }
  function restoreInline(context) {
    for (const entry of context.animation) {
      if (entry.value) context.element.style.setProperty(entry.name, entry.value, entry.priority);
      else context.element.style.removeProperty(entry.name);
    }
  }
  function finishPause(context) {
    if (!context || !context.held) return;
    context.observer?.disconnect();
    if (context.watchFrame != null) page.cancelAnimationFrame(context.watchFrame);
    context.watchFrame = null; context.held = false;
    restoreOwn(context);
    const render = context.render, elapsed = Math.max(0, (Date.now() - context.pauseStartedAt) / 1000);
    const reverse = Boolean(render._isReverse), middleName = reverse ? '_reverseMiddle' : 'middle';
    let middle, end;
    try {
      // A native listener might have cached a bound leave method before our
      // own override. Start the final compensation from the captured clock
      // values so such an early leave cannot add the same pause twice.
      for (const [key, value] of Object.entries(context.clock)) {
        if (Number.isFinite(value)) render[key] = value;
      }
      middle = Number(render[middleName]); end = Number(render.endTime);
    } catch {}
    const reused = reusedByAnother(context);
    try {
      // Suppressed native leave calls cannot reset this timestamp while the
      // menu owns the pause. Restore methods before invoking the native leave.
      render.isHover = true; render.stopTime = context.pauseStartedAt;
      if (!reused) Reflect.apply(context.leave, render, []);
      else throw new Error('DOM element has been recycled');
    } catch {
      // If another component removed/recycled the node, only update the old
      // model. Never remove a pause class or inline style from a new message.
      try {
        if (Number.isFinite(middle)) render[middleName] = middle + elapsed;
        if (Number.isFinite(end)) render.endTime = end + elapsed;
        render.isHover = false; render.stopTime = 0;
        if (!reused) context.element.classList.remove('bili-danmaku-x-paused');
      } catch {}
    } finally {
      if (!reused) { try { restoreInline(context); releaseMotion(context); } catch {} }
      else { context.motion.clear(); context.motionPhases.clear(); }
    }
  }
  function selectRender(render, pointerX) {
    if (selection?.render === render) return;
    closeMenu();
    const mode = Number(render.textData.rawMode ?? render.textData.mode);
    const context = {
      render, engine, mode, fixed: [4, 5].includes(mode), element: render.element, data: render.textData, snapshot: snapshot(render),
      patches: [], animation: [], clock: {}, held: false, leave: render.mouseLeave, pointerX,
      motion: new Map(), motionPhases: new Map(), observer: null, watchFrame: null, heldX: NaN, frozenTransform: '',
      pauseStartedAt: typeof render.stopTime === 'number' && render.stopTime > 0 ? Math.min(render.stopTime, Date.now()) : Date.now()
    };
    for (const key of ['middle', '_reverseMiddle', 'endTime']) {
      try { context.clock[key] = Number(render[key]); } catch {}
    }
    const styleNames = context.fixed ? ['animation-play-state', '-webkit-animation-play-state'] :
      ['animation-play-state', '-webkit-animation-play-state', 'transform'];
    for (const name of styleNames) {
      context.animation.push({ name, value: context.element.style.getPropertyValue(name), priority: context.element.style.getPropertyPriority(name) });
    }
    try {
      const enter = render.mouseEnter, destroy = render.shouldDestroy;
      if (!context.fixed) context.frozenTransform = page.getComputedStyle(context.element).transform;
      for (const animation of elementAnimations(context)) rememberMotion(context, animation);
      patchOwn(context, 'shouldDestroy', function (...args) {
        return context.held ? false : typeof destroy === 'function' ? Reflect.apply(destroy, this, args) : false;
      });
      // Only rolling messages need a frozen horizontal position. Fixed modes
      // retain their native centering and bottom offset when the player resizes.
      if (!context.fixed) context.heldX = Number(render.x);
      context.held = true;
      if (Number.isFinite(context.heldX)) patchHeldPosition(context);
      Reflect.apply(enter, render, []);
      forcePause(context);
      patchOwn(context, 'mouseEnter', function (...args) {
        if (context.held) { forcePause(context); return; }
        return Reflect.apply(enter, this, args);
      });
      patchOwn(context, 'mouseLeave', function (...args) {
        if (context.held) { forcePause(context); return; }
        return Reflect.apply(context.leave, this, args);
      });
      const nativeDestroy = render.destroy;
      if (typeof nativeDestroy === 'function') patchOwn(context, 'destroy', function (...args) {
        // Website clears still take effect. Release before its DOM enters the pool.
        if (selection === context) closeMenu(); else finishPause(context);
        return Reflect.apply(nativeDestroy, this, args);
      });
      selection = context;
      mountHost(); host.style.display = 'block'; updateControls(); positionMenu();
      updateHoverCursor();
      if (selection === context && context.held) startPauseWatch(context);
    } catch {
      if (selection === context) closeMenu();
      finishPause(context); restoreOwn(context);
    }
  }
  function closeMenu() {
    const context = selection;
    selection = null; host.style.display = 'none';
    clearHoverCursor();
    if (context) finishPause(context);
  }
  function updateControls() {
    if (disposed) return;
    const data = selection?.snapshot;
    for (const node of [reportButton, replyButton, repeatButton, collectButton]) node.removeAttribute('title');
    reportButton.disabled = reportBusy || nativeReportIsOpen() || !canReport(selection);
    replyButton.disabled = !data?.uid || typeof options.onReply !== 'function';
    repeatButton.disabled = repeatBusy || Date.now() < repeatUntil || typeof options.onRepeat !== 'function';
    collectButton.disabled = typeof options.onCollect !== 'function';
  }
  async function runAction(kind) {
    const context = selection;
    if (!context || !isCurrent(context)) { closeMenu(); return; }
    if (kind === 'report') {
      const opened = await reportDanmaku(context);
      if (opened && selection === context) closeMenu();
      else if (selection === context && isCurrent(context)) {
        try { forcePause(context); } catch { closeMenu(); }
      }
      return;
    }
    const data = { ...context.snapshot };
    const callback = kind === 'reply' ? options.onReply : kind === 'repeat' ? options.onRepeat : options.onCollect;
    if (typeof callback !== 'function' || kind === 'reply' && !data.uid) return;
    if (kind === 'repeat' && (repeatBusy || Date.now() < repeatUntil)) return;
    if (kind === 'repeat') repeatBusy = true;
    updateControls();
    try { await callback(data); }
    catch {}
    finally {
      if (kind === 'repeat') {
        repeatBusy = false; repeatUntil = Date.now() + 700;
        clearTimeout(cooldownTimer);
        if (!disposed) cooldownTimer = setTimeout(updateControls, 710);
      }
      updateControls();
      if (selection === context && isCurrent(context)) {
        try { forcePause(context); } catch { closeMenu(); }
      }
    }
  }
  function positionMenu() {
    if (!selection || disposed) return;
    if (!isCurrent(selection)) { closeMenu(); return; }
    mountHost();
    const rect = elementRect(selection.element);
    if (!rect || !rect.width || !rect.height) { closeMenu(); return; }
    const width = menu.getBoundingClientRect().width || 164, height = menu.getBoundingClientRect().height || 40;
    const viewportWidth = doc.documentElement.clientWidth || page.innerWidth;
    const viewportHeight = doc.documentElement.clientHeight || page.innerHeight;
    const anchorX = Number.isFinite(selection.pointerX) ? selection.pointerX : rect.left + Math.min(rect.width, width) / 2;
    const left = Math.max(8, Math.min(anchorX - width / 2, viewportWidth - width - 8));
    let top = rect.bottom + 6;
    const above = selection.mode === 4 || top + height > viewportHeight - 8;
    if (above) top = Math.max(8, rect.top - height - 6);
    host.dataset.above = String(above);
    host.style.setProperty('--bdf-hover-arrow-left', `${Math.max(14, Math.min(width - 14, anchorX - left))}px`);
    host.style.left = `${left}px`; host.style.top = `${top}px`;
  }
  function schedulePosition() {
    if (!selection || layoutFrame != null || disposed) return;
    layoutFrame = page.requestAnimationFrame(() => {
      layoutFrame = null; positionMenu();
      if (selection && lastPointer && !pointerStillInside(lastPointer)) closeMenu();
      updateHoverCursor();
    });
  }
  function onPointerMove(event) {
    if (disposed || event.pointerType === 'touch') return;
    try {
      const eventPath = typeof event.composedPath === 'function' ? event.composedPath() : [];
      if (!eventPath.includes(host) && nativeReportIsOpen()) { closeMenu(); return; }
      if (reportBusy && !eventPath.includes(host)) {
        const point = { x: event.clientX, y: event.clientY };
        lastPointer = point;
        if (!pointerStillInside(point)) closeMenu();
        return;
      }
      if (!eventPath.includes(host) && eventPath.some(node => node?.nodeType === 1 &&
        node.matches('button, input, textarea, select, a, [role="button"], [role="dialog"], #bdf-panel-root-v1, #bdf-button-root-v1'))) {
        closeMenu(); return;
      }
      const x = event.clientX, y = event.clientY;
      lastPointer = { x, y };
      if (selection) {
        if (!isCurrent(selection)) closeMenu();
        else {
          // Expanding the message and menu by 8px bridges the 6px gap, including
          // small diagonal movements from the message into the menu.
          if (eventPath.includes(host) || pointInside(elementRect(selection.element), x, y, 8) ||
            pointInside(host.getBoundingClientRect(), x, y, 8)) {
            try { forcePause(selection); } catch { closeMenu(); }
            return;
          }
          closeMenu();
        }
      }
      if (!engine || !roomMatches(engine) || enginePageKey !== page.location.pathname) { pollEngine(); return; }
      const container = containerFor(engine);
      if (!pointInside(elementRect(container), x, y)) return;
      const render = findRender(x, y);
      if (render) selectRender(render, x);
    } finally { updateHoverCursor(event); }
  }
  function onKeyDown(event) {
    if (event.key === 'Escape' && selection) { event.preventDefault(); event.stopPropagation(); closeMenu(); }
  }
  function pointerStillInside(point) {
    return selection && point && (pointInside(elementRect(selection.element), point.x, point.y, 8) ||
      pointInside(host.getBoundingClientRect(), point.x, point.y, 8));
  }
  function onPointerOut(event) {
    if (event.relatedTarget || !selection) return;
    // Disabling a clicked button can emit pointerout(null) without moving the mouse.
    try { if (host.matches(':hover')) return; } catch {}
    const point = { x: event.clientX, y: event.clientY };
    let documentHovered = false;
    try { documentHovered = doc.documentElement.matches(':hover'); } catch {}
    if (documentHovered && (pointerStillInside(point) || pointerStillInside(lastPointer))) return;
    closeMenu();
  }
  function onVisibility() { if (doc.hidden) closeMenu(); }
  function onFullscreen() {
    mountHost();
    if (selection && doc.fullscreenElement && !doc.fullscreenElement.contains(selection.element)) closeMenu();
    else schedulePosition();
    updateHoverCursor();
  }
  function onResize() {
    if (!selection) return;
    positionMenu();
    if (!selection) return;
    if (lastPointer && !pointerStillInside(lastPointer)) closeMenu();
    else { try { forcePause(selection); } catch { closeMenu(); } }
  }
  function onWindowBlur(event) {
    if ((event.target === page || event.target === doc.defaultView) && !doc.hasFocus()) closeMenu();
  }
  const listenerRecords = [];
  function listen(target, type, callback, configuration = false) {
    target.addEventListener(type, callback, configuration);
    listenerRecords.push({ target, type, callback, configuration });
  }
  listen(doc, 'pointermove', onPointerMove, { capture: true, passive: true });
  listen(doc, 'pointerout', onPointerOut, { capture: true, passive: true });
  listen(doc, 'keydown', onKeyDown, true);
  listen(doc, 'fullscreenchange', onFullscreen);
  listen(doc, 'visibilitychange', onVisibility);
  listen(page, 'blur', onWindowBlur);
  listen(page, 'resize', onResize, { passive: true });
  listen(page, 'scroll', schedulePosition, { capture: true, passive: true });
  pollEngine(); pollTimer = setInterval(pollEngine, 500);

  function dispose() {
    if (disposed) return;
    closeMenu(); disposed = true; engine = null;
    pendingReport = null; reportBusy = false;
    clearInterval(pollTimer); clearTimeout(cooldownTimer);
    if (layoutFrame != null) { page.cancelAnimationFrame(layoutFrame); layoutFrame = null; }
    restoreHooks();
    for (const record of listenerRecords) record.target.removeEventListener(record.type, record.callback, record.configuration);
    listenerRecords.length = 0; host.remove();
  }
  return { dispose };
}

function installBiliFavorites() {
  'use strict';
  if (window.top !== window.self || document.getElementById('bdf-panel-root-v1')) return;
  document.querySelectorAll('.bdf-chat-save, #bdf-chat-style-v1').forEach(node => node.remove());
  const INPUT = '#chat-control-panel-vm textarea.chat-input, #control-panel-ctnr-box .chat-input-area textarea, .chat-control-panel textarea.chat-input';
  const SEND = '.send-btn-wrapper .send-btn';
  const TOOLBAR = '#chat-control-panel-vm #control-panel-ctnr-box .control-panel-icon-row .icon-left-part, #control-panel-ctnr-box .control-panel-icon-row .icon-left-part, .chat-control-panel .control-panel-icon-row .icon-left-part';
  const ROOT_ID = 'bdf-panel-root-v1', BUTTON_ID = 'bdf-button-root-v1';
  const ownSelector = `#${ROOT_ID}, #${BUTTON_ID}, #bdf-fallback-toolbar-v1`;
  const el = (tag, props = {}, children = []) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (key === 'text') node.textContent = value;
      else if (key === 'class') node.className = value;
      else node.setAttribute(key, String(value));
    }
    node.append(...children); return node;
  };
  const button = (text, action, cls = '') => {
    const node = el('button', { type: 'button', text, class: cls });
    node.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); action(event); });
    return node;
  };
  const store = createBiliFavoriteStore({
    GM_getValue: typeof GM_getValue === 'function' ? GM_getValue : undefined,
    GM_setValue: typeof GM_setValue === 'function' ? GM_setValue : undefined,
    GM_addValueChangeListener: typeof GM_addValueChangeListener === 'function' ? GM_addValueChangeListener : undefined,
    GM_removeValueChangeListener: typeof GM_removeValueChangeListener === 'function' ? GM_removeValueChangeListener : undefined
  });
  const host = el('div', { id: ROOT_ID });
  (document.body || document.documentElement).appendChild(host);
  const root = host.attachShadow({ mode: 'open' });
  const style = el('style', { text: `
    :host{position:fixed;z-index:2147483000;display:block;color:#505050;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Microsoft YaHei",sans-serif;color-scheme:light}
    *{box-sizing:border-box} [hidden]{display:none!important}
    button,input,textarea{font:inherit}button{cursor:pointer;border:0;background:none;color:inherit}button:disabled{opacity:.5;cursor:wait}
    button:focus-visible,input:focus-visible,textarea:focus-visible{outline:2px solid #00aeec;outline-offset:2px}
    .panel{display:flex;flex-direction:column;max-height:inherit;width:100%;background:#fff;border:1px solid #e9e9ed;border-radius:13px;box-shadow:0 6px 25px #0003;overflow:hidden}
    .header{display:flex;align-items:center;gap:8px;padding:14px 13px 10px;flex:none}.title{font-weight:700;white-space:nowrap;color:#262626;font-size:15px}
    .search{flex:1;min-width:35px;width:80px;border:1px solid #ddd;border-radius:5px;padding:5px 7px;font-size:13px;background:#fff;color:#444}
    .manage{font-size:13px;white-space:nowrap;color:#999;padding:3px}.manage.active{color:#00aeec}.close{font-size:23px;line-height:1;color:#aaa;padding:0 2px}
    .list{overflow:auto;min-height:90px;flex:1;padding:0 12px 5px;overscroll-behavior:contain;scrollbar-width:thin}
    .card{margin:4px 0;background:#f5f5f6;border:1px solid transparent;border-radius:10px;overflow:hidden}.card:hover{border-color:#c7edf9;background:#f0faff}
    .entry{display:block;width:100%;padding:6px 9px;text-align:left;white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;line-height:1.4;color:#666}
    .actions{display:flex;justify-content:flex-end;gap:3px;padding:0 6px 4px}
    .actions button{font-size:11px;color:#999;border-radius:4px;padding:0 5px}.actions button:hover{background:#fff;color:#00aeec}.actions .danger:hover{color:#ee5b73}
    .empty{padding:23px 9px;text-align:center;color:#999;font-size:13px;line-height:1.9}
    .footer{padding:9px 12px 11px;border-top:1px solid #f0f0f2;flex:none}.foot-actions{display:flex;gap:7px;flex-wrap:wrap}
    .primary{padding:6px 10px;border-radius:6px;background:#00aeec;color:#fff;font-size:12px}.secondary{padding:6px 10px;border-radius:6px;background:#f0f1f3;color:#666;font-size:12px}
    .fine{display:flex;justify-content:space-between;align-items:center;color:#aaa;font-size:11px;margin-top:8px}.fine button{color:#999;font-size:11px;padding:2px 4px}
    .editor{margin:2px 12px 10px;padding:10px;background:#f4faff;border:1px solid #d7f0fc;border-radius:8px;flex:none}.editor-heading{font-weight:600;font-size:13px;margin-bottom:7px}
    .editor textarea{resize:vertical;width:100%;min-height:85px;max-height:200px;border:1px solid #d9e4e9;border-radius:5px;padding:8px;background:#fff;color:#555;font-size:13px}
    .editor-bottom{display:flex;align-items:center;gap:6px;margin-top:7px}.counter{margin-right:auto;font-size:11px;color:#aaa}
    @media(prefers-reduced-motion:no-preference){.card{transition:background .12s}}
  ` });
  const panel = el('section', { class: 'panel', role: 'dialog', 'aria-label': '弹幕收藏夹', hidden: '' });
  const title = el('span', { class: 'title', text: '弹幕收藏' });
  const search = el('input', { class: 'search', type: 'search', placeholder: '搜索弹幕', 'aria-label': '搜索收藏弹幕', maxlength: 1000 });
  const manageButton = button('编辑', toggleManage, 'manage');
  manageButton.setAttribute('aria-pressed', 'false');
  const closeButton = button('×', () => closePanel(true), 'close'); closeButton.setAttribute('aria-label', '关闭收藏夹');
  const list = el('div', { class: 'list', 'aria-label': '收藏的弹幕' });
  const editorTitle = el('div', { class: 'editor-heading' });
  const editorInput = el('textarea', { maxlength: 1000, placeholder: '输入要收藏的弹幕', 'aria-label': '收藏内容', rows: 3 });
  const counter = el('span', { class: 'counter', text: '0 / 1000' });
  const saveButton = button('保存', saveEditor, 'primary');
  const editor = el('div', { class: 'editor', hidden: '' }, [editorTitle, editorInput,
    el('div', { class: 'editor-bottom' }, [counter, button('取消', closeEditor, 'secondary'), saveButton])]);
  const count = el('span', { text: '本地保存' });
  const undoButton = button('撤销删除', undoDelete, 'secondary'); undoButton.hidden = true;
  const fileInput = el('input', { type: 'file', accept: '.json,application/json', hidden: '', 'aria-label': '导入收藏备份' });
  const footer = el('div', { class: 'footer' }, [
    el('div', { class: 'foot-actions' }, [button('收藏输入框内容', saveCurrentInput, 'primary'), button('＋ 添加', () => openEditor(), 'secondary'), undoButton]),
    el('div', { class: 'fine' }, [count, el('span', {}, [button('导入', () => fileInput.click()), button('导出', exportFavorites)])]), fileInput
  ]);
  panel.append(el('div', { class: 'header' }, [title, search, manageButton, closeButton]), list, editor, footer);
  root.append(style, panel);
  const buttonHost = el('span', { id: BUTTON_ID });
  const buttonRoot = buttonHost.attachShadow({ mode: 'open' });
  const toggle = button('藏', () => panel.hidden ? openPanel() : closePanel(), 'toggle');
  toggle.title = '弹幕收藏夹'; toggle.setAttribute('aria-label', '打开弹幕收藏夹'); toggle.setAttribute('aria-expanded', 'false');
  buttonRoot.append(el('style', { text: `
    :host{display:inline-flex;align-items:center;flex:none;vertical-align:middle;margin:0 5px 0 2px;line-height:1;color-scheme:light}
    .toggle{border:0;cursor:pointer;padding:0;width:20px;height:20px;border-radius:4px;background:#c4c8cd;color:#fff;font:bold 15px/20px "Microsoft YaHei",sans-serif;text-align:center;-webkit-text-fill-color:currentColor;-webkit-text-stroke:0}
    .toggle:hover,.toggle[aria-expanded="true"]{background:#00aeec}.toggle:focus-visible{outline:2px solid #00aeec;outline-offset:2px}
  ` }), toggle);
  let ready = false, loadError = '', manage = false, editingID = null, editorAuthor = '', editorGeneration = 0, refreshTimer, observer, repeatBusy = false, lastRemoved = null;
  const inputElement = () => [...document.querySelectorAll(INPUT)].find(node => node.getClientRects().length) || document.querySelector(INPUT);
  const roomNumber = () => (location.pathname.match(/^\/(\d+)(?:\/|$)/) || [])[1] || '';
  const canon = value => String(value ?? '').replace(/\r\n?/g, '\n').trim();
  const composingInputs = new WeakSet();
  document.addEventListener('compositionstart', event => { if (event.target?.nodeType === 1) composingInputs.add(event.target); }, true);
  document.addEventListener('compositionend', event => { if (event.target?.nodeType === 1) composingInputs.delete(event.target); }, true);
  const isComposing = input => input?.composing === true || composingInputs.has(input);
  const searchKey = value => String(value ?? '').normalize('NFKC').toLocaleLowerCase();
  async function perform(operation) {
    try {
      await store.ready;
      const result = await operation();
      return result;
    } catch { return { ok: false }; }
  }
  async function saveCurrentInput() {
    const input = inputElement();
    if (!input || !canon(input.value)) return;
    const data = { text: input.value, room: roomNumber(), source: 'input' };
    await perform(() => store.add(data));
  }
  function writeInput(input, text) {
    const proto = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(input, text); else input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  }
  function fillInput(item) {
    const input = inputElement();
    if (!input || input.disabled || input.readOnly) return false;
    try {
      // Filling a favorite or reply does not trigger submission.
      writeInput(input, item.text);
      closePanel(); input.focus(); input.setSelectionRange(input.value.length, input.value.length);
      return true;
    } catch { return false; }
  }
  function replyToDanmaku(data) {
    if (data.pageKey && data.pageKey !== location.pathname) return false;
    const uid = String(data.uid || '');
    if (!/^\d+$/.test(uid) || uid === '0') return false;
    return fillInput({ text: `@${data.author || uid}：${data.text}` });
  }
  function isSendDisabled(node) {
    return !node || node.matches(':disabled') || node.hasAttribute('disabled') || node.getAttribute('aria-disabled') === 'true' ||
      ['disabled', 'is-disabled', 'loading', 'is-loading'].some(name => node.classList.contains(name));
  }
  async function repeatDanmaku(data) {
    if (repeatBusy) return false;
    if (data.pageKey && data.pageKey !== location.pathname) return false;
    const text = String(data.text ?? '').replace(/\r\n?/g, '\n');
    if (!text.trim()) return false;
    const input = inputElement();
    const control = input?.closest('#control-panel-ctnr-box, #chat-control-panel-vm, .chat-control-panel');
    const sendButton = control?.querySelector(SEND);
    if (input && isComposing(input)) return false;
    if (!input || input.disabled || input.readOnly || !sendButton?.getClientRects().length || isSendDisabled(sendButton)) {
      return false;
    }
    const draft = input.value, page = location.pathname;
    let userEdited = false, clicked = false, contextChanged = document.hidden;
    const noteInput = event => { if (event.isTrusted) userEdited = true; };
    const noteVisibility = () => { if (document.hidden) contextChanged = true; };
    const noteBlur = () => { contextChanged = true; };
    input.addEventListener('input', noteInput, true); input.addEventListener('compositionstart', noteInput, true);
    document.addEventListener('visibilitychange', noteVisibility); window.addEventListener('blur', noteBlur);
    repeatBusy = true;
    try {
      writeInput(input, text);
      // Allow Vue's length watcher and button state to settle before one deliberate click.
      await Promise.resolve();
      await new Promise((resolve, reject) => {
        let frame1, frame2;
        const timer = setTimeout(() => { cancelAnimationFrame(frame1); cancelAnimationFrame(frame2); reject(new Error('输入状态更新超时')); }, 1500);
        frame1 = requestAnimationFrame(() => frame2 = requestAnimationFrame(() => { clearTimeout(timer); resolve(); }));
      });
      if (contextChanged || document.hidden || userEdited || isComposing(input) || !input.isConnected || inputElement() !== input || location.pathname !== page ||
          input.closest('#control-panel-ctnr-box, #chat-control-panel-vm, .chat-control-panel') !== control ||
          !sendButton.isConnected || control.querySelector(SEND) !== sendButton) {
        return false;
      }
      if (input.value !== text) return false;
      if (input.disabled || input.readOnly || isSendDisabled(sendButton) || !sendButton.getClientRects().length) {
        return false;
      }
      // Only the explicit “加1” action reaches this website submit button.
      clicked = true; sendButton.click();
      return true;
    } catch { return false; }
    finally {
      input.removeEventListener('input', noteInput, true); input.removeEventListener('compositionstart', noteInput, true);
      document.removeEventListener('visibilitychange', noteVisibility); window.removeEventListener('blur', noteBlur);
      if (!clicked && !userEdited && !isComposing(input) && input.isConnected && inputElement() === input && location.pathname === page) {
        try { writeInput(input, draft); } catch {}
      }
      setTimeout(() => { repeatBusy = false; }, clicked ? 900 : 0);
    }
  }
  async function collectPlayerDanmaku(data) {
    const result = await perform(() => store.add({ text: data.text, author: data.author || '', room: data.room || roomNumber(), source: 'player' }));
    return Boolean(result?.ok || result?.duplicate);
  }
  async function copyText(item) {
    try {
      await navigator.clipboard.writeText(item.text);
    } catch {
      const area = el('textarea', { 'aria-label': '临时复制内容' });
      area.value = item.text; area.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
      root.appendChild(area); area.focus(); area.select();
      try { document.execCommand('copy'); } catch {}
      area.remove();
    }
  }
  async function removeItem(item) {
    const result = await perform(() => store.remove(item.id));
    if (result?.ok) { lastRemoved = result.item || item; undoButton.hidden = !manage; }
  }
  async function undoDelete() {
    const item = lastRemoved;
    if (!item) return;
    undoButton.disabled = true;
    const result = await perform(() => store.add(item));
    undoButton.disabled = false;
    if ((result?.ok || result?.duplicate) && lastRemoved === item) { lastRemoved = null; undoButton.hidden = true; }
  }
  function renderList() {
    const items = store.list(), key = searchKey(search.value.trim());
    const matches = items.filter(item => !key || searchKey(item.text).includes(key));
    count.textContent = loadError ? '本地读取异常' : key ? `本地保存 · 找到 ${matches.length} / ${items.length} 条` : `本地保存 · ${items.length} 条`;
    list.replaceChildren();
    if (!ready) { list.appendChild(el('div', { class: 'empty', text: '正在读取本地收藏…' })); return; }
    if (!matches.length) {
      list.appendChild(el('div', { class: 'empty', text: loadError || (key ? '没有找到匹配的弹幕' : '还没有收藏\n悬停画面弹幕点“收藏”，或添加常用内容\n点击收藏可填入输入框') })); return;
    }
    for (const item of [...matches].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))) {
      const entry = button('', () => manage ? openEditor(item) : fillInput(item), 'entry');
      entry.setAttribute('aria-label', `${manage ? '编辑' : '填入'}：${item.text}`);
      entry.appendChild(el('span', { text: item.text }));
      const children = [entry];
      if (manage) children.push(el('div', { class: 'actions' }, [button('复制', () => copyText(item)),
        button('修改', () => openEditor(item)), button('删除', () => removeItem(item), 'danger')]));
      list.appendChild(el('div', { class: 'card' }, children));
    }
  }
  function toggleManage() {
    manage = !manage; manageButton.textContent = manage ? '完成' : '编辑';
    manageButton.classList.toggle('active', manage); manageButton.setAttribute('aria-pressed', String(manage));
    undoButton.hidden = !manage || !lastRemoved;
    if (!manage) closeEditor(); renderList();
  }
  function openEditor(item) {
    editorGeneration++; saveButton.disabled = false;
    editingID = item?.id || null; editorAuthor = item?.author || '';
    editorTitle.textContent = item ? '修改收藏' : '添加收藏'; editorInput.value = item?.text || '';
    counter.textContent = `${editorInput.value.length} / 1000`; editor.hidden = false;
    editorInput.focus(); editorInput.setSelectionRange(editorInput.value.length, editorInput.value.length);
  }
  function closeEditor() { editorGeneration++; editor.hidden = true; editingID = null; editorAuthor = ''; saveButton.disabled = false; }
  async function saveEditor() {
    const generation = editorGeneration, targetID = editingID;
    const draft = { text: editorInput.value, author: editorAuthor, room: roomNumber(), source: 'manual' };
    saveButton.disabled = true;
    const result = await perform(() => targetID ? store.update(targetID, { text: draft.text, author: draft.author }) : store.add(draft));
    if (editorGeneration === generation) { saveButton.disabled = false; if (result?.ok) closeEditor(); }
  }
  function positionPanel() {
    const anchor = buttonHost.getBoundingClientRect();
    const control = buttonHost.closest('#chat-control-panel-vm, #control-panel-ctnr-box, .chat-control-panel');
    const frame = control?.getBoundingClientRect();
    const inFullscreen = document.fullscreenElement && !document.fullscreenElement.contains(buttonHost);
    if (inFullscreen) {
      const width = Math.min(420, Math.max(220, window.innerWidth - 24));
      host.style.cssText = `width:${width}px;left:${Math.max(12, (window.innerWidth - width) / 2)}px;bottom:16px;max-height:${Math.max(140, window.innerHeight - 32)}px;`;
      return;
    }
    const width = Math.min(460, Math.max(280, frame?.width || 360), Math.max(220, window.innerWidth - 24));
    const left = Math.max(12, Math.min(frame?.left ?? anchor.left, window.innerWidth - width - 12));
    const bottom = buttonHost.isConnected ? Math.max(12, window.innerHeight - anchor.top + 7) : 16;
    const available = Math.max(140, window.innerHeight - bottom - 12);
    host.style.cssText = `width:${width}px;left:${left}px;bottom:${Math.min(bottom, window.innerHeight - 160)}px;max-height:${Math.min(540, available)}px;`;
  }
  function openPanel() {
    panel.hidden = false; toggle.setAttribute('aria-expanded', 'true');
    renderList(); positionPanel(); search.focus();
  }
  function closePanel(returnFocus = false) {
    panel.hidden = true; toggle.setAttribute('aria-expanded', 'false'); closeEditor();
    if (returnFocus && buttonHost.isConnected) toggle.focus();
  }
  function exportFavorites() {
    if (!ready || loadError && !store.list().length) return;
    const blob = new Blob([JSON.stringify(store.exportData(), null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob), link = el('a', { href: url });
    const date = new Date(), stamp = [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
    link.download = `B站弹幕收藏-${stamp}.json`; root.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0]; fileInput.value = '';
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) return;
    try {
      const data = JSON.parse(await file.text());
      await perform(() => store.importItems(data));
    } catch {}
  });
  function mountButton() {
    const toolbar = document.querySelector(TOOLBAR);
    if (toolbar) {
      if (buttonHost.parentNode !== toolbar) toolbar.appendChild(buttonHost);
      const fallback = document.getElementById('bdf-fallback-toolbar-v1');
      if (fallback && !fallback.contains(buttonHost)) fallback.remove();
    } else {
      const input = inputElement();
      const control = document.querySelector('#chat-control-panel-vm, #control-panel-ctnr-box, .chat-control-panel');
      const container = input?.closest('.chat-input-ctnr, .chat-input-area') || input?.parentElement ||
        control?.querySelector('.chat-input-ctnr, .chat-input-area, .visitor-hint, .block-panel');
      if (container?.parentElement) {
        let fallback = document.getElementById('bdf-fallback-toolbar-v1');
        if (!fallback) {
          fallback = el('div', { id: 'bdf-fallback-toolbar-v1' }); fallback.style.cssText = 'display:flex;align-items:center;padding:4px 0;';
        }
        if (fallback.parentNode !== container.parentElement || fallback.nextSibling !== container) container.before(fallback);
        if (buttonHost.parentNode !== fallback) fallback.appendChild(buttonHost);
      }
    }
    if (!panel.hidden) positionPanel();
  }
  function refresh() { mountButton(); }
  function scheduleRefresh() {
    if (refreshTimer) return;
    refreshTimer = setTimeout(() => { refreshTimer = null; refresh(); }, 120);
  }
  search.addEventListener('input', renderList);
  editorInput.addEventListener('input', () => counter.textContent = `${editorInput.value.length} / 1000`);
  root.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !panel.hidden) { event.preventDefault(); event.stopPropagation(); closePanel(true); }
  });
  document.addEventListener('pointerdown', event => {
    const path = event.composedPath();
    if (!panel.hidden && !path.includes(host) && !path.includes(buttonHost)) closePanel();
  }, true);
  window.addEventListener('resize', positionPanel);
  document.addEventListener('fullscreenchange', () => {
    closePanel(); (document.fullscreenElement || document.body || document.documentElement).appendChild(host); positionPanel();
  });
  window.addEventListener('scroll', () => { if (!panel.hidden) positionPanel(); }, true);
  store.subscribe((_items, result) => {
    if (result?.ok === false) loadError = result.reason || '读取本地收藏失败';
    else if (result?.ok === true) loadError = '';
    renderList();
  });
  observer = new MutationObserver(changes => {
    const relevant = changes.some(change => {
      const target = change.target.nodeType === 1 ? change.target : change.target.parentElement;
      if (target?.closest(ownSelector)) return false;
      const nodes = [...change.addedNodes, ...change.removedNodes];
      return nodes.some(node => node.nodeType === 1 && !node.matches(ownSelector));
    });
    if (relevant) scheduleRefresh();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  renderList(); mountButton();
  void store.ready.then(result => {
    ready = true; loadError = result?.ok === false ? result.reason || '读取本地收藏失败' : '';
    renderList(); refresh();
  }, () => {
    ready = true; loadError = '读取收藏失败，请检查本地存储权限'; renderList(); refresh();
  });
  installBiliHoverActions({ pageWindow: typeof unsafeWindow !== 'undefined' ? unsafeWindow : window,
    onReply: replyToDanmaku, onRepeat: repeatDanmaku, onCollect: collectPlayerDanmaku });
}

installBiliFavorites();
})();

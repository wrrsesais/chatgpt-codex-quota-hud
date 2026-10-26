// ==UserScript==
// @name         ChatGPT 额度与 Reset 次数悬浮窗
// @namespace    local.chatgpt.quota
// @version      2.5.4
// @license      MIT
// @description  在悬浮窗查看额度、恢复时间和可用 Reset 次数；支持自动刷新、拖动及平滑折叠。
// @author       wrrsesais
// @homepageURL  https://github.com/wrrsesais/chatgpt-codex-quota-hud
// @supportURL   https://github.com/wrrsesais/chatgpt-codex-quota-hud/issues
// @downloadURL  https://raw.githubusercontent.com/wrrsesais/chatgpt-codex-quota-hud/main/chatgpt-quota.user.js
// @updateURL    https://raw.githubusercontent.com/wrrsesais/chatgpt-codex-quota-hud/main/chatgpt-quota.user.js
// @match        https://chatgpt.com/*
// @run-at       document-start
// @grant        none
// @sandbox      raw
// @noframes
// ==/UserScript==

/*
MIT License

Copyright (c) 2026 wrrsesais

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/


(() => {
  'use strict';
  if (window.top !== window.self || window.__localQuotaHUD) return;
  window.__localQuotaHUD = true;

  const VERSION = '2.5.4';
  const STORE = 'local-quota-hud-v2', LEGACY_STORE = 'local-quota-hud-v1';
  const ENDPOINT_STORE = STORE + '-endpoints';
  const DEFAULT_REFRESH_SECONDS = 180, MIN_REFRESH_SECONDS = 30, MAX_REFRESH_SECONDS = 3600;
  const USAGE_PAGE = 'https://chatgpt.com/settings/usage?tab=overview';
  const MAX_ENDPOINTS = 6, MAX_FIELDS = 50, MAX_SHAPES = 300, NODE_BUDGET = 4000;
  const MAX_JSON_BYTES = 2 * 1024 * 1024;
  const nativeFetch = window.fetch;
  const endpoints = new Map(), latestSeq = new Map(), shapes = new Set(), controllers = new Set();
  const finite = x => typeof x === 'number' && Number.isFinite(x);
  const quotaTone = percent => !finite(percent)||percent<0||percent>100?'unknown':percent<10?'critical':percent<=30?'warning':'healthy';
  const quotaBadge = percent => percent===0?'已用尽':({critical:'即将用尽',warning:'偏低',healthy:'剩余',unknown:'未确认'}[quotaTone(percent)]);
  const keyName = x => String(x).replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/-/g, '_').toLowerCase();
  const names = {
    rate_limit: '用量', rate_limits: '用量', primary_window: '短期窗口', secondary_window: '长期窗口',
    weekly: '每周', daily: '每日', credits: '点数', credit_balance: '点数', balance: '余额',
    remaining: '剩余', remaining_count: '剩余数量', remaining_credits: '剩余点数',
    credits_remaining: '剩余点数', remaining_balance: '剩余余额', remaining_tokens: '剩余 Token',
    remaining_percent: '剩余比例', remaining_percentage: '剩余比例',
    used_percent: '剩余比例', used_percentage: '剩余比例',
    reset_cards: 'Reset 卡', reset_card: 'Reset 卡', limit_resets: '重置次数（原字段）',
    resets_remaining: '剩余重置次数', remaining_resets: '剩余重置次数',
    reset_count: '重置次数（原字段）', available: '可用数量', count: '数量',
    reset_at: '恢复时间', resets_at: '恢复时间', reset_time: '恢复时间', next_reset_at: '下次恢复时间',
    reset_after_seconds: '预计恢复时间', reset_card_count: 'Reset 卡数量',
    reset_cards_remaining: '剩余 Reset 卡', remaining_reset_cards: '剩余 Reset 卡', available_resets: '可用重置次数'
  };
  const schemaKeys = new Set([...Object.keys(names),
    'data', 'result', 'response', 'models', 'model', 'model_slug', 'name', 'label', 'title',
    'usage', 'quota', 'limits', 'windows', 'window', 'items', 'resources', 'features',
    'plan', 'subscription', 'period', 'hourly', 'monthly', 'rolling', 'limit', 'used',
    'total', 'enabled', 'allowed', 'limit_reached', 'status', 'unit', 'type', 'resets', 'reset',
    'usage_resets', 'rate_limit_resets', 'limit_window_seconds', 'window_seconds', 'window_minutes',
    'available_count', 'remaining_reset_count', 'available_reset_count', 'reset_balance', 'reset_credits',
    'usage_resets_remaining', 'reset_credits_remaining', 'rate_limit_resets_remaining']);
  const sensitive = k => /(?:authorization|password|secret|credential|cookie|email|account_id|user_id|access_token|refresh_token|session_token|api_key)/i.test(keyName(k));
  const schemaPart = k => /^\d+$/.test(String(k)) ? '[]' : schemaKeys.has(keyName(k)) ? keyName(k) : '[field]';
  const schemaPath = p => p.map(schemaPart).join('.');
  let saved = readStore();
  let principal = '', scope = null, bearer = '', epoch = 0, sequence = 0, run = null;
  let retryNotBefore = 0, authBlocked = false, notice = '', lastScriptRequestAt = 0;
  let snapshot = '', snapshotAt = 0, domFields = [], lastDOMRoute = location.href;
  let host, shadow, body, dataBox, footer, excerpt, excerptSummary, excerptText, emptyHint, cardHint, overflowHint;
  let pauseButton, collapseButton, toolsPanel, sizeObserver, menuOpen = false, renderedSignature = '', rowRefs = [];
  let refreshButton, moreButton, statusLabel, footerText, excerptAge, themeObserver, compactSummary, compactFive, compactWeek, compactReset, dockLabel;
  let collapsed = saved.collapsed, renderPending = false, clampPending = false;
  let rootObserver, dialogTimer = 0;
  let cardElement, surfaceElement, morph = null, restoreTask = null;
  const dialogObservers = new Map();

  function readStore(fallback = {}) {
    const result = { autoRefresh: true, collapsed: false, refreshSeconds: DEFAULT_REFRESH_SECONDS, ...fallback };
    const read = key => {
      try {
        const raw = JSON.parse(localStorage.getItem(key) || '{}');
        return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
      } catch { return {}; }
    };
    const current = read(STORE), legacy = read(LEGACY_STORE);
    if (typeof current.autoRefresh === 'boolean') result.autoRefresh = current.autoRefresh;
    if (typeof current.collapsed === 'boolean') result.collapsed = current.collapsed;
    if (validRefreshSeconds(current.refreshSeconds)) result.refreshSeconds = current.refreshSeconds;
    const p = current.position || legacy.position;
    if (p && finite(p.x) && finite(p.y)) result.position = { x: p.x, y: p.y };
    try { localStorage.removeItem(LEGACY_STORE); } catch { /* storage unavailable */ }
    return result;
  }
  function writeStore(preferences = {}) {
    // A tab changing its layout must not write stale refresh preferences back.
    const current = readStore(saved);
    const clean = { autoRefresh: current.autoRefresh, collapsed, refreshSeconds: current.refreshSeconds, ...preferences };
    if (saved.position && finite(saved.position.x) && finite(saved.position.y)) clean.position = saved.position;
    try { localStorage.setItem(STORE, JSON.stringify(clean)); } catch { /* storage unavailable */ }
    applyRefreshPreferences(clean);
  }
  function validRefreshSeconds(value) {
    return Number.isInteger(value)&&value>=MIN_REFRESH_SECONDS&&value<=MAX_REFRESH_SECONDS;
  }
  const refreshInterval = () => saved.refreshSeconds*1000;
  const staleAfter = () => Math.max(180000,refreshInterval()*2+30000);
  function intervalText(seconds=saved.refreshSeconds) {
    const minutes=Math.floor(seconds/60),rest=seconds%60;
    return [minutes?minutes+' 分钟':'',rest?rest+' 秒':''].filter(Boolean).join(' ');
  }
  function setRefreshInterval(seconds) {
    if(!validRefreshSeconds(seconds))return false;
    writeStore({refreshSeconds:seconds});notice='';scheduleRender();return true;
  }
  function applyRefreshPreferences(current) {
    if(validRefreshSeconds(current.refreshSeconds)&&saved.refreshSeconds!==current.refreshSeconds) {
      saved.refreshSeconds=current.refreshSeconds;
      for(const entry of endpoints.values())if(!entry.failures)entry.nextAt=entry.lastRequest+refreshInterval();
    }
    if(typeof current.autoRefresh==='boolean')saved.autoRefresh=current.autoRefresh;
    if(!saved.autoRefresh)cancelRun();
    const select=shadow?.querySelector('#quota-refresh-preset');
    if(!select)return;
    select.value=[60,180,300,600].includes(saved.refreshSeconds)?String(saved.refreshSeconds):'custom';
    const custom=select.value==='custom',form=shadow.querySelector('.custom-interval');
    form.hidden=!custom;shadow.querySelector('.interval-hint').hidden=!custom;
    form.querySelector('input').value=String(saved.refreshSeconds/60);
  }
  function forgetEndpoints() {
    try { sessionStorage.removeItem(ENDPOINT_STORE); } catch { /* storage unavailable */ }
  }
  async function identityHash(user,account) {
    const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(user+'\n'+account));
    return Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
  }
  async function rememberEndpoints() {
    // Reload convenience within this tab only. No tokens or quota values are saved.
    if(!principal||!scope||!bearer)return;
    const generation=epoch;
    try {
      const identity=await identityHash(principal,scope);
      if(epoch!==generation)return;
      const paths=[...endpoints].filter(([,e])=>e.binding.replay&&e.fields.length).map(([url,e])=>{
        const u=new URL(url);
        return !u.search&&/^\/backend-api\/[a-z_/-]+$/i.test(u.pathname)?{path:u.pathname,credentials:e.binding.credentials}:null;
      }).filter(Boolean);
      if(paths.length)sessionStorage.setItem(ENDPOINT_STORE,JSON.stringify({identity,expires:Date.now()+21600000,paths}));
      else forgetEndpoints();
    } catch { /* optional cache; storage/crypto may be unavailable */ }
  }
  async function restoreEndpoints(account) {
    // A generic account-less request cannot establish the current workspace.
    if(!account||scope!==null||restoreTask)return;
    const task={epoch,account};restoreTask=task;
    try {
      const cache=JSON.parse(sessionStorage.getItem(ENDPOINT_STORE)||'null');
      if(!cache||!finite(cache.expires)||cache.expires<Date.now()||!Array.isArray(cache.paths))return;
      const identity=await identityHash(principal,account);
      if(restoreTask!==task||epoch!==task.epoch||scope!==null||identity!==cache.identity)return;
      const paths=cache.paths.slice(0,MAX_ENDPOINTS).filter(p=>typeof p.path==='string'&&/^\/backend-api\/[a-z_/-]+$/i.test(p.path)&&usageURL(p.path));
      if(!paths.length)return;
      scope=account;
      for(const p of paths) {
        endpoints.set(usageURL(p.path),{fields:[],failures:0,error:'',nextAt:0,lastRequest:0,seq:0,limited:false,
          binding:{epoch,account,principal,replay:true,credentials:['omit','same-origin','include'].includes(p.credentials)?p.credentials:'same-origin'}});
      }
      notice=saved.autoRefresh?'已恢复本标签页的接口，正在确认当前额度…':'已恢复接口；自动刷新已暂停，可点刷新确认额度';scheduleRender();refresh();
    } catch { /* invalid or unavailable cache */ }
    finally {if(restoreTask===task)restoreTask=null;}
  }
  function usageURL(input) {
    try {
      const u = new URL(input, location.href);
      if (u.href.length > 2048 || u.origin !== location.origin || u.username || u.password || !/^\/backend-api\//.test(u.pathname)) return null;
      const path = decodeURIComponent(u.pathname);
      if (!/(?:^|[\/_.-])(?:usage|quota|rate[-_]?limits?|credits?|reset[-_]?(?:cards?|tokens?|allowances?))(?:$|[\/_.-])/i.test(path)) return null;
      if (/(?:^|[\/_.-])(?:consume|redeem|purchase|checkout|apply|activate|perform|delete|create|update|use)(?:$|[\/_.-])/i.test(path)) return null;
      for (const [k, v] of u.searchParams) {
        if (/token|key|secret|signature|auth|code/i.test(k)) return null;
        if (/^(?:action|operation|method)$/i.test(k) && !/^(?:get|read|list|status)$/i.test(v)) return null;
      }
      u.hash = '';
      return u.href;
    } catch { return null; }
  }
  function principalOf(token) {
    try {
      const middle = token.slice(7).split('.')[1];
      const bytes = Uint8Array.from(atob(middle.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
      const payload = JSON.parse(new TextDecoder().decode(bytes));
      if (typeof payload.sub === 'string' && payload.sub && payload.sub.length < 512) return 'jwt:' + payload.sub;
    } catch { /* opaque bearer: a token change invalidates the scope */ }
    return 'opaque:' + token;
  }
  function cancelRun() {
    for (const c of controllers) c.abort();
    controllers.clear(); run = null;
  }
  function resetSession(nextPrincipal = '', nextScope = null, message = '') {
    epoch++; cancelRun();
    restoreTask=null;
    principal = nextPrincipal; scope = nextScope; bearer = '';
    endpoints.clear(); latestSeq.clear(); shapes.clear(); snapshot = ''; snapshotAt = 0; domFields = [];
    retryNotBefore = 0; authBlocked = false; notice = message; lastScriptRequestAt = 0;
    scheduleRender();
  }
  // Account-less quota requests use an explicit default scope. Generic
  // account-less requests never inherit or replace a quota workspace.
  function observeRequest(headers, isQuota, credentials = 'same-origin') {
    const h = new Headers(headers);
    const token = h.get('authorization') || '';
    const hasBearer = /^Bearer\s+\S+$/i.test(token);
    const nextPrincipal = hasBearer ? principalOf(token) : '';
    const account = h.get('chatgpt-account-id') || '';
    if (!isQuota) {
      if (!hasBearer) return null;
      if (principal !== nextPrincipal || (scope !== null && account && account !== scope) || (restoreTask && account && account !== restoreTask.account)) {
        resetSession(nextPrincipal, null, '登录或工作区发生变化，请重新打开额度页');
      }
      bearer = token;
      if(account)restoreEndpoints(account);
      return null;
    }
    if (principal !== nextPrincipal || scope !== account) resetSession(nextPrincipal, account, '正在识别当前额度页…');
    bearer = hasBearer ? token : '';
    return { epoch, account, principal: nextPrincipal, replay: hasBearer,
      credentials: ['omit', 'same-origin', 'include'].includes(credentials) ? credentials : 'same-origin',
      seq: ++sequence, sentAt: Date.now() };
  }
  function displayPath(parts) {
    return parts.filter(p => !/^(?:data|result|response)$/.test(keyName(p)))
      .map(p => names[keyName(p)] || String(p).replace(/[_-]/g, ' ').slice(0, 70)).join(' · ');
  }
  function itemLabel(item, index) {
    if (item && typeof item === 'object') {
      for (const k of ['model', 'model_slug', 'name', 'label', 'title']) {
        const value = item[k];
        if (typeof value === 'string' && value.trim() && value.length <= 60 && !/[@\r\n]/.test(value)) return '[' + (index + 1) + '：' + value.trim() + ']';
      }
    }
    return '[' + (index + 1) + ']';
  }
  // A shared node budget bounds traversal even when no metric matches. Only
  // fixed schema names go into diagnostics; dynamic keys never do.

  const resetCountKeys = new Set([
    'resets_remaining','remaining_resets','available_resets','reset_card_count','reset_cards_remaining',
    'remaining_reset_cards','remaining_reset_count','available_reset_count','usage_resets_remaining',
    'rate_limit_resets_remaining','reset_credits_remaining','reset_balance','reset_credits',
    'reset_count','rate_limit_reset_count','usage_reset_count','limit_resets','rate_limit_resets'
  ]);
  function resetContext(path) {
    return path.some(part => /^(?:(?:usage|limit|rate_limit)_)?resets?(?:_cards?|_allowances?|_credits?)?$/.test(keyName(part)) || /reset.*(?:card|allowance)/.test(keyName(part)) || resetCountKeys.has(keyName(part)));
  }
  function numericCount(value) {
    const n = typeof value === 'string' && /^\d{1,15}$/.test(value.trim()) ? Number(value.trim()) : value;
    return Number.isSafeInteger(n) && n >= 0 ? n : null;
  }
  function resetSemantic(path) {
    const keys = path.map(keyName);
    if (keys.some(k => /(?:^|_)(?:used|consumed|spent)(?:_|$)/.test(k))) return 'used';
    if (keys.some(k => /(?:^|_)(?:total|maximum)(?:_|$)/.test(k))) return 'total';
    return keys.some(k => /(?:^|_)(?:remaining|available)(?:_|$)/.test(k)) ? 'remaining' : 'unknown';
  }
  function windowInfo(path, owner) {
    const raw = owner?.limit_window_seconds ?? owner?.limitWindowSeconds ?? owner?.window_seconds ?? owner?.duration_seconds;
    const minutes = owner?.limit_window_minutes ?? owner?.window_minutes;
    const seconds = Number(raw ?? (minutes !== undefined ? Number(minutes) * 60 : 0));
    if (Number.isFinite(seconds) && seconds > 0) return { window: seconds === 18000 ? 'fiveHour' : seconds === 604800 ? 'weekly' : 'other', windowConfidence: 3 };
    const context = path.map(keyName).join('.');
    if (/(?:weekly|seven_days?|7_days?|周额度|每周)/i.test(context)) return { window: 'weekly', windowConfidence: 2 };
    if (/(?:five_hours?|5_hours?|5h|5小时)/i.test(context)) return { window: 'fiveHour', windowConfidence: 2 };
    if (/primary_window/.test(context)) return { window: 'primary', windowConfidence: 1 };
    if (/secondary_window/.test(context)) return { window: 'secondary', windowConfidence: 1 };
    return { window: '', windowConfidence: 0 };
  }

  function analyze(data) {
    const fields = [], foundShapes = new Set(), metrics = new Set();
    let budget = NODE_BUDGET;
    function walk(o, path, labels, depth) {
      if (!o || typeof o !== 'object' || depth > 10 || budget <= 0) return;
      let keys = 0;
      for (const raw in o) {
        if (!Object.prototype.hasOwnProperty.call(o, raw)) continue;
        if (++keys > 200 || budget-- <= 0) break;
        const k = keyName(raw);
        if (sensitive(k)) continue;
        const v = o[raw], p = [...path, raw];
        const label = Array.isArray(o) && /^\d+$/.test(raw) ? itemLabel(v, Number(raw)) : raw;
        const lp = [...labels, label];
        if (v && typeof v === 'object') { walk(v, p, lp, depth + 1); continue; }
        if (foundShapes.size < MAX_SHAPES && (finite(v) || typeof v === 'boolean' || (typeof v === 'string' && /reset|remaining|credit|quota|limit|count/i.test(k)))) foundShapes.add(schemaPath(p));
        if (fields.length >= MAX_FIELDS) continue;
        const context = p.map(keyName).join('.');
        const card = resetContext(p);
        const count = numericCount(v), period = windowInfo(p, o);
        let text = '', percent = null, until = null, kind = 'count';
        if (finite(v) && /^(?:used_percent|used_percentage|remaining_percent|remaining_percentage)$/.test(k) && v >= 0 && v <= 100) {
          percent = Math.round((k.startsWith('used_') ? 100 - v : v) * 10) / 10;
          text = percent + '%'; kind = 'percent';
        } else if (/^(?:reset_at|resets_at|reset_time|next_reset_at)$/.test(k) && (finite(v) || typeof v === 'string')) {
          const numeric = finite(v) ? v : /^(?:\d{10}|\d{13})$/.test(v) ? Number(v) : null;
          const t = numeric !== null ? (numeric < 1e12 ? numeric * 1000 : numeric) : Date.parse(v);
          if (Number.isFinite(t) && t > 1577836800000 && t < 4102444800000) { until = t; text = new Date(t).toLocaleString(); kind = 'time'; }
        } else if (finite(v) && k === 'reset_after_seconds' && v >= 0 && v <= 315360000) {
          until = Date.now() + v * 1000; text = new Date(until).toLocaleString(); kind = 'time';
        } else if (count !== null && (resetCountKeys.has(k) || (card && /^(?:count|available|available_count|balance|remaining|remaining_count|credits)$/.test(k)))) {
          text = String(count);
        } else if (!card && finite(v) && v >= 0 && (
          /^(?:remaining|remaining_count|remaining_credits|credits_remaining|remaining_balance|credit_balance|remaining_tokens)$/.test(k) ||
          (/credits?/.test(context) && k === 'balance')
        )) text = String(v);
        if (text) {
          // Some responses contain both used_percent and remaining_percent,
          // or multiple names for the same reset instant in one window.
          if(kind!=='count') {
            const metric=JSON.stringify([path,kind,percent,until]);
            if(metrics.has(metric))continue;
            metrics.add(metric);
          }
          fields.push({ id: JSON.stringify(p), schema: schemaPath(p), label: displayPath(lp), text, percent, until, kind, card,
            semantic: card && kind === 'count' ? resetSemantic(p) : 'remaining', ...period, source: 'api', at: Date.now() });
        }
      }
    }
    walk(data, [], [], 0);
    return { fields, shapes: foundShapes, budgetExhausted: budget <= 0 };
  }
  function accept(url, data, binding, observed = true) {
    if (!binding || binding.epoch !== epoch || binding.principal !== principal || binding.account !== scope) return false;
    let entry = endpoints.get(url);
    if (binding.seq < Math.max(entry?.seq||0,latestSeq.get(url)||0)) return false;
    latestSeq.delete(url); latestSeq.set(url, binding.seq);
    // Keep a bounded tombstone after deletion so late responses cannot revive old data.
    if (latestSeq.size > 128) latestSeq.delete(latestSeq.keys().next().value);
    if(observed)scheduleCapture();
    const result = analyze(data);
    for (const shape of result.shapes) { if (shapes.size >= MAX_SHAPES) break; shapes.add(shape); }
    if (!result.fields.length) {
      if (entry) { endpoints.delete(url); rememberEndpoints(); notice = '一个额度接口格式发生变化，请重新打开额度页'; scheduleRender(); }
      return false;
    }
    if (!entry && endpoints.size >= MAX_ENDPOINTS) {
      notice = '已识别 6 个接口；如有重复或遗漏，可在 ⋯ 中清除识别后重试'; scheduleRender(); return false;
    }
    if (!entry) { entry = { failures: 0, error: '', nextAt: 0, lastRequest: 0 }; endpoints.set(url, entry); }
    Object.assign(entry, { binding: { ...binding }, seq: binding.seq, fields: result.fields,
      failures: 0, error: '', nextAt: Date.now() + refreshInterval(), lastRequest: binding.sentAt,
      limited: result.budgetExhausted || result.fields.length === MAX_FIELDS });
    if (observed) {
      authBlocked = false; notice = binding.replay ? '' : '仅被动显示：未识别可重放的 Bearer 鉴权';
    }
    rememberEndpoints();
    scheduleRender(); return true;
  }

  async function readJSON(res) {
    if (Number(res.headers.get('content-length')) > MAX_JSON_BYTES) throw new Error('Response too large');
    if (!res.body?.getReader) return res.json();
    const reader = res.body.getReader(), decoder = new TextDecoder();
    let total = 0, text = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_JSON_BYTES) throw new Error('Response too large');
        text += decoder.decode(value, { stream: true });
      }
      return JSON.parse(text + decoder.decode());
    } catch (e) {
      // Do not await cancellation of a cloned/teed response stream.
      reader.cancel().catch(() => {}); throw e;
    } finally { reader.releaseLock(); }
  }

  // Return the original promise without modifying the site's Request or body.
  window.fetch = function (input, init) {
    let url = null, binding = null;
    try {
      const req = typeof Request !== 'undefined' && input instanceof Request ? input : null;
      const rawURL = req ? req.url : String(input), parsed = new URL(rawURL, location.href);
      const method = String(init?.method ?? req?.method ?? 'GET').toUpperCase();
      const headers = init?.headers !== undefined ? init.headers : req?.headers;
      if (parsed.origin === location.origin && /^\/backend-api\//.test(parsed.pathname)) {
        url = method === 'GET' ? usageURL(rawURL) : null;
        binding = observeRequest(headers, !!url, init?.credentials ?? req?.credentials ?? 'same-origin');
      }
    } catch { /* observation must not break fetch */ }
    const promise = nativeFetch.apply(this, arguments);
    if (url && binding) {
      promise.then(res => {
        if (binding.epoch !== epoch || !res.ok || !/json/i.test(res.headers.get('content-type') || '')) return;
        try { readJSON(res.clone()).then(data => accept(url, data, binding)).catch(() => {}); } catch { /* non-cloneable response */ }
      }).catch(() => {});
    }
    return promise;
  };

  // open/loadend both clean up; a reused XHR cannot retain an old URL listener.
  const xhrInfo = new WeakMap();
  const xo = XMLHttpRequest.prototype.open, xs = XMLHttpRequest.prototype.send, xh = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function (method, input) {
    xhrInfo.get(this)?.cleanup?.();
    const result = xo.apply(this, arguments);
    let backend = false;
    try { const u = new URL(input, location.href); backend = u.origin === location.origin && /^\/backend-api\//.test(u.pathname); } catch { /* invalid URL */ }
    xhrInfo.set(this, { method: String(method).toUpperCase(), url: usageURL(input), backend, headers: new Headers() });
    return result;
  };
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
    const result = xh.apply(this, arguments), info = xhrInfo.get(this);
    if (info && /^(?:authorization|chatgpt-account-id)$/i.test(k)) { try { info.headers.append(k, v); } catch { /* invalid header */ } }
    return result;
  };
  XMLHttpRequest.prototype.send = function () {
    const info = xhrInfo.get(this);
    if (info?.backend) {
      try {
        const quota = info.method === 'GET' && !!info.url;
        const binding = observeRequest(info.headers, quota, this.withCredentials ? 'include' : 'same-origin');
        if (quota && binding) {
          const load = () => {
            if (xhrInfo.get(this) !== info || binding.epoch !== epoch || this.status < 200 || this.status >= 300) return;
            try {
              if (!/json/i.test(this.getResponseHeader('content-type') || '')) return;
              if (Number(this.getResponseHeader('content-length')) > MAX_JSON_BYTES) return;
              if (this.responseType !== 'json' && this.responseText.length > MAX_JSON_BYTES) return;
              const data = this.responseType === 'json' ? this.response : JSON.parse(this.responseText);
              accept(info.url, data, binding);
            } catch { /* unsupported response type */ }
          };
          const cleanup = () => { this.removeEventListener('load', load); this.removeEventListener('loadend', cleanup); };
          info.cleanup = cleanup;
          this.addEventListener('load', load); this.addEventListener('loadend', cleanup, { once: true });
        }
      } catch { /* observation must not break XHR */ }
    }
    try { return xs.apply(this, arguments); } catch (e) { info?.cleanup?.(); throw e; }
  };
  function retryDelay(value, now = Date.now()) {
    if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Math.min(Number(value.trim()) * 1000, 86400000);
    const date = value ? Date.parse(value) : NaN;
    return Number.isFinite(date) ? Math.min(86400000, Math.max(0, date - now)) : 300000;
  }
  async function refresh(manual = false) {
    if (run) { if (manual) { notice = '正在刷新，请稍候'; scheduleRender(); } return; }
    if (document.hidden || !navigator.onLine) { if (manual) { notice = '页面不可见或网络离线，暂时无法刷新'; scheduleRender(); } return; }
    if (!manual && !saved.autoRefresh) return;
    if (authBlocked) { if (manual) { notice = '登录或访问校验已变化，请重新打开额度页完成识别'; scheduleRender(); } return; }
    const now = Date.now();
    if (now < retryNotBefore) { if (manual) { notice = ''; scheduleRender(); } return; }
    const eligible = [...endpoints].filter(([, e]) => e.binding.replay && e.binding.epoch === epoch);
    if (!eligible.length) { if (manual) { notice = '没有可刷新的接口，请先手动打开额度页'; scheduleRender(); } return; }
    const targets = eligible.filter(([, e]) => manual ? now - e.lastRequest >= 10000 : now >= e.nextAt);
    if (!targets.length) { if (manual) { notice = '距离上次请求不足 10 秒，请稍后再试'; scheduleRender(); } return; }
    const task = { epoch, token: bearer };
    run = task; notice = ''; scheduleRender();
    try {
      for (const [url, entry] of targets) {
        if (run !== task || epoch !== task.epoch || endpoints.get(url) !== entry) break;
        const controller = new AbortController(); controllers.add(controller);
        const timeout = setTimeout(() => controller.abort(), 15000);
        const binding = { ...entry.binding, seq: ++sequence, sentAt: Date.now() };
        entry.lastRequest = binding.sentAt; lastScriptRequestAt = binding.sentAt;
        const headers = { Authorization: task.token, Accept: 'application/json' };
        if (binding.account) headers['ChatGPT-Account-ID'] = binding.account;
        try {
          const res = await nativeFetch.call(window, url, { method: 'GET', credentials: binding.credentials, cache: 'no-store',
            headers, redirect: 'error', signal: controller.signal });
          if (run !== task || epoch !== task.epoch) break;
          if (binding.seq < entry.seq) continue;
          if (res.status === 401 || res.status === 403) {
            forgetEndpoints();
            epoch++; cancelRun(); endpoints.clear(); latestSeq.clear(); snapshot = ''; snapshotAt = 0; domFields = []; bearer = '';
            authBlocked = true; lastScriptRequestAt = 0; notice = '登录或访问校验已变化，请重新打开额度页；必要时刷新网页'; break;
          }
          if (res.status === 404 || res.status === 405) {
            endpoints.delete(url); rememberEndpoints(); notice = '一个额度接口已失效，请重新打开额度页'; continue;
          }
          if (res.status === 429) {
            retryNotBefore = Date.now() + retryDelay(res.headers.get('retry-after'));
            entry.nextAt = retryNotBefore; entry.error = '请求过于频繁'; entry.failures++; break;
          }
          if (!res.ok) throw new Error('HTTP ' + res.status);
          if (!/json/i.test(res.headers.get('content-type') || '')) {
            endpoints.delete(url); rememberEndpoints(); notice = '一个额度接口返回了非 JSON 内容，请重新打开额度页'; continue;
          }
          const data = await readJSON(res);
          if (run !== task || epoch !== task.epoch) break;
          accept(url, data, binding, false);
        } catch (e) {
          if (run !== task || epoch !== task.epoch) break;
          if (binding.seq < entry.seq) continue;
          entry.failures = Math.min(entry.failures + 1, 10);
          entry.nextAt = Date.now() + refreshInterval() * Math.min(8, 2 ** (entry.failures - 1));
          entry.error = e?.name === 'AbortError' ? '读取超时' : /^HTTP \d+$/.test(e?.message || '') ? '读取失败（' + e.message + '）' : '网络或数据解析失败';
        } finally { clearTimeout(timeout); controllers.delete(controller); }
      }
    } finally { if (run === task) run = null; scheduleRender(); }
  }

  function el(tag, text, className) {
    const e = document.createElement(tag);
    if (text !== undefined) e.textContent = text;
    if (className) e.className = className;
    return e;
  }
  function button(text, action, title) {
    const b = el('button', text); b.type = 'button'; b.title = title || text;
    b.setAttribute('aria-label', title || text); b.addEventListener('click', action); return b;
  }

  function icon(name) {
    const paths = {
      gauge: ['M4 16a8 8 0 1 1 16 0', 'M12 13l4-4', 'M7 18h10'],
      refresh: ['M20 7v5h-5', 'M4 17v-5h5', 'M6.1 7a7 7 0 0 1 11.6-1L20 9', 'M4 15l2.3 3A7 7 0 0 0 18 17'],
      pause: ['M9 5v14', 'M15 5v14'], play: ['M8 5l11 7-11 7z'],
      more: ['M5 12h.01', 'M12 12h.01', 'M19 12h.01'],
      minus: ['M5 12h14'], plus: ['M12 5v14', 'M5 12h14'],
      clock: ['M12 8v4l3 2', 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0'],
      reset: ['M3 11a9 9 0 1 1 2.7 7', 'M3 4v7h7'],
      chevron: ['M8 10l4 4 4-4'], download: ['M12 3v12', 'M7 10l5 5 5-5', 'M5 16v4h14v-4'],
      clear: ['M4 7h16', 'M10 3h4l1 4H9l1-4', 'M6 7l1 14h10l1-14', 'M10 11v6', 'M14 11v6'],
      position: ['M8 3H3v5', 'M16 3h5v5', 'M3 16v5h5', 'M21 16v5h-5', 'M8 12h8', 'M12 8v8'],
      scan: ['M8 3H5a2 2 0 0 0-2 2v3', 'M16 3h3a2 2 0 0 1 2 2v3', 'M3 16v3a2 2 0 0 0 2 2h3', 'M21 16v3a2 2 0 0 1-2 2h-3', 'M7 12h10', 'M12 8v8'],
      external: ['M14 3h7v7', 'M21 3l-9 9', 'M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5'],
      note: ['M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z', 'M14 3v6h6', 'M8 13h8', 'M8 17h5']
    };
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false');
    if (name === 'more') svg.classList.add('dots');
    for (const d of paths[name] || paths.gauge) {
      const p = document.createElementNS('http://www.w3.org/2000/svg', 'path'); p.setAttribute('d', d); svg.append(p);
    }
    return svg;
  }
  function setIcon(button, name) {
    if (button.dataset.icon === name) return;
    button.dataset.icon = name; button.replaceChildren(icon(name));
  }
  function iconButton(name, action, title) {
    const b = button('', action, title); b.className = 'icon-button'; setIcon(b, name); return b;
  }
  function fieldTitle(field) {
    if (field.card && field.kind === 'count') return field.semantic === 'remaining' ? '可用 Reset' : 'Reset 次数（原字段）';
    if (field.window === 'fiveHour') return '5h 额度';
    if (field.window === 'weekly') return '周额度';
    if (field.window === 'primary') return '短期额度';
    if (field.window === 'secondary') return '长期额度';
    const parts = field.label.split(' · ');
    if (parts.length > 1) parts.pop();
    const context = parts.filter(p => !/^(?:用量|models|模型)$/i.test(p)).join(' · ');
    return (context || (field.card ? 'Reset 卡' : field.kind === 'percent' ? '剩余额度' : field.label))
      .replace(/\[\d+：([^\]]+)\]/g, '$1');
  }
  function sameWindow(a, b) {
    if (a.group !== b.group) return false;
    try { return JSON.stringify(JSON.parse(a.id).slice(0, -1)) === JSON.stringify(JSON.parse(b.id).slice(0, -1)); }
    catch { return false; }
  }
  function syncTheme() {
    if (!host) return;
    const root = document.documentElement, theme = root.getAttribute('data-theme');
    const explicit = theme === 'dark' || root.classList.contains('dark') ? 'dark' : theme === 'light' || root.classList.contains('light') ? 'light' : '';
    host.dataset.theme = explicit || (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  }

  function ago(t) {
    const sec = Math.max(0, Math.floor((Date.now() - t) / 1000));
    if (sec < 60) return sec + ' 秒前';
    if (sec < 3600) return Math.floor(sec / 60) + ' 分钟前';
    if (sec < 86400) return Math.floor(sec / 3600) + ' 小时前';
    return Math.floor(sec / 86400) + ' 天前';
  }
  function remainingTime(t) {
    if (t <= Date.now()) return '计时已到，等待接口确认恢复';
    const minutes = Math.ceil((t - Date.now()) / 60000);
    const days = Math.floor(minutes / 1440), hours = Math.floor(minutes % 1440 / 60), rest = minutes % 60;
    const parts = [days ? days + ' 天' : '', hours ? hours + ' 小时' : '', rest ? rest + ' 分钟' : ''].filter(Boolean);
    return '约 ' + parts.join(' ') + '后恢复';
  }
  function scheduleRender() {
    if (!body || renderPending) return;
    renderPending = true;
    queueMicrotask(() => { renderPending = false; render(); });
  }
  function finishMorph() {
    if(!morph)return;
    const current=morph;morph=null;
    for(const animation of current.animations)animation.cancel();
    current.ghost.remove();
  }
  function toggleCollapsed() {
    const before=cardElement.getBoundingClientRect();
    const radius=getComputedStyle(cardElement).borderRadius;
    const ghost=surfaceElement.cloneNode(true);
    // Freeze only layout properties that change between the two header modes.
    for(const selector of ['header']) {
      const originals=surfaceElement.querySelectorAll(selector),copies=ghost.querySelectorAll(selector);
      originals.forEach((node,index)=>{
        const style=getComputedStyle(node);
        for(const key of ['display','padding','gap'])copies[index].style[key]=style[key];
      });
    }
    ghost.style.width=getComputedStyle(surfaceElement).width;
    ghost.style.padding=getComputedStyle(surfaceElement).padding;
    finishMorph();
    collapsed=!collapsed;writeStore();render();
    const target=cardElement.getBoundingClientRect();
    const targetRadius=getComputedStyle(cardElement).borderRadius;
    // Preserve the lower-right corner unless expansion needs more viewport room.
    const right=Math.max(target.width+8,Math.min(before.right,innerWidth-8));
    const bottom=Math.max(target.height+8,Math.min(before.bottom,innerHeight-8));
    host.style.left='';host.style.top='';
    host.style.right=(innerWidth-right)+'px';host.style.bottom=(innerHeight-bottom)+'px';
    if(!cardElement.animate||window.matchMedia?.('(prefers-reduced-motion: reduce)').matches){clampPosition();return;}
    ghost.classList.add('motion-ghost');ghost.setAttribute('aria-hidden','true');ghost.inert=true;
    cardElement.append(ghost);
    const duration=collapsed?320:400,easing='cubic-bezier(.22,1,.36,1)';
    const animations=[
      cardElement.animate([
        {width:before.width+'px',height:before.height+'px',borderRadius:radius,transform:`translate(${before.right-right}px,${before.bottom-bottom}px)`},
        {width:target.width+'px',height:target.height+'px',borderRadius:targetRadius,transform:'translate(0,0)'}
      ],{duration,easing}),
      ghost.animate([{opacity:1},{opacity:0}],{duration:collapsed?130:100,fill:'forwards'}),
      surfaceElement.animate([{opacity:0,transform:`translateY(${collapsed?2:6}px)`},{opacity:1,transform:'translateY(0)'}],
        {duration:collapsed?200:280,delay:collapsed?65:70,easing,fill:'backwards'})
    ];
    const current={animations,ghost};morph=current;
    Promise.all(animations.map(a=>a.finished)).then(()=>{
      if(morph===current){finishMorph();clampPosition();}
    }).catch(()=>{});
  }
  function render() {
    if (!body) return;
    body.hidden = collapsed; footer.hidden = collapsed; toolsPanel.hidden = !menuOpen; host.dataset.collapsed = String(collapsed);
    setIcon(collapseButton, collapsed ? 'plus' : 'minus'); collapseButton.setAttribute('aria-expanded', String(!collapsed));
    collapseButton.title=collapsed?'展开额度详情':'收起额度详情';collapseButton.setAttribute('aria-label',collapseButton.title);
    setIcon(pauseButton, saved.autoRefresh ? 'pause' : 'play');
    pauseButton.title = saved.autoRefresh ? '暂停自动刷新' : '恢复自动刷新'; pauseButton.setAttribute('aria-label', pauseButton.title);
    pauseButton.setAttribute('aria-pressed', String(!saved.autoRefresh));
    refreshButton.classList.toggle('is-spinning', !!run); refreshButton.setAttribute('aria-busy', String(!!run));
    moreButton.setAttribute('aria-expanded', String(menuOpen));
    const entries = displayEntries();
    const fields = entries.flatMap((entry, index) => entry.fields.map(f => ({ ...f, group: index + 1 })));
    compactSummary.hidden = !collapsed;
    for (const [node, window] of [[compactFive,'fiveHour'],[compactWeek,'weekly']]) {
      const value=compactValue(fields,window);node.textContent=value.text;node.parentElement.title=value.title;
      node.parentElement.classList.toggle('stale',value.stale);node.parentElement.dataset.tone=value.tone||'unknown';
    }
    const resets=compactResetValue(fields);
    compactReset.textContent=resets.text;compactReset.parentElement.title=resets.title;
    compactReset.parentElement.classList.toggle('stale',resets.stale);
    const shown = fields.slice(0, 60), signature = JSON.stringify(shown);
    if (signature !== renderedSignature) {
      renderedSignature = signature;
      const scroll = body.scrollTop;
      dataBox.replaceChildren(); rowRefs = [];
      const consumed = new Set(), fieldKey = f => f.group + ':' + f.id;
      const addMetric = (f, paired) => {
        const type = f.kind === 'percent' ? 'usage' : f.kind === 'time' ? 'time' : f.card ? 'reset' : 'count';
        const box = el('section', undefined, 'metric metric--' + type); box.title = (f.source==='page'?'页面读取（静态） · ':'')+f.label;
        if (type === 'usage') box.dataset.tone=quotaTone(f.percent);
        const heading = el('div', undefined, 'metric-heading');
        const title = el('span', fieldTitle(f), 'metric-title');
        if (type === 'reset') { const mark = el('span', undefined, 'reset-mark'); mark.append(icon('reset')); heading.append(mark); }
        heading.append(title);
        if(f.source==='page')heading.append(el('span','页面读取','page-source'));
        if (type === 'usage') heading.append(el('span', quotaBadge(f.percent), 'metric-badge'));
        box.append(heading);
        if (type === 'usage') {
          const value = el('strong', undefined, 'metric-value');
          value.append(el('span', String(f.percent)), el('span', '%', 'metric-unit')); box.append(value);
          const bar = el('div', undefined, 'bar'), fill = el('div');
          bar.setAttribute('role', 'progressbar'); bar.setAttribute('aria-label', f.label);
          bar.setAttribute('aria-valuemin', '0'); bar.setAttribute('aria-valuemax', '100'); bar.setAttribute('aria-valuenow', String(f.percent));
          bar.setAttribute('aria-valuetext',f.percent+'% 剩余 · '+quotaBadge(f.percent));
          fill.style.width = f.percent + '%'; bar.append(fill); box.append(bar);
        } else if (type !== 'time') {
          const value = el('strong', f.text, 'metric-value');
          const caption = el('span', f.card ? ({remaining:'剩余次数',used:'已用次数',total:'总次数',unknown:'含义待确认'}[f.semantic]||'含义待确认') : f.label.split(' · ').at(-1), 'metric-caption');
          const amount = el('div', undefined, 'metric-amount'); amount.append(value, caption); box.append(amount);
        }
        const timeField = paired || (f.kind === 'time' ? f : null);
        let timer = null;
        if (timeField) {
          const reset = el('div', undefined, 'reset-block'), line = el('div', undefined, 'reset-line');
          timer = el('span'); line.append(icon('clock'), timer);
          const date = el('time', timeField.text, 'reset-date'); date.dateTime = new Date(timeField.until).toISOString();
          reset.append(line, date); box.append(reset);
        }
        rowRefs.push({ row: box, timer, field: timeField || f });
        consumed.add(fieldKey(f)); if (paired) consumed.add(fieldKey(paired));
        return box;
      };
      for (let group = 1; group <= entries.length; group++) {
        const items = shown.filter(f => f.group === group);
        if (!items.length) continue;
        const section = el('div', undefined, 'metric-group');
        if (entries[group-1].dom || entries.filter(e=>!e.dom).length > 1) section.append(el('div', entries[group-1].dom?'页面读取 · 静态':'额度分组 ' + String(group).padStart(2, '0'), 'section-label'));
        for (const f of items.filter(f => f.kind === 'percent')) {
          const paired = items.find(t => t.kind === 'time' && !consumed.has(fieldKey(t)) && sameWindow(f, t));
          section.append(addMetric(f, paired));
        }
        const counts = items.filter(f => f.kind === 'count');
        if (counts.length) {
          const grid = el('div', undefined, 'stat-grid');
          for (const f of counts) grid.append(addMetric(f));
          section.append(grid);
        }
        for (const f of items.filter(f => !consumed.has(fieldKey(f)))) section.append(addMetric(f));
        dataBox.append(section);
      }
      body.scrollTop = scroll;
    }
    for (const { row, timer, field } of rowRefs) {
      row.classList.toggle('stale', isStale(field));
      if (timer) timer.textContent = remainingTime(field.until);
    }
    emptyHint.hidden = fields.length > 0;
    cardHint.hidden = fields.some(remainingReset);
    const limited = entries.some(e => e.limited);
    overflowHint.hidden = fields.length <= 60 && !limited;
    overflowHint.textContent = fields.length > 60 ? '仅显示前 60 项；可清除识别后重新打开所需额度页。' : '数据较多，部分字段暂未显示。';
    excerpt.hidden = !snapshot; excerptAge.textContent = ago(snapshotAt);
    if (excerptText.textContent !== snapshot) excerptText.textContent = snapshot;
    const errors = [...endpoints.values()].filter(e => e.error), replay = [...endpoints.values()].some(e => e.binding.replay);
    const stale = fields.some(isStale), limitedNow = Date.now() < retryNotBefore;
    let state = 'idle', label = '等待识别';
    if (fields.length) { state = 'live'; label = replay ? '自动更新' : '被动显示'; }
    if (!saved.autoRefresh) { state = 'paused'; label = '已暂停自动更新'; }
    if (stale) { state = 'warning'; label = '数据待更新'; }
    if (errors.length) { state = 'warning'; label = '部分更新异常'; }
    if (!navigator.onLine) { state = 'paused'; label = '网络离线'; }
    if (run) { state = 'syncing'; label = '正在同步'; }
    if (limitedNow) { state = 'warning'; label = '稍后重试'; }
    if (authBlocked) { state = 'warning'; label = '需要重新识别'; }
    statusLabel.textContent = label; host.dataset.state = state;
    let text = run ? '正在主动请求额度…' : lastScriptRequestAt ? '上次主动请求 '+ago(lastScriptRequestAt) : fields.length ? '本页尚未主动请求' : '打开额度页，即可开始识别';
    if (!saved.autoRefresh) text += ' · 自动更新已暂停';
    if (stale) text = '部分数据已过期 · ' + text;
    if (errors.length) text = errors.length + ' 个接口异常（' + errors[0].error + '），其余接口独立刷新';
    if (notice) text = notice;
    if (limitedNow) text = '请求限流，' + Math.ceil((retryNotBefore - Date.now()) / 1000) + ' 秒后可重试';
    footerText.textContent = text;
    dockLabel.textContent=run?'请求中':!saved.autoRefresh?'已暂停':lastScriptRequestAt?ago(lastScriptRequestAt):'未主动请求';
    dockLabel.parentElement.title=text;
  }

  // DOM fallback stays inside a selected usage panel or the dedicated usage
  // page's main region. It never clicks controls or reads a chat transcript.
  const RESET_LABEL = /\bresets?\b|重置|リセット|초기화|재설정|réinitialis|reinitialis|restablec|redefini|zurücksetz|zuruecksetz|ripristin/i;
  const AVAILABLE_WORDS = '(?<![A-Za-z])(?:available|remaining|left|可用|剩余|disponibles?|restants?|verfügbar|verbleibend|dispon[ií]vel|dispon[ií]veis|disponibil[ei]|利用可能|残り|사용\\s*가능|남은)(?![A-Za-z])';
  function usageRoute() {
    try { return /^\/settings\/usage\/?$/.test(new URL(location.href).pathname); } catch { return false; }
  }
  function parseResetText(input, contextual = false) {
    const text = String(input).normalize('NFKC').replace(/\u00a0/g,' ').trim();
    if (!contextual && !RESET_LABEL.test(text)) return null;
    const numbers = new Set();
    // Match a complete integer, including valid thousands groups. Never accept
    // the trailing digits of a decimal, negative number or malformed grouping.
    const integer = '(?<![\\d.,+−-])((?:\\d{1,3}(?:,\\d{3}){1,2}|\\d{1,9}))(?![\\d.,])';
    const patterns = [
      '(?:'+AVAILABLE_WORDS+')[\\s:：]*'+integer,
      integer+'[\\s]*(?:resets?|reset\\s*cards?|次|张|个|個|回|개)?[\\s]*(?:'+AVAILABLE_WORDS+')',
      '(?:剩余|可用)[\\s的]*(?:重置|reset)(?:次数|卡|s)?[\\s:：]*'+integer,
      '(?:remaining|available)\\s+(?:usage\\s+|limit\\s+|rate\\s*limit\\s+)?resets?\\s*[:：]?\\s*'+integer,
      integer+'\\s*(?:resets?|reset\\s*cards?|次重置|张重置卡)\\s*(?:'+AVAILABLE_WORDS+')'
    ].map(pattern => new RegExp(pattern, 'giu'));
    for (const pattern of patterns) {
      for (const m of text.matchAll(pattern)) {
        const tail=text.slice(m.index+m[0].length).trimStart();
        if (/^(?:%|[-/:]\s*\d|used\b|consumed\b|spent\b|已用|已使用|h\b|m\b|s\b|d\b|w\b|hours?\b|hrs?\b|minutes?\b|mins?\b|seconds?\b|secs?\b|days?\b|weeks?\b|小时|分钟|秒|天|周|時間|분|시간)/i.test(tail)) continue;
        const value=numericCount(m[1].replace(/,/g,'')); if(value!==null)numbers.add(value);
      }
    }
    return numbers.size===1?[...numbers][0]:null;
  }
  function parsePagePercent(input) {
    const text=String(input).normalize('NFKC').trim();
    const five=/(?:5[\s-]*(?:h(?:ours?)?|小时)|five[\s-]*hours?|5時間|5시간)/i.test(text);
    const week=/weekly|week(?:ly)?\s+(?:usage|limit)|7[\s-]*days?|每周|周额度|周限额|週間|주간|hebdomad|wöchentlich|semanal|settiman/i.test(text);
    if(five===week)return null;
    const matches=[...text.matchAll(/(?<![\d.,+−-])(\d+(?:\.\d+)?)\s*%/g)];
    if(matches.length!==1)return null;
    const m=matches[0], value=Number(m[1]); if(value<0||value>100)return null;
    const before=text.slice(Math.max(0,m.index-30),m.index),after=text.slice(m.index+m[0].length,m.index+m[0].length+30);
    const remaining=new RegExp('(?:'+AVAILABLE_WORDS+')[\\s:：]*$','i').test(before) || new RegExp('^[\\s]*(?:'+AVAILABLE_WORDS+')','i').test(after);
    const used=/used\s*[:：]?\s*$|已(?:使用|用)\s*[:：]?\s*$/i.test(before)||/^\s*(?:used|已使用|已用)/i.test(after);
    if(remaining===used)return null;
    return {window:five?'fiveHour':'weekly',percent:Math.round((used?100-value:value)*10)/10};
  }
  function usageSources() {
    const sources=[];
    for(const dialog of document.querySelectorAll('[role="dialog"],dialog')) {
      if(!dialog.getClientRects().length)continue;
      const active=[...dialog.querySelectorAll('[role="tab"][aria-selected="true"],[aria-current="page"],[role="tab"][data-state="active"]')]
        .find(e=>/^(?:额度|用量|使用量|使用情况|usage|limits|credits|utilisation|nutzung|uso|使用状況|사용량)$/i.test(e.textContent.trim()));
      if(!active)continue;
      const id=active.getAttribute('aria-controls');let source=id?document.getElementById(id):null;
      if(source&&!dialog.contains(source))source=null;
      if(!source&&active.id)source=[...dialog.querySelectorAll('[role="tabpanel"]')].find(p=>(p.getAttribute('aria-labelledby')||'').split(/\s+/).includes(active.id));
      if(!source){const visible=[...dialog.querySelectorAll('[role="tabpanel"]')].filter(p=>!p.hidden&&p.getAttribute('data-state')!=='inactive'&&p.getClientRects().length);if(visible.length===1)source=visible[0];}
      if(source&&!source.hidden&&source.getClientRects().length)sources.push(source);
    }
    if(usageRoute()) {
      for(const main of document.querySelectorAll('main,[role="main"]')) {
        if(!main.getClientRects().length||main.querySelector('[data-message-author-role],[data-testid^="conversation-turn"]'))continue;
        const heading=[...main.querySelectorAll('h1,h2,h3,[role="heading"]')].some(e=>/usage|用量|额度|limits|credits|utilisation|nutzung|uso|使用状況|사용량/i.test(e.textContent));
        if(heading&&!sources.some(s=>s.contains(main)||main.contains(s)))sources.push(main);
      }
    }
    return sources;
  }

  function resetScope(node,source) {
    let parent=node.parentElement;
    for(let depth=0;parent&&parent!==source&&depth<4;depth++,parent=parent.parentElement) {
      const labels=[...parent.querySelectorAll('h1,h2,h3,h4,[role="heading"],dt,legend,strong,span')].slice(0,60)
        .map(e=>(e.innerText||'').trim()).filter(text=>text.length>0&&text.length<80);
      const heading=labels.some(text=>RESET_LABEL.test(text)&&!/[0-9%]|\b(?:in|after|at|every)\b|时间|小时|分钟/i.test(text));
      const mixed=labels.some(text=>/(?:5[\s-]*(?:h(?:ours?)?|小时)|weekly|周额度|每周)/i.test(text));
      if(heading&&!mixed)return true;
    }
    return false;
  }

  function inspectUsageSource(source) {
    const resetValues=new Set(), percentages={fiveHour:new Set(),weekly:new Set()};
    const walker=document.createTreeWalker(source,NodeFilter.SHOW_ELEMENT);
    let visited=0;
    for(let node=source;node&&visited++<1200;node=walker.nextNode()) {
      if(!/^(?:SECTION|ARTICLE|DIV|P|SPAN|LI|DL|DT|DD|MAIN)$/.test(node.tagName))continue;
      if(!node.getClientRects().length||node.closest('[hidden],[aria-hidden="true"]'))continue;
      const text=(node.innerText||'').trim();if(!text||text.length>420)continue;
      const contextual=!RESET_LABEL.test(text)&&new RegExp(AVAILABLE_WORDS,'i').test(text)&&resetScope(node,source);
      const count=parseResetText(text,contextual);if(count!==null)resetValues.add(count);
      const percent=parsePagePercent(text);if(percent)percentages[percent.window].add(percent.percent);
    }
    const found=[];const make=(id,label,text,extra)=>({id:JSON.stringify(['page',id]),schema:'page.'+id,label,text,percent:null,until:null,kind:'count',card:false,source:'page',at:Date.now(),...extra});
    if(resetValues.size===1)found.push(make('available_resets','Reset 次数 · 剩余次数',String([...resetValues][0]),{card:true,semantic:'remaining'}));
    for(const window of ['fiveHour','weekly'])if(percentages[window].size===1){const percent=[...percentages[window]][0];found.push(make(window,window==='fiveHour'?'5h 额度 · 剩余比例':'周额度 · 剩余比例',percent+'%',{kind:'percent',percent,window,windowConfidence:3}));}
    return {found,ambiguous:[...(resetValues.size>1?['available_resets']:[]),...Object.keys(percentages).filter(k=>percentages[k].size>1)]};
  }
  function captureDOM() {
    if(authBlocked)return; // A stale open panel cannot undo a failed authentication check.
    const sources=usageSources();
    if(!sources.length)return; // Closed panels retain explicitly dated historical readings.
    const next=new Map(),invalid=new Set(),texts=[];
    for(const source of sources) {
      texts.push((source.innerText||'').trim());
      const result=inspectUsageSource(source);
      for(const id of result.ambiguous)invalid.add(JSON.stringify(['page',id]));
      for(const field of result.found) {
        if(next.has(field.id)&&next.get(field.id).text!==field.text)invalid.add(field.id);
        next.set(field.id,field);
      }
    }
    for(const id of invalid)next.delete(id);
    // A visible but unreadable panel invalidates its old fields; never merge
    // newly parsed fields into a previous panel's values.
    domFields=[...next.values()].map(field=>{
      const old=domFields.find(f=>f.id===field.id&&f.text===field.text);
      return old||field;
    });
    const text=texts.join('\n\n').slice(0,3500);
    if(snapshot!==text){snapshot=text;snapshotAt=Date.now();}
    scheduleRender();
  }
  const isStale = field => Date.now()-field.at>staleAfter();
  const remainingReset = field => field.card&&field.kind==='count'&&field.semantic==='remaining';
  // Additional/model-specific quotas must not displace the main overview.
  const mainMetric = field => !/(?:additional|models?|resources?|features?|review)/i.test(field.id);
  function equivalent(a,b) {
    return remainingReset(b)?remainingReset(a):a.kind==='percent'&&a.window===b.window&&mainMetric(a);
  }
  function displayEntries() {
    const entries=[...endpoints.values()];
    const suppressed=new Set(),fallback=[];
    for(const field of domFields) {
      const matching=entries.flatMap(e=>e.fields.filter(f=>equivalent(f,field)).map(f=>({field:f,error:e.error})));
      if(matching.some(m=>!isStale(m.field)&&!m.error))continue;
      if(!isStale(field))for(const match of matching)suppressed.add(match.field);
      fallback.push(field);
    }
    const shown=entries.map(e=>({...e,fields:e.fields.filter(f=>!suppressed.has(f))})).filter(e=>e.fields.length);
    return fallback.length?[...shown,{fields:fallback,binding:{replay:false},limited:false,error:'',dom:true}]:shown;
  }
  function compactValue(fields,window) {
    let items=fields.filter(f=>f.kind==='percent'&&f.window===window&&mainMetric(f));
    if(!items.length)return {text:'—',title:'尚未识别，请打开额度页',stale:false};
    const fresh=items.filter(f=>!isStale(f));if(fresh.length)items=fresh;
    const rank=f=>(f.source==='page'?0:100)+(f.windowConfidence||0)+(/(?:^|\.)rate_limits?\./.test(f.schema)?20:0)-(/additional/.test(f.id)?40:0);
    const top=Math.max(...items.map(rank)),best=items.filter(f=>rank(f)===top);
    if(new Set(best.map(f=>f.percent)).size!==1)return {text:'—',title:'多个额度来源的数值不同，请展开查看',stale:false};
    const f=best.reduce((a,b)=>a.at>b.at?a:b),stale=isStale(f);
    return {text:f.percent+'%',title:(f.source==='page'?'页面读取 · ':'')+f.label+' · '+quotaBadge(f.percent)+' · '+ago(f.at)+(stale?' · 数据已过期':''),stale,tone:quotaTone(f.percent)};
  }
  function compactResetValue(fields) {
    let items=fields.filter(f=>remainingReset(f)&&mainMetric(f));
    if(!items.length)return {text:'—',title:'尚未识别可用 Reset 次数',stale:false};
    const fresh=items.filter(f=>!isStale(f));if(fresh.length)items=fresh;
    const api=items.filter(f=>f.source==='api');if(api.length)items=api;
    if(new Set(items.map(f=>f.text)).size!==1)return {text:'—',title:'可用 Reset 来源存在冲突，请展开查看',stale:false};
    const field=items.reduce((a,b)=>a.at>b.at?a:b);
    return {text:field.text,title:'可用 Reset '+field.text+' 次 · '+ago(field.at),stale:isStale(field)};
  }
  function scheduleCapture() {
    if(dialogTimer||document.hidden)return;
    dialogTimer=setTimeout(()=>{dialogTimer=0;captureDOM();},400);
  }
  function discoverDialogs() {
    const roots=[...document.querySelectorAll('[role="dialog"],dialog'),...(usageRoute()?document.querySelectorAll('main,[role="main"]'):[])];
    const active=new Set(roots);
    for(const [node,observer] of dialogObservers)if(!active.has(node)){observer.disconnect();dialogObservers.delete(node);}
    for(const root of roots){if(dialogObservers.has(root))continue;const observer=new MutationObserver(()=>{if(root.getClientRects().length)scheduleCapture();});
      observer.observe(root,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['aria-selected','aria-current','aria-controls','data-state','hidden','open','class','style']});dialogObservers.set(root,observer);}
    scheduleCapture();
  }
  function diagnosticData() {
    return {
      version: VERSION,
      note: '固定字段名白名单；未知键为 [field]、数组索引为 []。无字段值、凭据、账号标识、接口地址或摘录。',
      endpointCount: endpoints.size, observedFields: [...shapes].sort(),
      recognizedFields: [...new Set([...endpoints.values()].flatMap(e => e.fields.map(f => f.schema)).concat(domFields.map(f=>f.schema)))].sort(),
      hasDOMExcerpt: !!snapshot, domFieldCount: domFields.length,
      mode: authBlocked ? 'authentication-blocked' : [...endpoints.values()].some(e => e.binding.replay) ? 'replay-available' : 'passive',
      parserLimited: [...endpoints.values()].some(e => e.limited)
    };
  }
  function diagnose() {
    const blob = new Blob([JSON.stringify(diagnosticData(), null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob), a = el('a');
    a.href = url; a.download = 'chatgpt-quota-diagnostic.json'; a.hidden = true;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function clampPosition() {
    if (!host || clampPending) return;
    clampPending = true;
    requestAnimationFrame(() => {
      clampPending = false;
      if (!host?.isConnected || morph) return;
      const r = host.getBoundingClientRect();
      if (host.style.left || r.left < 8 || r.top < 8 || r.right > innerWidth - 8 || r.bottom > innerHeight - 8) place(r.left, r.top);
    });
  }
  function place(x, y) {
    if (!host) return;
    const r = host.getBoundingClientRect();
    host.style.left = Math.max(8, Math.min(x, innerWidth - r.width - 8)) + 'px';
    host.style.top = Math.max(8, Math.min(y, innerHeight - r.height - 8)) + 'px';
    host.style.right = 'auto'; host.style.bottom = 'auto';
  }
  function refreshSettings() {
    const panel=el('div',undefined,'refresh-setting'),row=el('div',undefined,'interval-row');
    const label=el('label','刷新间隔'),select=el('select');
    select.id='quota-refresh-preset';label.htmlFor=select.id;
    for(const [value,text] of [['60','1 分钟'],['180','3 分钟'],['300','5 分钟'],['600','10 分钟'],['custom','自定义…']]) {
      const option=el('option',text);option.value=value;select.append(option);
    }
    const presets=[60,180,300,600];
    select.value=presets.includes(saved.refreshSeconds)?String(saved.refreshSeconds):'custom';
    row.append(label,select);
    const form=el('form',undefined,'custom-interval'),input=el('input'),apply=el('button','保存');
    input.type='number';input.min='0.5';input.max='60';input.step='any';input.required=true;
    input.value=String(saved.refreshSeconds/60);input.setAttribute('aria-label','自定义刷新间隔（分钟）');
    apply.type='submit';form.append(input,el('span','分钟'),apply);form.hidden=select.value!=='custom';
    const hint=el('span','自定义范围：0.5–60 分钟','interval-hint');hint.hidden=form.hidden;
    select.addEventListener('change',()=>{
      form.hidden=select.value!=='custom';hint.hidden=form.hidden;
      if(!form.hidden){input.value=String(saved.refreshSeconds/60);input.focus();}
      else setRefreshInterval(Number(select.value));
      clampPosition();
    });
    input.addEventListener('input',()=>input.setCustomValidity(''));
    form.addEventListener('submit',event=>{
      event.preventDefault();
      const seconds=Math.round(Number(input.value)*60);
      if(!input.value||!validRefreshSeconds(seconds)) {
        input.setCustomValidity('请输入 0.5–60 分钟');input.reportValidity();return;
      }
      input.setCustomValidity('');setRefreshInterval(seconds);input.value=String(seconds/60);
    });
    panel.append(row,form,hint);return panel;
  }
  function mount() {
    if (!document.body || host?.isConnected) return;
    sizeObserver?.disconnect();
    host = el('div'); host.id = 'local-chatgpt-quota-hud';
    host.style.cssText = 'position:fixed;right:18px;bottom:52px;z-index:2147483000;max-width:calc(100vw - 16px);';
    shadow = host.attachShadow({ mode: 'closed' });
    const style = el('style');
    style.textContent = `
      :host{--quota-healthy:#16745d;--quota-warning:#946200;--quota-critical:#b83c45;--surface:#fff;--surface-soft:#f6f8f7;--ink:#20312c;--muted:#617369;--line:#e8eeeb;--accent:#16886c;--accent-soft:#eaf6f0;--purple:#7761b0;--purple-soft:#f2eff9;--warning:#ad7932;--danger:#c26061;--shadow:0 16px 48px #183b2c14,0 2px 8px #183b2c08;color-scheme:light;font:14px/1.5 ui-sans-serif,system-ui,-apple-system,'Segoe UI','Microsoft YaHei',sans-serif;color:var(--ink);text-align:left;letter-spacing:normal}
      :host([data-theme="dark"]){--quota-healthy:#78d3b2;--quota-warning:#ebc45f;--quota-critical:#f18a91;--surface:#202724;--surface-soft:#272f2b;--ink:#ecf2ee;--muted:#9aaea2;--line:#354139;--accent:#78d3b2;--accent-soft:#293f35;--purple:#c0a9eb;--purple-soft:#34303e;--warning:#dfba78;--danger:#efa3a0;--shadow:0 20px 56px #0005,0 2px 10px #0003;color-scheme:dark}
      *{box-sizing:border-box}[hidden]{display:none!important}svg{display:block;width:18px;height:18px;flex:none;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round;pointer-events:none}.dots{stroke-width:3.8}
      .card{position:relative;width:352px;max-width:calc(100vw - 16px);max-height:min(552px,calc(100dvh - 16px));overflow:hidden;border:1px solid var(--line);border-radius:22px;background:var(--surface);box-shadow:var(--shadow)}
      .card-surface{display:flex;flex-direction:column;width:min(350px,calc(100vw - 18px));max-height:min(550px,calc(100dvh - 18px));padding-bottom:52px}
      .motion-ghost{position:absolute;inset:0 auto auto 0;pointer-events:none;user-select:none;overflow:hidden}
      header{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 16px 10px;flex:none;cursor:grab;touch-action:none;user-select:none}header:active{cursor:grabbing}
      .brand{display:flex;align-items:center;gap:10px;min-width:0}.brand-mark{display:grid;place-items:center;width:32px;height:32px;flex:none;border-radius:12px;background:var(--accent-soft);color:var(--accent)}.brand-mark svg{width:23px;height:23px}.brand-copy{min-width:0}.brand-title{display:block;font-size:16px;font-weight:650;letter-spacing:.3px;white-space:nowrap}.brand-status{display:flex;align-items:center;gap:5px;margin-top:2px;color:var(--muted);font-size:12px;white-space:nowrap}
      .status-dot,.footer-dot{width:5px;height:5px;flex:none;border-radius:50%;background:var(--muted)}:host([data-state="live"]) .status-dot,:host([data-state="syncing"]) .status-dot{background:var(--accent)}:host([data-state="paused"]) .status-dot,:host([data-state="warning"]) .status-dot{background:var(--warning)}:host([data-state="syncing"]) .status-dot{animation:quota-pulse 1.3s ease-in-out infinite}
      .dock{position:absolute;bottom:0;right:0;left:0;height:52px;border-top:1px solid var(--line);background:var(--surface);z-index:2;touch-action:none;user-select:none;cursor:grab}.dock-status{position:absolute;left:14px;bottom:17px;display:flex;align-items:center;gap:6px;font-size:12px;color:var(--muted);white-space:nowrap}.controls{position:absolute;right:12px;bottom:10px;display:flex;align-items:center;gap:3px}button{appearance:none;font:inherit;cursor:pointer;color:inherit;border:0;background:transparent;border-radius:9px;padding:7px;transition:background .16s,color .16s,transform .16s}button:hover{background:var(--surface-soft)}button:active{transform:scale(.94)}button:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:3px}.icon-button{display:grid;place-items:center;width:30px;height:32px;padding:5px;color:var(--muted)}.icon-button svg{width:17px;height:17px}.icon-button:hover,.icon-button[data-menu="true"][aria-expanded="true"],.icon-button[aria-pressed="true"]{background:var(--accent-soft);color:var(--accent)}.is-spinning>svg{animation:quota-spin 1s linear infinite}
      main{min-height:0;max-height:min(64vh,640px);overflow:auto;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:var(--line) transparent;padding:0 16px 16px}main::-webkit-scrollbar{width:4px}main::-webkit-scrollbar-thumb{background:var(--line);border-radius:4px}
      .metric-group+.metric-group{margin-top:18px}.section-label{margin:0 2px 9px;color:var(--muted);font-size:12px;letter-spacing:1px}.metric{min-width:0;border:1px solid var(--line);border-radius:15px;background:var(--surface-soft);padding:12px 14px;transition:opacity .2s}.metric--usage+.metric--usage,.metric--time{margin-top:10px}.metric--usage:first-child{margin-top:0}.metric-heading{display:flex;align-items:center;justify-content:space-between;gap:10px;min-width:0}.metric-title{font-size:14px;font-weight:550;overflow-wrap:anywhere;min-width:0}.metric-badge{flex:none;padding:2px 7px;border:1px solid var(--line);border-radius:6px;background:var(--surface);font-size:12px;color:var(--muted)}.metric-value{display:block;margin:3px 0 8px;font-size:40px;font-weight:650;line-height:1.2;letter-spacing:-1.5px;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}.metric-unit{margin-left:3px;font-size:22px;font-weight:450;letter-spacing:0;color:var(--muted)}
      [data-tone="healthy"]{--quota-color:var(--quota-healthy)}[data-tone="warning"]{--quota-color:var(--quota-warning)}[data-tone="critical"]{--quota-color:var(--quota-critical)}[data-tone="unknown"]{--quota-color:var(--muted)}
      .bar{height:6px;background:var(--line);border-radius:9px;overflow:hidden}.bar>div{height:100%;background:var(--quota-color,var(--accent));border-radius:inherit}.metric--usage .metric-value,.metric--usage .metric-unit{color:var(--quota-color)}.metric--usage[data-tone="warning"] .metric-badge,.metric--usage[data-tone="critical"] .metric-badge{color:var(--quota-color);border-color:currentColor}
      .reset-block{margin-top:10px;padding-top:8px;border-top:1px solid var(--line)}.reset-line{display:flex;align-items:flex-start;gap:6px;color:var(--muted);font-size:12px}.reset-line svg{width:13px;height:13px;margin-top:1px}.reset-date{display:block;margin:3px 0 0 19px;color:var(--muted);font-size:12px;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}.metric--time .reset-block{padding-top:0;border-top:0;margin-top:8px}.metric--time .reset-line{font-size:14px;color:var(--ink)}
      .stat-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-top:10px}.stat-grid:first-child{margin-top:0}.metric--count{background:var(--surface)}.metric--count .metric-title{font-size:13px;color:var(--muted);font-weight:450}.metric-amount{display:flex;flex-direction:column;align-items:flex-start;gap:2px;margin-top:9px}.metric-amount .metric-value{font-size:28px;letter-spacing:-.8px;margin:0}.metric-caption{font-size:12px;color:var(--muted);overflow-wrap:anywhere}.metric--reset{display:flex;align-items:center;justify-content:space-between;gap:12px;grid-column:1/-1;background:var(--purple-soft);border-color:transparent}.metric--reset .metric-heading{justify-content:flex-start;flex:1}.reset-mark{display:grid;place-items:center;flex:none;width:32px;height:36px;color:var(--purple);border-radius:9px;background:var(--surface)}.reset-mark svg{width:20px;height:20px}.metric--reset .metric-amount{margin:0;align-items:flex-end}.metric--reset .metric-value{font-size:31px;color:var(--purple)}.metric--reset .metric-caption{font-size:11px}.stale{opacity:.55}
      .hint{font-size:13px;line-height:1.7;color:var(--muted);margin:10px 2px 0;overflow-wrap:anywhere}.card-hint{display:flex;align-items:flex-start;gap:8px;padding:11px 12px;border-radius:12px;background:var(--surface-soft)}.card-hint svg{width:16px;height:16px;margin-top:2px}.card-hint strong{display:block;font-size:13px;font-weight:550;color:var(--ink)}.card-hint span{font-size:12px}
      .empty-state{text-align:center;padding:18px 12px 21px;border:1px dashed var(--line);border-radius:15px;background:var(--surface-soft)}.empty-mark{display:grid;place-items:center;margin:0 auto 12px;width:48px;height:48px;border:1px solid var(--line);border-radius:16px;color:var(--accent);background:var(--surface)}.empty-mark svg{width:25px;height:25px}.empty-title{font-size:16px;font-weight:600;margin:0 0 7px}.empty-description{margin:0;color:var(--muted);font-size:13px;line-height:1.9}.empty-steps{display:flex;justify-content:center;gap:8px;margin-top:16px}.empty-step{display:flex;align-items:center;gap:5px;color:var(--muted);font-size:12px}.step-number{display:grid;place-items:center;width:17px;height:17px;border-radius:50%;background:var(--surface);border:1px solid var(--line);font-size:11px;color:var(--accent)}
      details.excerpt{margin:14px 1px 0;padding-top:12px;border-top:1px solid var(--line)}summary{list-style:none;cursor:pointer;display:flex;align-items:center;gap:6px;font-size:12px;color:var(--muted);user-select:none}summary::-webkit-details-marker{display:none}summary svg{width:13px;height:13px}.excerpt-title{color:var(--ink);font-size:13px}.static-badge{padding:1px 5px;border:1px solid var(--line);border-radius:4px;font-size:11px}.excerpt-age{margin-left:auto;font-size:11px}.disclosure{transition:transform .2s}.excerpt[open] .disclosure{transform:rotate(180deg)}pre{margin:10px 0 0;padding:12px;border:1px solid var(--line);border-radius:10px;background:var(--surface-soft);color:var(--muted);white-space:pre-wrap;overflow-wrap:anywhere;font-family:inherit;font-size:13px;line-height:1.8;max-height:220px;overflow:auto}
      details.tools{padding:0 16px 12px;flex:none}details.tools>summary{display:none}.actions{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px;padding:7px;border:1px solid var(--line);border-radius:13px;background:var(--surface-soft)}.actions button{display:flex;flex-direction:column;align-items:center;gap:6px;font-size:12px;color:var(--muted);padding:9px 3px}.actions button:hover{background:var(--surface);color:var(--accent)}.actions button svg{width:17px;height:17px}.actions .danger:hover{color:var(--danger)}
      footer{flex:none;display:flex;align-items:flex-start;gap:7px;padding:8px 14px;border-top:1px solid var(--line);color:var(--muted);font-size:12px;line-height:1.6;overflow-wrap:anywhere}.footer-dot{margin-top:6px;background:var(--accent);opacity:.65}:host([data-state="warning"]) .footer-dot,:host([data-state="paused"]) .footer-dot{background:var(--warning)}:host([data-state="idle"]) .footer-dot{background:var(--muted)}

      a.icon-button{text-decoration:none;transition:background .16s,color .16s}a.icon-button:hover{background:var(--accent-soft);color:var(--accent)}a.icon-button:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
      .compact-summary{position:absolute;right:13px;bottom:55px;width:240px;max-width:calc(100% - 26px);display:flex;align-items:center;justify-content:space-between;gap:10px}.compact-slot{display:flex;align-items:center;gap:5px;min-width:0;white-space:nowrap}.compact-label{font-size:18px;line-height:24px;font-weight:600;color:#202124}:host([data-theme="dark"]) .compact-label{color:var(--ink)}.compact-slot strong{font-size:18px;line-height:24px;font-weight:650;letter-spacing:-.4px;font-variant-numeric:tabular-nums}.compact-slot[data-tone] strong{color:var(--quota-color)}.compact-slot--reset strong{color:var(--purple);max-width:48px;overflow:hidden;text-overflow:ellipsis}
      .page-source{flex:none;font-size:11px;padding:1px 5px;border:1px solid var(--line);border-radius:4px;color:var(--muted)}.read-only-note{font-size:12px;line-height:1.7;color:var(--muted);margin:11px 2px 0}
      :host([data-collapsed="true"]) header{display:none}
      :host([data-collapsed="true"]) .card{width:268px;border-radius:16px}:host([data-collapsed="true"]) .dock{height:96px;border-top:0}
      :host([data-collapsed="true"]) .card-surface{width:min(266px,calc(100vw - 18px));padding-bottom:96px}
      :host([data-collapsed="true"]) details.tools{padding-top:12px}

      @keyframes quota-spin{to{transform:rotate(360deg)}}@keyframes quota-pulse{50%{opacity:.35}}
      @media(max-width:380px){header{padding:12px;gap:6px}.brand{gap:8px}.brand-mark{width:31px;height:34px}.brand-title{font-size:15px}main{padding:0 12px 13px}.card{border-radius:19px}footer{padding:11px 14px}.metric{padding:13px}.metric-value{font-size:37px}}
      @media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}
      .refresh-setting{display:grid;gap:9px;margin-bottom:10px;padding:12px;border:1px solid var(--line);border-radius:13px;background:var(--surface-soft)}.interval-row{display:flex;align-items:center;gap:8px}.interval-row label{font-size:13px;white-space:nowrap}select,input{font:inherit;font-size:13px;color:var(--ink);background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:7px;min-width:0}select{flex:1;width:100%}input{width:100%}select:focus-visible,input:focus-visible{outline:2px solid var(--accent);outline-offset:2px}.custom-interval{display:grid;grid-template-columns:minmax(0,1fr) auto auto;align-items:center;gap:7px}.custom-interval span,.interval-hint{font-size:12px;color:var(--muted)}.custom-interval button{background:var(--accent-soft);color:var(--accent);font-size:13px}
`;
    const card = cardElement = el('section', undefined, 'card'); card.setAttribute('aria-label', 'ChatGPT 额度悬浮窗');
    const header = el('header'), tools = el('details', undefined, 'tools'); toolsPanel = tools;
    const toolsSummary = el('summary', '更多操作'), actions = el('div', undefined, 'actions');
    const clearButton = button('清除识别', () => { forgetEndpoints(); resetSession('', null, '识别结果已清除，请重新打开额度页'); menuOpen = false; render(); }, '清除本页接口、数据、摘录及凭据');
    clearButton.className = 'danger'; clearButton.prepend(icon('clear'));
    const downloadButton = button('下载诊断', diagnose, '下载白名单脱敏诊断'); downloadButton.prepend(icon('download'));
    const positionButton = button('重置位置', () => { delete saved.position; host.style.left = ''; host.style.top = ''; host.style.right = '18px'; host.style.bottom = '52px'; menuOpen = false; writeStore(); render(); }, '恢复右下角位置'); positionButton.prepend(icon('position'));
    actions.append(downloadButton, clearButton, positionButton);
    tools.id='local-quota-tools';tools.append(toolsSummary,refreshSettings(),actions); tools.hidden = true; tools.open = true;
    pauseButton = iconButton('pause', () => { writeStore({autoRefresh:!saved.autoRefresh}); notice = ''; render(); if (saved.autoRefresh) refresh(); }, '暂停自动刷新');
    collapseButton = iconButton('minus', toggleCollapsed, '收起额度详情');
    refreshButton = iconButton('refresh', () => refresh(true), '刷新已识别的额度');
    moreButton = iconButton('more', () => { menuOpen = !menuOpen; render(); clampPosition(); }, '更多操作');
    moreButton.dataset.menu = 'true';
    moreButton.setAttribute('aria-controls',tools.id);
    const brand = el('div', undefined, 'brand'), brandMark = el('span', undefined, 'brand-mark'); brandMark.append(icon('gauge'));
    const brandCopy = el('div', undefined, 'brand-copy'), brandStatus = el('div', undefined, 'brand-status');
    statusLabel = el('span', '等待识别'); brandStatus.append(el('span', undefined, 'status-dot'), statusLabel);
    brandCopy.append(el('strong', '额度概览', 'brand-title'), brandStatus); brand.append(brandMark, brandCopy);
    const usageLink=el('a',undefined,'icon-button usage-link');usageLink.href=USAGE_PAGE;
    usageLink.title='打开官方额度页';usageLink.setAttribute('aria-label','打开官方额度页');usageLink.append(icon('external'));
    compactSummary=el('div',undefined,'compact-summary');
    for(const [label,key] of [['5h','fiveHour'],['周','weekly'],['','resets']]) {
      const item=el('div',undefined,'compact-slot'),value=el('strong','—');
      if(label)item.append(el('span',label,'compact-label'));
      item.append(value);compactSummary.append(item);
      if(key==='fiveHour')compactFive=value;else if(key==='weekly')compactWeek=value;else {
        compactReset=value;item.classList.add('compact-slot--reset');item.setAttribute('role','group');item.setAttribute('aria-label','可用 Reset 次数');
      }
    }
    const controls = el('div', undefined, 'controls'); controls.append(refreshButton, pauseButton, moreButton, usageLink, collapseButton);
    controls.setAttribute('role','group');controls.setAttribute('aria-label','额度操作');
    const dock=el('div',undefined,'dock'),dockStatus=el('div',undefined,'dock-status');dockLabel=el('span');
    dockStatus.append(el('span',undefined,'status-dot'),dockLabel);dock.append(compactSummary,dockStatus,controls);
    header.append(brand);
    body = el('main'); footer = el('footer'); dataBox = el('div');
    body.id='local-quota-details';collapseButton.setAttribute('aria-controls',body.id);
    footerText = el('span'); footer.append(el('span', undefined, 'footer-dot'), footerText);
    emptyHint = el('div', undefined, 'empty-state');
    const emptyMark = el('div', undefined, 'empty-mark'); emptyMark.append(icon('scan'));
    const steps = el('div', undefined, 'empty-steps');
    for (const [index, text] of ['打开额度页', '等待加载'].entries()) {
      const step = el('span', undefined, 'empty-step'); step.append(el('span', String(index + 1), 'step-number'), el('span', text)); steps.append(step);
    }
    emptyHint.append(emptyMark, el('p', '还未识别额度', 'empty-title'), el('p', '打开设置中的额度页，加载完成后\n就能在这里随时查看。', 'empty-description'), steps);
    cardHint = el('div', undefined, 'hint card-hint');
    const hintCopy = el('div'); hintCopy.append(el('strong', 'Reset 次数未识别'), el('span', '打开官方额度页，读取 Reset 区域的 Available / 可用次数'));
    cardHint.append(icon('reset'), hintCopy); overflowHint = el('p', '', 'hint');
    excerpt = el('details', undefined, 'excerpt'); excerptSummary = el('summary'); excerptText = el('pre');
    excerptAge = el('span', '', 'excerpt-age'); const disclosure = icon('chevron'); disclosure.classList.add('disclosure');
    excerptSummary.append(icon('note'), el('span', '页面摘录', 'excerpt-title'), el('span', '静态', 'static-badge'), excerptAge, disclosure);
    excerpt.append(excerptSummary, excerptText); body.append(emptyHint, dataBox, cardHint, el('p','Reset 仅显示次数；请到官方额度页手动重置。','read-only-note'), overflowHint, excerpt);
    surfaceElement=el('div',undefined,'card-surface');surfaceElement.append(header,tools,body,footer);
    card.append(surfaceElement,dock); shadow.append(style, card); document.body.append(host);
    syncTheme(); renderedSignature = ''; rowRefs = []; render();
    if (saved.position) place(saved.position.x, saved.position.y);
    let drag = null;
    const startDrag = e => {
      if (e.target.closest('button,a') || e.button !== 0) return;
      finishMorph();
      const r = host.getBoundingClientRect(); drag = { id: e.pointerId, dx: e.clientX - r.left, dy: e.clientY - r.top };
      e.currentTarget.setPointerCapture(e.pointerId);
    };
    const moveDrag = e => { if (drag?.id === e.pointerId) place(e.clientX - drag.dx, e.clientY - drag.dy); };
    const end = e => {
      if (!drag || drag.id !== e.pointerId) return;
      drag = null; const r = host.getBoundingClientRect(); saved.position = { x: r.left, y: r.top }; writeStore();
    };
    for(const handle of [header,dock]) {
      handle.addEventListener('pointerdown',startDrag);handle.addEventListener('pointermove',moveDrag);
      for(const name of ['pointerup','pointercancel','lostpointercapture'])handle.addEventListener(name,end);
    }
    if (typeof ResizeObserver !== 'undefined') { sizeObserver = new ResizeObserver(clampPosition); sizeObserver.observe(host); }
  }
  function init() {
    mount(); discoverDialogs();
    themeObserver = new MutationObserver(syncTheme);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] });
    window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', syncTheme);
    // Structural discovery only; text/attribute observation is dialog-scoped.
    rootObserver = new MutationObserver(records => {
      let changed = false;
      for (const record of records) {
        if (record.type === 'attributes' && record.target.matches?.('[role="dialog"],dialog')) changed = true;
        for (const n of [...record.addedNodes, ...record.removedNodes]) {
          if (n.nodeType === 1 && (n.matches?.('[role="dialog"],dialog') || n.querySelector?.('[role="dialog"],dialog'))) changed = true;
        }
      }
      if (!host?.isConnected) mount();
      if (location.href !== lastDOMRoute) { lastDOMRoute=location.href; changed=true; }
      if (usageRoute() && records.some(r=>[...r.addedNodes].some(n=>n.nodeType===1&&(n.matches?.('main,[role=main]')||n.querySelector?.('main,[role=main]'))))) changed=true;
      if (changed) discoverDialogs();
    });
    rootObserver.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['role', 'open'] });
    setInterval(() => { if (!document.hidden) { mount(); if(location.href!==lastDOMRoute){lastDOMRoute=location.href;discoverDialogs();} if(usageRoute())captureDOM(); render(); refresh(); } }, 15000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { discoverDialogs(); render(); refresh(); } });
    window.addEventListener('storage', event => {
      if(event.storageArea!==localStorage||(event.key!==STORE&&event.key!==null))return;
      const wasPaused=!saved.autoRefresh;
      applyRefreshPreferences(readStore());notice='';scheduleRender();
      if(wasPaused&&saved.autoRefresh)refresh();
    });
    window.addEventListener('online', () => { notice = ''; refresh(); scheduleRender(); });
    window.addEventListener('offline', () => { notice = '网络离线，显示上次识别的数据'; scheduleRender(); });
    window.addEventListener('resize', () => {finishMorph();clampPosition();});
    window.matchMedia?.('(prefers-reduced-motion: reduce)').addEventListener?.('change',()=>{finishMorph();clampPosition();});
    window.addEventListener('pagehide', () => {cancelRun();finishMorph();});
    window.addEventListener('pageshow', () => { mount(); discoverDialogs(); scheduleRender(); });
    captureDOM();
  }
  writeStore();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();

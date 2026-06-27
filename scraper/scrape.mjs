#!/usr/bin/env node
// Gimy 影劇資料爬蟲
// -----------------------------------------------------------------------------
// 從 Gimy (劇迷) 的 maccms (蘋果 CMS) JSON 採集介面抓取「最新更新」的影劇資料，
// 整理成前端可以直接讀取的 data/videos.json。
//
// 設計重點:
//  - 多個鏡像網域 + 多種 API 路徑做容錯 (Gimy 常換網域 / 被 Cloudflare 擋)。
//  - 優先用 maccms JSON 介面 (ac=detail 可取得集數播放清單)。
//  - 取得失敗時「不覆蓋」既有的 data/videos.json，保留上一份成功資料。
//  - 全程 console 詳細記錄，方便在 GitHub Actions log 追查。
//
// 執行: node scraper/scrape.mjs
// -----------------------------------------------------------------------------

import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DATA_DIR = resolve(ROOT, 'data');
const OUT_VIDEOS = resolve(DATA_DIR, 'videos.json');
const OUT_META = resolve(DATA_DIR, 'meta.json');

// 候選鏡像網域 (依序嘗試，第一個成功就用)。Gimy 換域名很頻繁，多放幾個比較保險。
const HOSTS = (process.env.GIMY_HOSTS || [
  'https://gimyai.tw',
  'https://gimytv.biz',
  'https://gimytw.cc',
  'https://gimytv.app',
  'https://gimytv.com',
  'https://gimy.tv',
].join(',')).split(',').map((s) => s.trim()).filter(Boolean);

// maccms 採集介面常見路徑
const API_PATHS = [
  '/api.php/provide/vod/',
  '/api.php/provide/vod',
  '/inc/api.php',
];

// 要抓的分類 (type_id 來自 Gimy 的 /genre/N.html)。0 = 全部最新。
// 我們抓「全部最新」再加上幾個主要分類，確保各類型都有近期資料。
const CATEGORIES = [
  { t: 0, name: '全部' },
  { t: 1, name: '電影' },
  { t: 2, name: '電視劇' },
  { t: 3, name: '綜藝' },
  { t: 4, name: '動漫' },
];

const PAGES_PER_CATEGORY = Number(process.env.GIMY_PAGES || 6); // 每分類抓幾頁
const REQUEST_TIMEOUT_MS = 20000;
const MAX_TITLES = Number(process.env.GIMY_MAX || 1200); // 上限，避免資料檔過大

const UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 13_2_3 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/13.0.3 Mobile/15E148 Safari/604.1';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        Accept: 'application/json, text/javascript, */*; q=0.01',
        'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8',
        Referer: new URL(url).origin + '/',
      },
      redirect: 'follow',
      signal: ctrl.signal,
    });
    if (!res.ok) {
      return { ok: false, status: res.status };
    }
    const text = await res.text();
    try {
      return { ok: true, data: JSON.parse(text) };
    } catch {
      // 有些站會回傳 JSONP 或前後有雜訊，嘗試擷取 { ... }
      const m = text.match(/\{[\s\S]*\}/);
      if (m) {
        try {
          return { ok: true, data: JSON.parse(m[0]) };
        } catch {
          /* ignore */
        }
      }
      const snippet = text.replace(/\s+/g, ' ').slice(0, 160);
      return { ok: false, status: 'parse_error', snippet };
    }
  } catch (err) {
    return { ok: false, status: err.name === 'AbortError' ? 'timeout' : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

// 取回純文字 (HTML) 內容
async function fetchText(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
        'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8',
        Referer: new URL(url).origin + '/',
      },
      redirect: 'follow',
      signal: ctrl.signal,
    });
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true, text: await res.text() };
  } catch (err) {
    return { ok: false, status: err.name === 'AbortError' ? 'timeout' : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

// 找出能用的 host + api path + ac 組合 (用第一頁試水溫)
// ac=detail 可取得集數播放清單；若站台只支援 ac=list 則退而求其次 (無 playUrl/集數)。
async function discoverEndpoint() {
  for (const host of HOSTS) {
    for (const path of API_PATHS) {
      for (const ac of ['detail', 'list']) {
        const testUrl = `${host}${path}?ac=${ac}&pg=1`;
        process.stdout.write(`探測介面: ${testUrl} ... `);
        const r = await fetchJson(testUrl);
        if (r.ok && r.data && Array.isArray(r.data.list) && r.data.list.length) {
          console.log('OK ✅');
          return { host, path, ac, classes: r.data.class || [] };
        }
        console.log(`失敗 (${r.status || 'no list'})${r.snippet ? ' | ' + r.snippet : ''}`);
        await sleep(300);
      }
    }
  }
  return null;
}

// 從 vod_play_url 推算集數 (取第一個播放來源的片段數)
function countEpisodes(playUrl) {
  if (!playUrl || typeof playUrl !== 'string') return 0;
  const firstSource = playUrl.split('$$$')[0] || '';
  const segments = firstSource.split('#').filter((s) => s.includes('$'));
  return segments.length;
}

// 從 vod_play_url 取得最新一集的播放頁連結 (相對或絕對)
function latestPlayHref(playUrl) {
  if (!playUrl || typeof playUrl !== 'string') return '';
  const firstSource = playUrl.split('$$$')[0] || '';
  const segments = firstSource.split('#').filter((s) => s.includes('$'));
  if (!segments.length) return '';
  const last = segments[segments.length - 1];
  return (last.split('$')[1] || '').trim();
}

function normalize(item, host) {
  const id = String(item.vod_id ?? '').trim();
  if (!id) return null;
  const episodes = countEpisodes(item.vod_play_url);
  return {
    id,
    name: (item.vod_name || '').trim(),
    type: (item.type_name || '').trim(),
    area: (item.vod_area || '').trim(),
    year: (item.vod_year || '').toString().trim(),
    lang: (item.vod_lang || '').trim(),
    pic: (item.vod_pic || '').trim(),
    remarks: (item.vod_remarks || '').trim(), // 例如「更新至20集」「完結」
    episodes, // 解析出的集數 (0 = 無法解析)
    score: (item.vod_score || '').toString().trim(),
    actor: (item.vod_actor || '').trim(),
    director: (item.vod_director || '').trim(),
    content: stripHtml(item.vod_content || '').slice(0, 300),
    updateTime: (item.vod_time || '').trim(),
    detailUrl: `${host}/detail/${id}.html`,
    playUrl: buildPlayUrl(host, latestPlayHref(item.vod_play_url)),
  };
}

function buildPlayUrl(host, href) {
  if (!href) return '';
  if (/^https?:\/\//i.test(href)) return href;
  if (href.startsWith('/')) return host + href;
  return `${host}/${href}`;
}

function stripHtml(s) {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .trim();
}

// 從 remarks (如「更新至20集」「全40集」「第12集」) 推算集數
function episodesFromRemarks(remarks) {
  if (!remarks) return 0;
  const m = remarks.match(/(?:更新至|更新到|第|全)\s*(\d+)\s*集/);
  if (m) return Number(m[1]);
  if (/完结|完結/.test(remarks)) return 0; // 完結但未標集數
  return 0;
}

// 從 Gimy 的 HTML 列表頁解析影劇項目 (容錯式 regex，不綁定特定模板)
function parseListHtml(html, host, type) {
  const items = new Map();
  const linkRe = /href=["']([^"']*?\/(?:detail|voddetail|vod)\/(\d+)\.html)["']([^>]*)>/gi;
  let m;
  while ((m = linkRe.exec(html)) !== null) {
    const id = m[2];
    const inlineAttrs = m[3] || ''; // 同一個 <a> 標籤內 (href 之後) 的屬性
    // 只向「後」取窗格，並在下一個 /detail/ 連結前截斷，避免吃到相鄰項目的資料
    const afterHref = m.index + m[0].length;
    const nextIdx = html.indexOf('/detail/', afterHref);
    const end = nextIdx === -1 ? afterHref + 360 : Math.min(afterHref + 360, nextIdx);
    const win = m[0] + html.slice(afterHref, Math.max(afterHref, end));

    let title =
      (inlineAttrs.match(/title=["']([^"']+)["']/) || [])[1] ||
      (win.match(/title=["']([^"']+)["']/) || [])[1] ||
      '';
    title = decodeEntities(title);
    if (!title || title.length > 80) {
      const textM = win.match(new RegExp(`/${id}\\.html["'][^>]*>\\s*([^<]{1,60}?)\\s*<`));
      title = textM ? decodeEntities(textM[1]) : title;
    }
    if (!title) continue;

    let pic =
      (inlineAttrs.match(/(?:data-original|data-src|data-echo|data-lazy|src)=["']([^"']+?\.(?:jpg|jpeg|png|webp)[^"']*)["']/i) ||
        [])[1] ||
      (win.match(/(?:data-original|data-src|data-echo|data-lazy|src)=["']([^"']+?\.(?:jpg|jpeg|png|webp)[^"']*)["']/i) ||
        [])[1] ||
      '';
    if (pic.startsWith('//')) pic = 'https:' + pic;
    else if (pic.startsWith('/')) pic = host + pic;

    let remarks =
      (win.match(
        /<span[^>]*class=["'][^"']*(?:pic_text|pic-tag|note|deng|remarks|msg|tag|hdtype)[^"']*["'][^>]*>([^<]+)<\/span>/i
      ) || [])[1] ||
      (win.match(/(更新至\s*\d+\s*集|更新到\s*\d+\s*集|第\s*\d+\s*集|全\s*\d+\s*集|完结|完結|HD\w*|超清|高清|藍光|蓝光|搶先版|抢先版|\d{6,8}期|預告|预告|TC\w*|BD\w*|DVD)/) ||
        [])[1] ||
      '';
    remarks = decodeEntities(remarks).replace(/\s+/g, '');

    const prev = items.get(id) || {};
    items.set(id, {
      id,
      name: prev.name || title,
      pic: prev.pic || pic,
      remarks: prev.remarks || remarks,
      type: prev.type || type || '',
    });
  }
  return [...items.values()];
}

function normalizeHtmlItem(it, host) {
  return {
    id: it.id,
    name: it.name,
    type: it.type || '',
    area: '',
    year: '',
    lang: '',
    pic: it.pic || '',
    remarks: it.remarks || '',
    episodes: episodesFromRemarks(it.remarks),
    score: '',
    actor: '',
    director: '',
    content: '',
    updateTime: '',
    detailUrl: `${host}/detail/${it.id}.html`,
    playUrl: '',
  };
}

// HTML 列表頁路徑候選 (不同模板的分頁寫法)
function genrePageUrls(host, t, page) {
  if (page <= 1) return [`${host}/genre/${t}.html`, `${host}/show/${t}.html`, `${host}/vodtype/${t}.html`];
  return [
    `${host}/genre/${t}--------${page}---.html`,
    `${host}/show/${t}--------${page}---.html`,
    `${host}/genre/${t}-${page}.html`,
    `${host}/vodtype/${t}-${page}.html`,
  ];
}

// 用 HTML 模式抓取 (當 JSON 採集介面不可用時的後備方案)
async function scrapeViaHtml() {
  // 1) 找一個會回傳真實 Gimy HTML 的鏡像
  let host = null;
  let homeHtml = '';
  for (const h of HOSTS) {
    process.stdout.write(`HTML 模式探測: ${h}/ ... `);
    const r = await fetchText(`${h}/`);
    if (r.ok && /\/detail\/\d+\.html/.test(r.text) && /gimy/i.test(r.text)) {
      console.log('OK ✅');
      host = h;
      homeHtml = r.text;
      break;
    }
    console.log(`不可用 (${r.status || 'no detail links'})`);
    await sleep(300);
  }
  if (!host) return null;

  const byId = new Map();
  // 2) 首頁 (最近更新，順序即為最新)
  const homeItems = parseListHtml(homeHtml, host, '');
  console.log(`  首頁解析: ${homeItems.length} 筆`);
  if (homeItems.length) {
    console.log(`  範例: ${JSON.stringify(homeItems[0])}`);
  } else {
    // debug: 印出第一個 /detail/ 連結周邊的 HTML，協助調整解析器
    const di = homeHtml.search(/\/(?:detail|voddetail|vod)\/\d+/);
    if (di >= 0) {
      console.log('  [debug] /detail/ 周邊片段:', homeHtml.slice(Math.max(0, di - 300), di + 300).replace(/\s+/g, ' '));
    } else {
      console.log('  [debug] 全文找不到 /detail/ 連結。前 400 字:', homeHtml.replace(/\s+/g, ' ').slice(0, 400));
    }
  }
  homeItems.forEach((it) => byId.set(it.id, normalizeHtmlItem(it, host)));

  // 3) 各分類列表頁
  const HTML_CATS = [
    { t: 1, name: '電影' },
    { t: 2, name: '電視劇' },
    { t: 3, name: '綜藝' },
    { t: 4, name: '動漫' },
  ];
  for (const cat of HTML_CATS) {
    for (let page = 1; page <= PAGES_PER_CATEGORY; page++) {
      let got = 0;
      for (const url of genrePageUrls(host, cat.t, page)) {
        const r = await fetchText(url);
        if (!r.ok) continue;
        const items = parseListHtml(r.text, host, cat.name);
        if (items.length) {
          items.forEach((it) => {
            const v = normalizeHtmlItem(it, host);
            if (byId.has(v.id)) {
              // 補上分類
              const ex = byId.get(v.id);
              if (!ex.type) ex.type = cat.name;
            } else {
              byId.set(v.id, v);
            }
          });
          got = items.length;
          break; // 此 page 已用可用的 URL 模板取得
        }
      }
      console.log(`  [${cat.name} p${page}] +${got} (累計 ${byId.size})`);
      if (!got) break; // 此分類沒有更多頁
      await sleep(250);
    }
  }

  return { host, videos: [...byId.values()] };
}

async function fetchCategory(host, path, ac, t, pages) {
  const collected = [];
  for (let pg = 1; pg <= pages; pg++) {
    const url = `${host}${path}?ac=${ac}&pg=${pg}${t ? `&t=${t}` : ''}`;
    const r = await fetchJson(url);
    if (!r.ok || !r.data || !Array.isArray(r.data.list)) {
      console.log(`  [t=${t} pg=${pg}] 失敗 (${r.status})`);
      break;
    }
    const list = r.data.list;
    collected.push(...list);
    console.log(`  [t=${t} pg=${pg}] +${list.length} 筆 (累計 ${collected.length})`);
    if (pg >= (r.data.pagecount || pg)) break;
    await sleep(250);
  }
  return collected;
}

async function main() {
  console.log('=== Gimy 影劇爬蟲開始 ===');
  await mkdir(DATA_DIR, { recursive: true });

  let videos = [];
  let sourceHost = '';
  let mode = '';

  // 策略一：maccms JSON 採集介面 (有集數播放清單，資料最完整)
  const ep = await discoverEndpoint();
  if (ep) {
    console.log(`使用 JSON 介面: ${ep.host}${ep.path} (ac=${ep.ac})`);
    const byId = new Map();
    for (const cat of CATEGORIES) {
      console.log(`抓取分類: ${cat.name} (t=${cat.t})`);
      const raw = await fetchCategory(ep.host, ep.path, ep.ac, cat.t, PAGES_PER_CATEGORY);
      for (const item of raw) {
        const v = normalize(item, ep.host);
        if (v && v.name) byId.set(v.id, v);
      }
    }
    videos = [...byId.values()];
    videos.sort((a, b) => (b.updateTime || '').localeCompare(a.updateTime || ''));
    sourceHost = ep.host;
    mode = 'json';
  } else {
    // 策略二：直接解析 HTML 列表頁 (JSON 介面被關閉時的後備)
    console.log('JSON 介面不可用，改用 HTML 模式…');
    const html = await scrapeViaHtml();
    if (html && html.videos.length) {
      videos = html.videos; // 已是「最新在前」的順序
      sourceHost = html.host;
      mode = 'html';
    }
  }

  if (videos.length > MAX_TITLES) videos = videos.slice(0, MAX_TITLES);

  if (!videos.length) {
    console.error('❌ 所有來源皆失敗或抓到 0 筆，保留既有資料不覆蓋。');
    await touchMeta(false);
    process.exitCode = existsSync(OUT_VIDEOS) ? 0 : 1;
    return;
  }

  await writeFile(OUT_VIDEOS, JSON.stringify(videos, null, 0), 'utf8');
  await touchMeta(true, { count: videos.length, source: sourceHost, mode });
  console.log(`✅ 完成 (${mode}): 寫入 ${videos.length} 筆 → data/videos.json (來源 ${sourceHost})`);
}

async function touchMeta(success, extra = {}) {
  let prev = {};
  try {
    prev = JSON.parse(await readFile(OUT_META, 'utf8'));
  } catch {
    /* ignore */
  }
  const meta = {
    ...prev,
    lastRun: new Date().toISOString(),
    lastRunSuccess: success,
    ...(success ? { lastUpdated: new Date().toISOString(), ...extra } : {}),
  };
  await writeFile(OUT_META, JSON.stringify(meta, null, 2), 'utf8');
}

main().catch(async (err) => {
  console.error('未預期錯誤:', err);
  await touchMeta(false);
  process.exitCode = existsSync(OUT_VIDEOS) ? 0 : 1;
});

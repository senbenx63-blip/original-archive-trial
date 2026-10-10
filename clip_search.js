const SHEET_ID = '1yubpjM0sqNAjwRMCoiWDgdTeTrB8zZ2YyomA-z2fvVg';
const SHEET_NAME = 'シート2'; 
const CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(SHEET_NAME)}`;

const ITEMS_PER_PAGE = 100; 
const MAX_TOTAL_ITEMS = 1000;

// 字幕タブの設定
const T_MAX_RESULTS = 300;          // 字幕検索の最大表示件数
const T_PAGE_SIZE = 50;             // 「さらに表示」1回あたりの描画件数
const SUBTITLE_COL_FALLBACK = 10;   // 見出しから字幕列が見つからない場合の列番号(0始まり=K列)

// タグ一覧(スプレッドシートの「タグ」列に入る値)
const TAG_LIST = [
    '爆笑', '嬉しい', '怒り', '悲しい', 'びっくり', '困惑', '虚無', 'トーク',
    'ボケ', 'ツッコミ', '料理', 'DJ', '食事', 'コラボ', '大声', 'キモイ',
    '珍事', '皮肉', 'リスナー', 'じゅん', '下ネタ', 'エロ', 'ガチ恋', '地獄',
    '短い', '歌', 'ノリノリ', '集中', 'モノマネ', '罵倒', 'その他'
];
const TAG_KEYS = TAG_LIST.map(t => t.normalize('NFKC').toLowerCase());   // 並べ替え・照合用
const TAG_COL_FALLBACK = 8;         // 見出しから「タグ」列が見つからない場合の列番号(0始まり=I列)

let allData = [];      
let periodClips = [];  
let filteredClips = []; 
let currentPage = 1;
let searchedUserBlank = true;   // 検索時に作成者が空欄だったか
let searchedCatBlank = true;    // 検索時にカテゴリーが空欄だったか

let sortState = {
    key: 'views',
    time: 'none',
    views: 'desc'
};

const menuToggle = document.getElementById('menu-toggle');
const sidebar = document.getElementById('sidebar');
const overlay = document.getElementById('overlay');

menuToggle.addEventListener('click', () => {
    const isOpen = sidebar.classList.contains('open');
    if (isOpen) {
        sidebar.classList.remove('open');
        overlay.classList.remove('active');
    } else {
        sidebar.classList.add('open');
        overlay.classList.add('active');
    }
});

overlay.addEventListener('click', () => {
    sidebar.classList.remove('open');
    overlay.classList.remove('active');
});

// ===== タブ切り替え =====
function showTab(name) {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === 'tab-' + name));
    history.replaceState(null, '', name === 'transcript' ? '#transcript' : location.pathname + location.search);
}
document.querySelectorAll('.tab-btn').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));
if (location.hash === '#transcript') showTab('transcript');

// ===== CSVパーサー(セル内の改行・カンマ・"" に対応) =====
function parseCSV(text) {
    const rows = [];
    let row = [], field = '', inQuotes = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (inQuotes) {
            if (ch === '"') {
                if (text[i + 1] === '"') { field += '"'; i++; }
                else inQuotes = false;
            } else field += ch;
        } else {
            if (ch === '"') inQuotes = true;
            else if (ch === ',') { row.push(field); field = ''; }
            else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
            else if (ch !== '\r') field += ch;
        }
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows;
}

// 全角/半角・大文字/小文字の揺れを吸収
const norm = s => (s || '').normalize('NFKC').toLowerCase();

// カタカナをひらがなに統一(字幕検索でひらがな/カタカナを区別しないため。1文字→1文字の変換)
const kana = s => s.replace(/[\u30A1-\u30F6]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0x60));
const normK = s => kana(norm(s));

async function initData() {
    try {
        const response = await fetch(CSV_URL);
        const csvText = await response.text();
        const rows = parseCSV(csvText);
        const header = rows[0] || [];
        let subCol = header.findIndex(h => /transcript|字幕|文字起こし/i.test(h));
        let tagCol = header.findIndex(h => /^\s*(タグ|tags?)\s*$/i.test(h));
        if (tagCol < 0) tagCol = TAG_COL_FALLBACK;
        if (subCol < 0) subCol = SUBTITLE_COL_FALLBACK;

        allData = rows.slice(1).map(cols => {
            if (cols.length < 8) return null;
            const clean = cols.map(c => c.trim());
            const timeValue = new Date(clean[0].replace(/\//g, '-')).getTime();
            const subtitle = clean[subCol] || '';
            // タグ: 「#びっくり #大声」形式。#・カンマ・読点・スペース・改行・スラッシュ区切りに対応
            const tagsParsed = (clean[tagCol] || '').normalize('NFKC').split(/[#,、\/・\s]+/).filter(Boolean);
            // 表示順はタグ一覧(TAG_LIST)の順。一覧にないタグは末尾に元の順で並べ、重複は除く
            const tagOrder = t => { const i = TAG_KEYS.indexOf(t.toLowerCase()); return i < 0 ? TAG_KEYS.length : i; };
            const tagsRaw = [...new Set(tagsParsed)]
                .map((t, i) => ({ t, i }))
                .sort((a, b) => tagOrder(a.t) - tagOrder(b.t) || a.i - b.i)
                .map(x => x.t);
            const tags = tagsRaw.map(t => t.toLowerCase());
            
            return {
                dateTime: clean[0], time: timeValue, title: clean[1], t: norm(clean[1]),
                url: clean[2], thumb: clean[3], views: parseInt(clean[4]) || 0,
                creator: clean[5], category: clean[6], duration: clean[7],
                subtitle: subtitle, sub: normK(subtitle), tags: tags, tagsRaw: tagsRaw
            };
        }).filter(c => c !== null && !isNaN(c.time));

        // 検索前の作成者・カテゴリーの選択肢を全データから作成
        const allUsers = [...new Set(allData.map(c => c.creator).filter(Boolean))].sort();
        const allCats = [...new Set(allData.map(c => c.category).filter(Boolean))].sort();
        document.getElementById('sUser').innerHTML = '<option value="">指定しない</option>' + allUsers.map(u => `<option value="${esc(u)}">${esc(u)}</option>`).join('');
        document.getElementById('sCat').innerHTML = '<option value="">指定しない</option>' + allCats.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
    } catch (e) {
        document.getElementById('count').innerText = "データの読み込みに失敗しました。";
        document.getElementById('tStatus').innerText = "データの読み込みに失敗しました。";
    }
}

async function search() {
    await loading;
    const sd = document.getElementById('startDate').value;
    const st = document.getElementById('startTime').value;
    const ed = document.getElementById('endDate').value;
    const et = document.getElementById('endTime').value;

    const startLimit = sd ? new Date(`${sd}T${st}`).getTime() : 0;
    const endLimit = ed ? new Date(`${ed}T${et}`).getTime() : new Date().getTime();

    const titleTerms = norm(document.getElementById('sTitle').value.trim()).split(/[ \u3000]+/).filter(Boolean);

    const userVal = document.getElementById('sUser').value;
    const catVal = document.getElementById('sCat').value;
    // 検索前に「指定しない」だった項目は、検索後にフィルターで絞り込めるようにする
    searchedUserBlank = userVal === '';
    searchedCatBlank = catVal === '';

    // タグ(未選択ならタグでは絞り込まない)
    const tagMode = document.querySelector('input[name="tagMode"]:checked').value;
    const selTags = [...selectedTags].map(norm);

    periodClips = allData.filter(c =>
        c.time >= startLimit && c.time <= endLimit &&
        titleTerms.every(t => c.t.includes(t)) &&
        (userVal === '' || c.creator === userVal) &&
        (catVal === '' || c.category === catVal) &&
        (selTags.length === 0 ||
            (tagMode === 'and' ? selTags.every(t => c.tags.includes(t)) : selTags.some(t => c.tags.includes(t))))
    );
    
    sortState.key = 'views';
    sortState.views = 'desc';
    sortState.time = 'none';
    
    applySort(); 
    periodClips = periodClips.slice(0, MAX_TOTAL_ITEMS);

    if (periodClips.length === 0) {
        document.getElementById('count').innerText = "該当するクリップは見つかりませんでした。";
        document.getElementById('clipGrid').innerHTML = "";
        document.getElementById('sub-filter-area').style.display = 'none';
        document.getElementById('sortBar').style.display = 'none';
        document.getElementById('top-pagination').style.display = 'none';
        document.getElementById('bottom-pagination').style.display = 'none';
        return;
    }

    updateFilterMenus();
    document.getElementById('sub-filter-area').style.display = (searchedUserBlank || searchedCatBlank) ? 'flex' : 'none';
    document.getElementById('sortBar').style.display = 'flex';
    updateSortIcons();
    applyFilters();
}

function applySort() {
    if (sortState.key === 'time') {
        periodClips.sort((a, b) => sortState.time === 'desc' ? b.time - a.time : a.time - b.time);
    } else {
        periodClips.sort((a, b) => sortState.views === 'desc' ? b.views - a.views : a.views - b.views);
    }
}

function updateSortIcons() {
    const iTime = document.getElementById('iconTime');
    const iViews = document.getElementById('iconViews');
    
    if (sortState.time === 'desc') iTime.innerHTML = '<span class="icon-up">▲</span>';
    else if (sortState.time === 'asc') iTime.innerHTML = '<span class="icon-down">▼</span>';
    else iTime.innerHTML = 'ー';

    if (sortState.views === 'desc') iViews.innerHTML = '<span class="icon-up">▲</span>';
    else if (sortState.views === 'asc') iViews.innerHTML = '<span class="icon-down">▼</span>';
    else iViews.innerHTML = 'ー';
}

function updateFilterMenus() {
    const uSel = document.getElementById('fUser');
    const cSel = document.getElementById('fCat');
    const users = [...new Set(periodClips.map(c => c.creator))].sort();
    const cats = [...new Set(periodClips.map(c => c.category))].sort();
    uSel.innerHTML = '<option value="">すべて</option>' + users.map(u => `<option value="${esc(u)}">${esc(u)}</option>`).join('');
    cSel.innerHTML = '<option value="">すべて</option>' + cats.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
    // 空欄だった項目のフィルターだけ表示する(入力済みの項目は非表示・「すべて」のまま)
    document.getElementById('fUserGroup').style.display = searchedUserBlank ? '' : 'none';
    document.getElementById('fCatGroup').style.display = searchedCatBlank ? '' : 'none';
}

function applyFilters() {
    const uVal = document.getElementById('fUser').value;
    const cVal = document.getElementById('fCat').value;

    filteredClips = periodClips.filter(c => {
        return (uVal === "" || c.creator === uVal) &&
               (cVal === "" || c.category === cVal);
    });

    currentPage = 1;
    render();
}

function render() {
    const grid = document.getElementById('clipGrid');
    const start = (currentPage - 1) * ITEMS_PER_PAGE;
    const items = filteredClips.slice(start, start + ITEMS_PER_PAGE);
    const totalPages = Math.ceil(filteredClips.length / ITEMS_PER_PAGE) || 1;

    document.getElementById('count').innerText = `${filteredClips.length}件ヒット`;

    grid.innerHTML = items.map(c => `
        <div class="clip-card" onclick="window.open('${c.url}', '_blank')">
            <div class="thumb-box">
                <img src="${c.thumb}" class="thumb" loading="lazy">
                <span class="duration-tag">${c.duration}s</span>
            </div>
            <div class="info">
                <div class="title">${c.title}</div>
                <div class="meta">
                    <span class="meta-label">📅</span>${c.dateTime}<br>
                    <span class="meta-label">👁️</span>${c.views.toLocaleString()} views<br>
                    <span class="meta-label">👤</span>${c.creator}<br>
                    <span class="meta-label">🎮</span>${c.category}
                </div>
                ${tagsHtml(c)}
            </div>
        </div>
    `).join('');

    updatePaginationUI(totalPages);
}

function updatePaginationUI(totalPages) {
    const topPag = document.getElementById('top-pagination');
    const bottomPag = document.getElementById('bottom-pagination');

    if (totalPages > 1) {
        const html = `
            <button onclick="goToPage(1)" ${currentPage === 1 ? 'disabled' : ''}>最前尾</button>
            <button onclick="changePage(-1)" ${currentPage === 1 ? 'disabled' : ''}>前へ</button>
            <span class="page-info">${currentPage} / ${totalPages}</span>
            <button onclick="changePage(1)" ${currentPage === totalPages ? 'disabled' : ''}>次へ</button>
            <button onclick="goToPage(${totalPages})" ${currentPage === totalPages ? 'disabled' : ''}>最後尾</button>
        `;
        topPag.innerHTML = html;
        bottomPag.innerHTML = html;
        topPag.style.display = 'flex';
        bottomPag.style.display = 'flex';
    } else {
        topPag.style.display = 'none';
        bottomPag.style.display = 'none';
    }
}

function changePage(step) {
    currentPage += step;
    window.scrollTo(0, 0);
    render();
}

function goToPage(page) {
    currentPage = page;
    window.scrollTo(0, 0);
    render();
}

document.getElementById('sortTime').addEventListener('click', () => {
    sortState.key = 'time';
    sortState.views = 'none';
    if (sortState.time === 'desc') sortState.time = 'asc';
    else sortState.time = 'desc';
    applySort();
    updateSortIcons();
    applyFilters();
});

document.getElementById('sortViews').addEventListener('click', () => {
    sortState.key = 'views';
    sortState.time = 'none';
    if (sortState.views === 'desc') sortState.views = 'asc';
    else sortState.views = 'desc';
    applySort();
    updateSortIcons();
    applyFilters();
});

document.getElementById('execute-search').addEventListener('click', search);
// ===== タグ選択(チップ) =====
const selectedTags = new Set();
const tagChipsEl = document.getElementById('tagChips');
tagChipsEl.innerHTML = TAG_LIST.map(t => `<button type="button" class="tag-chip" data-tag="${t}">${t}</button>`).join('');

function updateTagSummary() {
    const n = selectedTags.size;
    document.getElementById('tagSummary').textContent =
        n === 0 ? '🏷️ タグで絞り込む(未選択)' : `🏷️ タグで絞り込む(${n}件選択中: ${[...selectedTags].join('・')})`;
}
tagChipsEl.addEventListener('click', e => {
    const btn = e.target.closest('.tag-chip');
    if (!btn) return;
    const t = btn.dataset.tag;
    if (selectedTags.has(t)) selectedTags.delete(t); else selectedTags.add(t);
    btn.classList.toggle('selected', selectedTags.has(t));
    updateTagSummary();
});
document.getElementById('tagClear').addEventListener('click', () => {
    selectedTags.clear();
    tagChipsEl.querySelectorAll('.tag-chip').forEach(b => b.classList.remove('selected'));
    updateTagSummary();
});

// ===== 検索条件をすべてクリア =====
document.getElementById('clear-all').addEventListener('click', () => {
    document.getElementById('sTitle').value = '';
    document.getElementById('sUser').value = '';
    document.getElementById('sCat').value = '';
    document.getElementById('startDate').value = '';
    document.getElementById('startTime').value = '00:00';
    document.getElementById('endDate').value = '';
    document.getElementById('endTime').value = '23:59';
    document.getElementById('tagClear').click();   // タグ選択も解除
    document.querySelector('input[name="tagMode"][value="or"]').checked = true;
});

document.getElementById('sTitle').addEventListener('keydown', e => { if (e.key === 'Enter') search(); });
document.getElementById('fUser').addEventListener('change', applyFilters);
document.getElementById('fCat').addEventListener('change', applyFilters);

// ===== 字幕タブ =====
let tHits = [];
let tShown = 0;
let tTerms = [];

const esc = s => String(s ?? '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));

// 結果カードに表示するタグ
function tagsHtml(c) {
    if (!c.tagsRaw || c.tagsRaw.length === 0) return '';
    return `<div class="card-tags">${c.tagsRaw.map(t => `<span class="card-tag">#${esc(t)}</span>`).join('')}</div>`;
}

function fmtDuration(sec) {
    sec = Math.floor(Number(sec) || 0);
    return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

// 全角半角・大文字小文字の揺れを吸収したまま、元の文字列上でヒット箇所を強調する
function highlight(text, terms) {
    if (!terms.length) return esc(text);
    let n = '', map = [];
    for (let i = 0; i < text.length; i++) {
        const t = kana(text[i].normalize('NFKC').toLowerCase());
        for (let k = 0; k < t.length; k++) { n += t[k]; map.push(i); }
    }
    const mark = new Array(text.length).fill(false);
    for (const term of terms) {
        let p = 0;
        while ((p = n.indexOf(term, p)) !== -1) {
            for (let k = p; k < p + term.length; k++) mark[map[k]] = true;
            p += term.length;
        }
    }
    let out = '', i = 0;
    while (i < text.length) {
        let j = i;
        while (j < text.length && mark[j] === mark[i]) j++;
        const seg = esc(text.slice(i, j));
        out += mark[i] ? `<mark>${seg}</mark>` : seg;
        i = j;
    }
    return out;
}

function transcriptCardHtml(c) {
    // 項目ごとにspanで包む(PCでは従来どおり「作成日時: … ・ 作成者: …」の1行。スマホではCSSでアイコン付きの表示に切り替える)
    const sub = [];
    const addSub = (cls, label, value) => sub.push(`<span class="rs-item rs-${cls}"><span class="rs-label">${label}</span>${value}</span>`);
    if (c.dateTime) addSub('date', '作成日時: ', esc(c.dateTime));
    if (c.creator) addSub('user', '作成者: ', esc(c.creator));
    if (c.category) addSub('cat', 'カテゴリー: ', esc(c.category));
    if (c.duration) addSub('dur', '長さ: ', fmtDuration(c.duration));
    addSub('view', '再生数: ', c.views.toLocaleString());
    const link = c.url ? `<a href="${esc(c.url)}" class="result-link" target="_blank" rel="noopener">▶ クリップを見る</a>` : '';
    const thumb = c.thumb
        ? `<a href="${esc(c.url)}" class="result-thumb" target="_blank" rel="noopener"><img src="${esc(c.thumb)}" loading="lazy" alt=""></a>`
        : '';
    return `<div class="result-card">
        <div class="result-main">
            <div class="result-meta">
                <span class="result-title">${esc(c.title)}</span>
            </div>
            <div class="result-sub">${sub.join('<span class="rs-sep"> ・ </span>')}</div>
            ${tagsHtml(c)}
            <div class="result-body-wrap">
                <span class="badge">字幕</span>
                <div class="result-body">${highlight(c.subtitle, tTerms)}</div>
            </div>
            ${link}
        </div>
        ${thumb}
    </div>`;
}

function renderMoreTranscripts() {
    const next = tHits.slice(tShown, tShown + T_PAGE_SIZE);
    document.getElementById('tResults').insertAdjacentHTML('beforeend', next.map(transcriptCardHtml).join(''));
    tShown += next.length;
    document.getElementById('tMore').style.display = tShown < tHits.length ? 'block' : 'none';
}

let tAll = [];      // 検索ワードでヒットした全件(フィルター前)
let tLabel = '';

// 検索ワードで検索 → フィルターの選択肢を作って表示
async function transcriptSearch() {
    await loading;
    const q = document.getElementById('tQuery').value;
    tTerms = normK(q).split(/[ \u3000]+/).filter(Boolean);

    tAll = allData
        .filter(c => c.sub !== '' && tTerms.every(t => c.sub.includes(t)))
        .sort((a, b) => b.time - a.time);
    tLabel = q.trim() ? `「${q.trim()}」の検索結果` : '一覧';

    const area = document.getElementById('t-filter-area');
    if (tAll.length === 0) {
        area.style.display = 'none';
        document.getElementById('tResults').innerHTML = '';
        document.getElementById('tMore').style.display = 'none';
        document.getElementById('tStatus').textContent = '該当するクリップは見つかりませんでした。';
        return;
    }

    const users = [...new Set(tAll.map(c => c.creator).filter(Boolean))].sort();
    const cats = [...new Set(tAll.map(c => c.category).filter(Boolean))].sort();
    document.getElementById('tFUser').innerHTML = '<option value="">すべて</option>' + users.map(u => `<option value="${esc(u)}">${esc(u)}</option>`).join('');
    document.getElementById('tFCat').innerHTML = '<option value="">すべて</option>' + cats.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
    area.style.display = 'flex';

    applyTranscriptFilters();
}

// 作成者・カテゴリーで絞り込んで表示
function applyTranscriptFilters() {
    const u = document.getElementById('tFUser').value;
    const cat = document.getElementById('tFCat').value;
    const all = tAll.filter(c => (!u || c.creator === u) && (!cat || c.category === cat));

    tHits = all.slice(0, T_MAX_RESULTS);
    tShown = 0;
    document.getElementById('tResults').innerHTML = '';
    const status = document.getElementById('tStatus');
    if (all.length === 0) {
        status.textContent = '該当するクリップは見つかりませんでした。';
        document.getElementById('tMore').style.display = 'none';
        return;
    }
    status.textContent = all.length > T_MAX_RESULTS
        ? `${tLabel}: ${all.length}件ヒット(新しい順に上位${T_MAX_RESULTS}件を表示)`
        : `${tLabel}: ${all.length}件ヒット`;
    renderMoreTranscripts();
}

document.getElementById('tSearchBtn').addEventListener('click', transcriptSearch);
document.getElementById('tMore').addEventListener('click', renderMoreTranscripts);
document.getElementById('tFUser').addEventListener('change', applyTranscriptFilters);
document.getElementById('tFCat').addEventListener('change', applyTranscriptFilters);
document.getElementById('tQuery').addEventListener('keydown', e => { if (e.key === 'Enter') transcriptSearch(); });

const loading = initData();
const SHEET_ID = '1yubpjM0sqNAjwRMCoiWDgdTeTrB8zZ2YyomA-z2fvVg';
const SHEET_NAME = 'シート2'; 
const CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(SHEET_NAME)}`;

const ITEMS_PER_PAGE = 100; 
const MAX_TOTAL_ITEMS = 1000;

// 字幕タブの設定
const T_MAX_RESULTS = 300;          // 字幕検索の最大表示件数
const T_PAGE_SIZE = 50;             // 「さらに表示」1回あたりの描画件数
const SUBTITLE_COL_FALLBACK = 8;    // 見出しから字幕列が見つからない場合の列番号(0始まり=9列目)

let allData = [];      
let periodClips = [];  
let filteredClips = []; 
let currentPage = 1;

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

async function initData() {
    try {
        const response = await fetch(CSV_URL);
        const csvText = await response.text();
        const rows = parseCSV(csvText);
        const header = rows[0] || [];
        let subCol = header.findIndex(h => /transcript|字幕|文字起こし/i.test(h));
        if (subCol < 0) subCol = SUBTITLE_COL_FALLBACK;

        allData = rows.slice(1).map(cols => {
            if (cols.length < 8) return null;
            const clean = cols.map(c => c.trim());
            const timeValue = new Date(clean[0].replace(/\//g, '-')).getTime();
            const subtitle = clean[subCol] || '';
            
            return {
                dateTime: clean[0], time: timeValue, title: clean[1],
                url: clean[2], thumb: clean[3], views: parseInt(clean[4]) || 0,
                creator: clean[5], category: clean[6], duration: clean[7],
                subtitle: subtitle, sub: norm(subtitle)
            };
        }).filter(c => c !== null && !isNaN(c.time));
    } catch (e) {
        document.getElementById('count').innerText = "データの読み込みに失敗しました。";
        document.getElementById('tStatus').innerText = "データの読み込みに失敗しました。";
    }
}

function search() {
    const sd = document.getElementById('startDate').value;
    const st = document.getElementById('startTime').value;
    const ed = document.getElementById('endDate').value;
    const et = document.getElementById('endTime').value;

    const startLimit = sd ? new Date(`${sd}T${st}`).getTime() : 0;
    const endLimit = ed ? new Date(`${ed}T${et}`).getTime() : new Date().getTime();

    periodClips = allData.filter(c => c.time >= startLimit && c.time <= endLimit);
    
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
    document.getElementById('sub-filter-area').style.display = 'flex';
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
    uSel.innerHTML = '<option value="">すべて</option>' + users.map(u => `<option value="${u}">${u}</option>`).join('');
    cSel.innerHTML = '<option value="">すべて</option>' + cats.map(c => `<option value="${c}">${c}</option>`).join('');
}

function applyFilters() {
    const tVal = document.getElementById('fTitle').value.toLowerCase();
    const uVal = document.getElementById('fUser').value;
    const cVal = document.getElementById('fCat').value;

    filteredClips = periodClips.filter(c => {
        return c.title.toLowerCase().includes(tVal) &&
               (uVal === "" || c.creator === uVal) &&
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
document.getElementById('fTitle').addEventListener('input', applyFilters);
document.getElementById('fUser').addEventListener('change', applyFilters);
document.getElementById('fCat').addEventListener('change', applyFilters);

// ===== 字幕タブ =====
let tHits = [];
let tShown = 0;
let tTerms = [];

const esc = s => String(s ?? '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));

function fmtDuration(sec) {
    sec = Math.floor(Number(sec) || 0);
    return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

// 全角半角・大文字小文字の揺れを吸収したまま、元の文字列上でヒット箇所を強調する
function highlight(text, terms) {
    if (!terms.length) return esc(text);
    let n = '', map = [];
    for (let i = 0; i < text.length; i++) {
        const t = text[i].normalize('NFKC').toLowerCase();
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
    const sub = [];
    if (c.creator) sub.push('作成者: ' + esc(c.creator));
    if (c.category) sub.push('カテゴリー: ' + esc(c.category));
    if (c.duration) sub.push('長さ: ' + fmtDuration(c.duration));
    sub.push('再生数: ' + c.views.toLocaleString());
    const link = c.url ? `<a href="${esc(c.url)}" class="result-link" target="_blank" rel="noopener">▶ クリップを見る</a>` : '';
    return `<div class="result-card">
        <div class="result-meta">
            <div class="result-meta-left"><span class="badge">字幕</span><span class="result-title">${esc(c.title)}</span></div>
            <div class="result-side">${esc(c.dateTime)}</div>
        </div>
        <div class="result-sub">${sub.join(' ・ ')}</div>
        <div class="result-body">${highlight(c.subtitle, tTerms)}</div>
        ${link}
    </div>`;
}

function renderMoreTranscripts() {
    const next = tHits.slice(tShown, tShown + T_PAGE_SIZE);
    document.getElementById('tResults').insertAdjacentHTML('beforeend', next.map(transcriptCardHtml).join(''));
    tShown += next.length;
    document.getElementById('tMore').style.display = tShown < tHits.length ? 'block' : 'none';
}

async function transcriptSearch() {
    await loading;
    const q = document.getElementById('tQuery').value;
    const sd = document.getElementById('tStart').value;
    const ed = document.getElementById('tEnd').value;
    const creator = norm(document.getElementById('tCreator').value.trim());
    const category = norm(document.getElementById('tCategory').value.trim());

    tTerms = norm(q).split(/[ \u3000]+/).filter(Boolean);
    const start = sd ? new Date(`${sd}T00:00:00`).getTime() : 0;
    const end = ed ? new Date(`${ed}T23:59:59`).getTime() : Infinity;

    const all = allData.filter(c =>
        c.sub !== '' &&                                   // 字幕のあるクリップだけ
        c.time >= start && c.time <= end &&
        tTerms.every(t => c.sub.includes(t)) &&
        (!creator || norm(c.creator).includes(creator)) &&
        (!category || norm(c.category).includes(category))
    ).sort((a, b) => b.time - a.time);

    tHits = all.slice(0, T_MAX_RESULTS);
    tShown = 0;
    document.getElementById('tResults').innerHTML = '';
    const status = document.getElementById('tStatus');
    if (all.length === 0) {
        status.textContent = '該当するクリップは見つかりませんでした。';
        document.getElementById('tMore').style.display = 'none';
        return;
    }
    const label = q.trim() ? `「${q.trim()}」の検索結果` : '一覧';
    status.textContent = all.length > T_MAX_RESULTS
        ? `${label}: ${all.length}件ヒット(新しい順に上位${T_MAX_RESULTS}件を表示)`
        : `${label}: ${all.length}件ヒット`;
    renderMoreTranscripts();
}

document.getElementById('tSearchBtn').addEventListener('click', transcriptSearch);
document.getElementById('tMore').addEventListener('click', renderMoreTranscripts);
['tQuery', 'tCreator', 'tCategory'].forEach(id =>
    document.getElementById(id).addEventListener('keydown', e => { if (e.key === 'Enter') transcriptSearch(); }));

const loading = initData();

let player;
let isTwitch = false; // Twitchプレイヤー判定用
let comments = [];
let filteredComments = []; 
let isSeeking = false; // シーク直後の自動追従ガードフラグ
let transcriptEntries = []; // ★追加：文字起こしの時間データを保持
let pendingTranscriptClick = null; // ★追加：クリックした文字起こし行を記憶(シークの着地ズレ対策)
let currentSearchTerm = ''; // 検索窓の現在の検索語(正規化済み: 大小文字・全半角・ひらがな/カタカナを区別しない)。文字起こしの絞り込みにも使う
let searchInitialized = false;
let transcriptHitCount = 0; // 文字起こしの検索ヒット行数
// ===== 長い配信(文字起こしが多い)向けの軽量表示 =====
const LIGHT_MODE_THRESHOLD = 10000; // 文字起こしがこの行数を超えたら、画面に見える分だけ作る方式にする
const T_CHUNK = 100;                // 軽量表示での1ブロックの行数
let transcriptLight = false;        // 軽量表示中か
let tView = [];                     // いま表示対象の行番号(検索中はヒットした行だけ)
let tChunks = [];                   // ブロックの一覧 {start,end,el,h,top,rendered}
let tActiveIdx = -1;                // いま強調する文字起こし行
let activeCommentEl = null;         // いま強調中のコメント要素
let activeTranscriptEl = null;      // いま強調中の文字起こし要素
let searchTimer = null;

let tScrollBound = false;
let pageTitleRank = 0;      // タブ名の取得元の優先度(YouTube=3 > チャットJSON=2 > スプレッドシート=1)

const urlParams = new URLSearchParams(window.location.search);
const VIDEO_ID = urlParams.get('v') || 'JKaIKUHjXQQ'; 
const RAW_D = urlParams.get('d') || '011726';
const LAG_ADJUSTMENT = parseInt(urlParams.get('s')) || 0;
// ★追加：開始位置(動画の実際の時間・秒)。?t=3725 のように指定すると、その位置から始まる(「読む」配信のページ用)
const START_TIME = Math.max(0, parseInt(urlParams.get('t')) || 0);
// ★追加：?tr=0 を付けると、開始位置の指定(t)があっても文字起こしを自動で開かない(単語検索の「チャット」結果用)。付けなければ従来どおり自動で開く
const AUTO_OPEN_TRANSCRIPT = urlParams.get('tr') !== '0';

// ★追加：データ(コメント・文字起こし)の読み込みが終わってから、指定位置にコメント欄・文字起こしを合わせる
function jumpToStartAfterLoad(promises) {
    if (!START_TIME) return;
    Promise.all(promises).then(() => {
        // 文字起こしがある場合は、自動で開く(「文字起こし表示」ボタンを押したのと同じ状態にする)
        const container = document.getElementById('transcriptContainer');
        const toggleBtn = document.getElementById('transcriptToggleBtn');
        if (AUTO_OPEN_TRANSCRIPT && container && toggleBtn && transcriptEntries.length > 0 && container.style.display === 'none') {
            toggleBtn.click();
        }
        setTimeout(() => updateActiveDisplay(true), 300);
    });
}

// === ブラウザのタブ名を、開いた動画のタイトルにする ===
// 取得元の優先度: YouTubeプレイヤーの動画タイトル(3) > チャットJSONのvideo.title(2) > スプレッドシートの配信タイトル+日(1)
function setPageTitle(title, rank) {
    title = (title || '').trim();
    if (!title || rank <= pageTitleRank) return;
    document.title = title;
    pageTitleRank = rank;
}

const TITLE_SHEET_ID = '1yubpjM0sqNAjwRMCoiWDgdTeTrB8zZ2YyomA-z2fvVg';

// セル内の改行・カンマ・"" に対応した簡易CSVパーサー
function parseCsvRows(text) {
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

// Twitchなど、プレイヤーやJSONからタイトルが取れない場合の保険:
// index.html と同じスプレッドシートから、この配信コード(d)の行を探して「配信タイトル 日」を使う
async function loadTitleFromSheet() {
    const m = RAW_D.match(/^(\d{6})(-\d+)?$/);
    if (!m) return;
    const year = `20${m[1].substring(4, 6)}`;
    try {
        const url = `https://docs.google.com/spreadsheets/d/${TITLE_SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(year)}&range=A:G`;
        const res = await fetch(url);
        if (!res.ok) return;
        const rows = parseCsvRows(await res.text()).slice(1);
        let lastTitle = '';
        for (const row of rows) {
            if ((row[1] || '').trim()) lastTitle = row[1].trim();
            let d = null;
            try { d = new URL((row[6] || '').trim(), location.href).searchParams.get('d'); } catch (e) { /* 無効なURLは無視 */ }
            if (d === RAW_D) {
                setPageTitle(`${lastTitle} ${(row[5] || '').trim()}`, 1);
                return;
            }
        }
    } catch (error) {
        console.warn("タブ名用のタイトル取得に失敗しました:", error);
    }
}

function getYouTubeTitle() {
    try { return (player && player.getVideoData && player.getVideoData().title) || ''; }
    catch (e) { return ''; }
}

// === 年号判定とファイルパス生成関数（フォルダ整理対応） ===
function getFilePath(rawCode, defaultExt) {
    if (!rawCode) return "";
    
    // 例: "011726" や "011726-2" から先頭6桁の数字を取り出し、下2桁(26)から "2026" を取得
    const match = rawCode.match(/^(\d{6})(-\d+)?$/);
    let yearFolder = "";
    
    if (match) {
        const yy = match[1].substring(4, 6);
        yearFolder = `20${yy}/`;
    }
    
    const folder = (defaultExt === 'json') ? 'json_slim' : 'txt';   // チャットJSONは軽量版フォルダ(json_slim)を読む
    return `${folder}/${yearFolder}${rawCode}.${defaultExt}`;
}

// フォルダ変更に伴うパスの動的設定
const DATA_FILE = urlParams.get('json') || getFilePath(RAW_D, 'json');
const TXT_FILE = urlParams.get('txt') || getFilePath(RAW_D, 'txt');

// IDが数字のみで構成されている場合はTwitchのVOD IDと判定
isTwitch = /^\d+$/.test(VIDEO_ID);

if (isTwitch) {
    // === Twitch Player API の読み込みと初期化 ===
    const tag = document.createElement('script');
    tag.src = "https://player.twitch.tv/js/embed/v1.js";
    document.body.appendChild(tag);

    tag.onload = () => {
        const playerContainer = document.getElementById('player');
        if (playerContainer) {
            playerContainer.innerHTML = '';
            playerContainer.style.display = 'flex';
            playerContainer.style.justifyContent = 'center';
            playerContainer.style.alignItems = 'center';
        }

        const options = {
            width: '100%',
            height: 450,
            video: VIDEO_ID,
            time: START_TIME ? `${Math.floor(START_TIME / 3600)}h${Math.floor((START_TIME % 3600) / 60)}m${START_TIME % 60}s` : undefined,
            // Twitchプレイヤー必須パラメータ（現在のドメインを自動設定）
            parent: [window.location.hostname || 'localhost']
        };
        
        player = new Twitch.Player('player', options);

        player.addEventListener(Twitch.Player.READY, () => {
            const pData = loadData(); 
            const pTrans = loadTranscript(); // 文字起こし(TXT)の読み込み
            setupTranscriptUI(); // トグルボタンと文字起こしエリアの生成
            startTracking();
            jumpToStartAfterLoad([pData, pTrans]);
        });

        player.addEventListener(Twitch.Player.PLAY, () => {
            updateActiveDisplay(true);
        });
        
        player.addEventListener(Twitch.Player.PAUSE, () => {
            updateActiveDisplay(true);
        });
    };

} else {
    // === YouTube API の読み込みと初期化 ===
    const tag = document.createElement('script');
    tag.src = "https://www.youtube.com/iframe_api";
    document.body.appendChild(tag);

    window.onYouTubeIframeAPIReady = function() {
        player = new YT.Player('player', {
            height: '450',
            width: '100%',
            videoId: VIDEO_ID,
            playerVars: {
                'start': START_TIME || LAG_ADJUSTMENT,
                'playsinline': 1
            },
            events: {
                'onReady': () => {
                    setPageTitle(getYouTubeTitle(), 3);
                    const pData = loadData(); 
                    const pTrans = loadTranscript(); // 文字起こし(TXT)の読み込み
                    setupTranscriptUI(); // トグルボタンと文字起こしエリアの生成
                    startTracking();
                    jumpToStartAfterLoad([pData, pTrans]);
                },
                'onStateChange': (event) => {
                    setPageTitle(getYouTubeTitle(), 3);   // 開始直後は空のことがあるので、状態変化のたびに確認
                    if (event.data === YT.PlayerState.PLAYING || event.data === YT.PlayerState.PAUSED) {
                        updateActiveDisplay(true);
                    }
                }
            }
        });
    };
}

// 軽量版JSON({v:1, title, comments:[{t,d,u,c,b,f}]})をそのまま使う。
// 元の形式のJSON(?json= で直接指定した場合など)が来た時は、軽量版の形に変換して同じように表示する
function normalizeChatData(data) {
    if (data && data.v === 1) {
        data.comments = data.comments || [];
        return data;
    }
    const out = { v: 1, title: (data && data.video && data.video.title) || '', comments: [] };
    ((data && data.comments) || []).forEach(c => {
        const cm = c.commenter || {}, m = c.message || {};
        const item = { t: c.content_offset_seconds || 0, d: cm.display_name || '', b: m.body || '' };
        if ((cm.name || '') !== item.d) item.u = cm.name || '';
        if (m.user_color) item.c = m.user_color;
        if (m.fragments) item.f = m.fragments.map(f => f.emoticon ? [f.text, f.emoticon.emoticon_id] : f.text);
        out.comments.push(item);
    });
    return out;
}

async function loadData() {
    try {
        const response = await fetch(DATA_FILE);
        const data = normalizeChatData(await response.json());
        comments = data.comments; 
        if (data.title) setPageTitle(data.title, 2);
        filteredComments = comments; 
        renderComments();
        updateCount(); 
        initSearch(); 
        if (currentSearchTerm !== '') applySearch();   // 読み込み前に入力されていた検索語を反映
    } catch (error) {
        console.error("データの読み込み失敗:", error);
    }
    // YouTubeのタイトルもJSONのタイトルも取れなかった場合の保険
    if (pageTitleRank < 2) loadTitleFromSheet();
}

/* ==========================================
 * 文字起こし (TXT) 関連の処理
 * ========================================== */

function setupTranscriptUI() {
    const commentListContainer = document.getElementById('commentList');
    if (!commentListContainer) return;

    const syncBtn = document.getElementById('syncBtn');
    if (syncBtn && !document.getElementById('transcriptToggleBtn')) {
        const toggleBtn = document.createElement('button');
        toggleBtn.id = 'transcriptToggleBtn';
        toggleBtn.innerText = '文字起こし表示';
        toggleBtn.style.cssText = 'margin-left: 8px; cursor: pointer; padding: 4px 8px;';
        
        toggleBtn.addEventListener('click', () => {
            const container = document.getElementById('transcriptContainer');
            if (container) {
                const isHidden = container.style.display === 'none';
                container.style.display = isHidden ? 'block' : 'none';
                toggleBtn.innerText = isHidden ? '文字起こし非表示' : '文字起こし表示';
                updateCount();
                if (isHidden) {
                    refreshTranscriptWindow();    // 軽量表示: 表示した瞬間に見える分を作る
                    updateActiveTranscript(true); // ★追加：表示した瞬間に現在地へジャンプ
                }
            }
        });

        syncBtn.parentNode.insertBefore(toggleBtn, syncBtn.nextSibling);
    }

    if (!document.getElementById('transcriptContainer')) {
        const transcriptContainer = document.createElement('div');
        transcriptContainer.id = 'transcriptContainer';
        transcriptContainer.style.cssText = `
            display: none;
            height: 66.66vh;
            overflow-y: auto;
            border-bottom: 2px solid #ccc;
            padding: 10px;
            background-color: rgba(0, 0, 0, 0.03);
            margin-bottom: 10px;
        `;
        
        commentListContainer.parentNode.insertBefore(transcriptContainer, commentListContainer);
    }
}

async function loadTranscript() {
    try {
        const response = await fetch(TXT_FILE);
        if (!response.ok) return;
        const txtText = await response.text();
        renderTranscript(txtText);
    } catch (error) {
        console.warn("文字起こしデータの読み込みに失敗しました:", error);
    }
}

// 文字起こし1行ぶんのHTML(通常表示・軽量表示で共通)
function transcriptRowHtml(idx, withHighlight) {
    const t = transcriptEntries[idx];
    const body = (withHighlight && currentSearchTerm !== '') ? highlightTerm(t.text, currentSearchTerm) : t.text;
    return `
                <div class="transcript-item${idx === tActiveIdx ? ' active' : ''}" id="transcript-${idx}" style="margin-bottom: 8px; font-size: 0.9em; line-height: 1.4;">
                    <span class="transcript-time" onclick="seekToTranscript(${t.time}, ${idx}, this)" 
                          style="cursor: pointer; color: #6441a5; font-weight: bold; margin-right: 8px;">
                        ${formatTime(t.time)}
                    </span>
                    <span class="transcript-text">${body}</span>
                </div>
            `;
}

// [00:00:16.375] 形式のTXTテキストを画面にレンダリング
function renderTranscript(txtText) {
    const container = document.getElementById('transcriptContainer');
    if (!container) return;

    const lines = txtText.split(/\r?\n/).map(line => line.trim()).filter(line => line !== '');
    transcriptEntries = []; // ★リセット

    lines.forEach(line => {
        // 行の先頭にある [00:00:16.375] のようなタイムスタンプパターンを検出
        const match = line.match(/^\[(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)\]\s*(.*)/);
        if (match) {
            const hours = parseInt(match[1], 10);
            const minutes = parseInt(match[2], 10);
            const seconds = parseFloat(match[3]); // ミリ秒を切り捨てず小数のまま扱う
            const textContent = match[4].trim();
            // 合計秒数を計算（小数点以下=ミリ秒も保持）
            const totalSeconds = hours * 3600 + minutes * 60 + seconds;
            if (textContent) transcriptEntries.push({ time: totalSeconds, text: textContent });
        }
    });

    transcriptLight = transcriptEntries.length > LIGHT_MODE_THRESHOLD;
    if (transcriptLight) {
        initTranscriptLight(container);   // 長い配信: 全行は作らず、見えている付近だけ作る
    } else {
        let html = '';
        for (let i = 0; i < transcriptEntries.length; i++) html += transcriptRowHtml(i, false);
        container.innerHTML = html;
    }
    if (transcriptLight || currentSearchTerm !== '') applyTranscriptFilter();   // 軽量表示は最初の組み立て、通常表示は先に入力された検索語の反映
}

/* ------------------------------------------
 * 軽量表示(文字起こしが多い長時間配信用)
 *  行を100行ずつの「ブロック」に分け、画面付近のブロックだけ中身を作る。
 *  離れたブロックは空にして高さだけ保持するので、スクロールバーは全体の長さのまま、
 *  手動で好きな時間帯までスクロールできる。
 * ------------------------------------------ */
function initTranscriptLight(container) {
    container.style.overflowAnchor = 'none';   // ブラウザ任せの位置補正を切り、自前で補正する
    if (tScrollBound) return;
    tScrollBound = true;
    let ticking = false;
    container.addEventListener('scroll', () => {
        if (ticking) return;
        ticking = true;
        requestAnimationFrame(() => { ticking = false; refreshTranscriptWindow(); });
    });
}

function estimateRowHeight(len) {   // 作る前の高さの目安(あとで実測値に置き換わる)
    return Math.max(1, Math.ceil(len / 20)) * 20 + 16;
}

function buildTranscriptChunks() {
    const container = document.getElementById('transcriptContainer');
    if (!container) return;
    container.innerHTML = '';
    tChunks = [];
    activeTranscriptEl = null;
    const frag = document.createDocumentFragment();
    for (let p = 0; p < tView.length; p += T_CHUNK) {
        const end = Math.min(p + T_CHUNK, tView.length);
        let h = 0;
        for (let k = p; k < end; k++) h += estimateRowHeight(transcriptEntries[tView[k]].text.length);
        const el = document.createElement('div');
        el.className = 't-chunk';
        el.style.display = 'flow-root';   // 行の下余白を含めて高さを測るため
        el.style.height = h + 'px';
        frag.appendChild(el);
        tChunks.push({ start: p, end: end, el: el, h: h, top: 0, rendered: false });
    }
    container.appendChild(frag);
}

function renderTChunk(c, top) {
    const container = document.getElementById('transcriptContainer');
    let html = '';
    for (let k = c.start; k < c.end; k++) html += transcriptRowHtml(tView[k], true);
    const oldH = c.h;
    c.el.style.height = '';
    c.el.innerHTML = html;
    c.rendered = true;
    c.h = c.el.offsetHeight;
    // 画面より上のブロックの高さが変わった時は、見ている位置がずれないように補正する
    if (c.h !== oldH && top + oldH <= container.scrollTop + 0.5) container.scrollTop += c.h - oldH;
}

function unrenderTChunk(c) {
    c.el.style.height = c.h + 'px';
    c.el.innerHTML = '';
    c.rendered = false;
}

// 画面付近(上1画面分・下2画面分)のブロックだけ中身を作り、それ以外は空にする
function refreshTranscriptWindow() {
    if (!transcriptLight) return;
    const container = document.getElementById('transcriptContainer');
    if (!container || container.style.display === 'none' || container.clientHeight === 0) return;
    const vh = container.clientHeight;
    let y = 10; // コンテナの上余白
    for (const c of tChunks) {
        const lo = container.scrollTop - vh, hi = container.scrollTop + vh * 2;
        const needed = (y + c.h > lo) && (y < hi);
        c.top = y;
        if (needed && !c.rendered) renderTChunk(c, y);
        else if (!needed && c.rendered) unrenderTChunk(c);
        y += c.h;
    }
}

function viewPosOf(idx) {   // tView(昇順)の中での位置。無ければ -1
    let lo = 0, hi = tView.length - 1;
    while (lo <= hi) {
        const m = (lo + hi) >> 1;
        if (tView[m] === idx) return m;
        if (tView[m] < idx) lo = m + 1; else hi = m - 1;
    }
    return -1;
}

// ★修正(スマホで動画が上にずれる不具合の対策):
// element.scrollIntoView() は、その要素を含む「すべての親」をスクロールしてしまう。
// スマホではページ全体(html/body・外枠)も巻き込まれて動画が上にずれ、overflow:hidden なので自力で戻せなくなる。
// そこで、チャット欄・文字起こし欄の「中だけ」を動かして、その要素を真ん中に寄せる関数に置き換えた。
function centerInScrollBox(el) {
    if (!el) return;
    const box = el.closest('#transcriptContainer, #commentList');
    if (!box) return;
    const boxRect = box.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    const target = box.scrollTop + (elRect.top - boxRect.top) - (box.clientHeight - el.offsetHeight) / 2;
    box.scrollTop = Math.max(0, target);
}

// 指定の行まで文字起こし欄をスクロールする(まだ作られていないブロックは先に作る)
function scrollTranscriptTo(idx) {
    const container = document.getElementById('transcriptContainer');
    if (!container || container.style.display === 'none' || container.clientHeight === 0) return false;
    const pos = viewPosOf(idx);
    if (pos < 0) return false;
    const ci = Math.floor(pos / T_CHUNK);
    let y = 10;
    for (let i = 0; i < ci; i++) y += tChunks[i].h;
    container.scrollTop = y;
    refreshTranscriptWindow();
    const el = document.getElementById(`transcript-${idx}`);
    if (el) centerInScrollBox(el);
    return true;
}

// 検索用の正規化: 全角/半角・大文字/小文字・ひらがな/カタカナの違いを区別しない
function kanaToHira(s) {
    return s.replace(/[\u30A1-\u30F6\u30FD\u30FE]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0x60));
}
function normSearch(s) {
    return kanaToHira(String(s || '').normalize('NFKC').toLowerCase());
}

// 検索語を強調表示(HTMLエスケープ込み)。正規化したまま、元の文字列上でヒット箇所を強調する
function escapeHtmlText(s) {
    return String(s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}
function highlightTerm(text, term) {
    let n = '';
    const map = [];
    for (let i = 0; i < text.length; i++) {
        const t = normSearch(text[i]);
        for (let k = 0; k < t.length; k++) { n += t[k]; map.push(i); }
    }
    const mark = new Array(text.length).fill(false);
    let p = 0;
    while ((p = n.indexOf(term, p)) !== -1) {
        for (let k = p; k < p + term.length; k++) mark[map[k]] = true;
        p += term.length;
    }
    let out = '', i = 0;
    while (i < text.length) {
        let k = i;
        while (k < text.length && mark[k] === mark[i]) k++;
        const seg = escapeHtmlText(text.slice(i, k));
        out += mark[i] ? `<mark>${seg}</mark>` : seg;
        i = k;
    }
    return out;
}

// 検索窓の語で文字起こしの行を絞り込む(ヒットしない行は非表示、ヒットした語は強調)
function applyTranscriptFilter() {
    const term = currentSearchTerm;
    if (transcriptLight) {
        // 軽量表示: ヒットした行だけを対象にしてブロックを組み直す
        if (term === '') {
            tView = transcriptEntries.map((_, i) => i);
        } else {
            tView = [];
            transcriptEntries.forEach((t, i) => {
                if (t.nk === undefined) t.nk = normSearch(t.text);   // 正規化は1回だけ計算して使い回す
                if (t.nk.includes(term)) tView.push(i);
            });
        }
        transcriptHitCount = tView.length;
        buildTranscriptChunks();
        const container = document.getElementById('transcriptContainer');
        if (container) container.scrollTop = 0;
        if (!(term === '' && tActiveIdx >= 0 && scrollTranscriptTo(tActiveIdx))) refreshTranscriptWindow();
        updateCount();
        return;
    }
    let hits = 0;
    transcriptEntries.forEach((t, i) => {
        const el = document.getElementById(`transcript-${i}`);
        if (!el) return;
        if (t.nk === undefined) t.nk = normSearch(t.text);   // 正規化は1回だけ計算して使い回す
        const hit = term === '' || t.nk.includes(term);
        el.style.display = hit ? '' : 'none';
        if (hit) hits++;
        const textEl = el.querySelector('.transcript-text');
        if (!textEl) return;
        if (hit && term !== '') {
            textEl.innerHTML = highlightTerm(t.text, term);
            el.dataset.hl = '1';
        } else if (el.dataset.hl === '1') {
            textEl.innerHTML = t.text;          // 元の表示に戻す
            el.dataset.hl = '';
        }
    });
    transcriptHitCount = hits;
    updateCount();
}

/* ========================================== */

function updateCount() {
    const countEl = document.getElementById('searchCount');
    if (countEl) {
        let label = `${filteredComments.length}件`;
        const tc = document.getElementById('transcriptContainer');
        if (currentSearchTerm !== '' && tc && tc.style.display !== 'none' && transcriptEntries.length > 0) {
            label += ` / 字幕${transcriptHitCount}件`;
        }
        countEl.innerText = label;
    }
}

// 検索窓の語でコメントと文字起こしを絞り込む
function applySearch() {
    const term = currentSearchTerm;
    if (term === "") {
        filteredComments = comments;
    } else {
        filteredComments = comments.filter(c => {
            if (c._nk === undefined) {   // 正規化は1回だけ計算して使い回す
                c._nk = normSearch((c.d || "") + "\u0000" + (c.u !== undefined ? c.u : (c.d || "")) + "\u0000" + (c.b || ""));
            }
            return c._nk.includes(term);
        });
    }
    renderComments();
    applyTranscriptFilter();   // 文字起こしも同じ検索語で絞り込む(件数表示の更新も含む)
}

// ※チャットのJSONが無くても文字起こしを検索できるよう、JSONの読み込みとは無関係に設定する
function initSearch() {
    if (searchInitialized) return;
    const searchInput = document.getElementById('commentSearch');
    if (!searchInput) return;
    searchInitialized = true;
    searchInput.addEventListener('input', (e) => {
        currentSearchTerm = normSearch(e.target.value.trim());
        // 入力が落ち着いてから絞り込む(長い配信では1文字ごとの再計算が重いため)
        clearTimeout(searchTimer);
        searchTimer = setTimeout(applySearch, transcriptLight ? 300 : 100);
    });
}

function renderComments() {
    const listDiv = document.getElementById('commentList');
    if (!listDiv) return;
    activeCommentEl = null;
    listDiv.innerHTML = filteredComments.map((c, i) => {
        const displayName = c.d;
        const userName = (c.u !== undefined) ? c.u : c.d;   // 軽量版は、表示名と同じ時はログイン名を省略している
        const userColor = c.c || "#888";
        
        const idHtml = (displayName !== userName) 
            ? `<span class="user-id" style="margin-left: 5px; color: ${userColor}; opacity: 0.7; font-size: 0.9em;">(${userName})</span>` 
            : "";

        let bodyHtml = "";
        if (c.f) {
            c.f.forEach(frag => {
                if (Array.isArray(frag)) {   // [エモート名, エモートID]
                    bodyHtml += `<img src="https://static-cdn.jtvnw.net/emoticons/v2/${frag[1]}/default/dark/1.0" title="${frag[0]}">`;
                } else {                     // ただの文字
                    bodyHtml += frag;
                }
            });
        } else {
            bodyHtml = c.b;
        }

        const displayTime = c.t + LAG_ADJUSTMENT;

        return `
            <div class="comment-item" id="comment-${i}">
                <span class="time-link" onclick="seekTo(${displayTime}, this)" 
                      style="cursor: pointer; padding: 2px 4px; border: 1px solid transparent; border-radius: 4px; transition: all 0.1s; display: inline-block;"
                      onmouseover="this.style.border='1px solid #6441a5'; this.style.backgroundColor='rgba(100, 65, 165, 0.1)';"
                      onmouseout="this.style.border='1px solid transparent'; this.style.backgroundColor='transparent';">
                    ${formatTime(displayTime)}
                </span>
                <span class="user-name" style="color: ${userColor}">${displayName}</span>
                ${idHtml}
                <span class="separator">：</span>
                <span class="comment-body">${bodyHtml}</span>
            </div>
        `;
    }).join('');
}

// 強調表示は「前回強調した1要素」だけ外す(全要素を調べ直さない)
function setActiveCommentEl(el) {
    if (activeCommentEl && activeCommentEl !== el) activeCommentEl.classList.remove('active');
    activeCommentEl = el;
    el.classList.add('active');
}
function setActiveTranscriptEl(el) {
    if (activeTranscriptEl && activeTranscriptEl !== el) activeTranscriptEl.classList.remove('active');
    activeTranscriptEl = el;
    el.classList.add('active');
}

function updateActiveComment(forceJump = false) {
    if (!player || isSeeking) return; // シーク中は定期更新による位置連戻しをスキップ
    
    // YouTubeとTwitchで再生位置取得関数を分岐
    const currentTime = isTwitch ? player.getCurrentTime() : (player.getCurrentTime ? player.getCurrentTime() : 0);
    const index = filteredComments.findLastIndex(c => c.t <= (currentTime - LAG_ADJUSTMENT));
    
    if (index !== -1) {
        const el = document.getElementById(`comment-${index}`);
        if (el) {
            setActiveCommentEl(el);
            if (forceJump) {
                centerInScrollBox(el);
            }
        }
    }
}

// いま強調する文字起こし行を決める。軽量表示で行がまだ作られていない時は、そこまでスクロールして作る
function setActiveTranscript(index, forceJump) {
    tActiveIdx = index;
    let el = document.getElementById(`transcript-${index}`);
    if (!el && forceJump && transcriptLight && scrollTranscriptTo(index)) {
        el = document.getElementById(`transcript-${index}`);
        if (el) setActiveTranscriptEl(el);
        return;
    }
    if (el) {
        setActiveTranscriptEl(el);
        if (forceJump) centerInScrollBox(el);
    } else if (activeTranscriptEl) {
        activeTranscriptEl.classList.remove('active');   // 検索で絞り込まれて表示されていない行
        activeTranscriptEl = null;
    }
}

// ★追加：文字起こし側のハイライト・自動スクロール（コメント版と同じロジック）
function updateActiveTranscript(forceJump = false) {
    if (!player || isSeeking || transcriptEntries.length === 0) return;

    const currentTime = isTwitch ? player.getCurrentTime() : (player.getCurrentTime ? player.getCurrentTime() : 0);
    const adjustedTime = currentTime; // ★修正：txtのtimeは元々実際の動画時間なのでLAG_ADJUSTMENTを引かない
    let index = transcriptEntries.findLastIndex(t => t.time <= adjustedTime);

    // ★追加：動画のシークはフレーム単位でしか着地できないため、
    // クリックした行の秒数ぴったりより「わずかに手前」に着地して
    // 1つ前の行が該当してしまうことがある。クリック直後はクリックした行を下限にする。
    if (pendingTranscriptClick !== null) {
        if (adjustedTime >= pendingTranscriptClick.time - 2) {
            if (index < pendingTranscriptClick.index) {
                index = pendingTranscriptClick.index;
            }
        } else {
            // 大きく離れた位置なら、動画側を別の場所へ手動でシークしたとみなして解除
            pendingTranscriptClick = null;
        }
    }

    if (index !== -1) setActiveTranscript(index, forceJump);
}

// ★追加：コメントと文字起こし、両方まとめて更新する
function updateActiveDisplay(forceJump = false) {
    updateActiveComment(forceJump);
    updateActiveTranscript(forceJump);
}

function startTracking() {
    setInterval(() => updateActiveDisplay(false), 500); // ★変更
}

function formatTime(sec) {
    if (sec < 0) sec = 0;
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    return (h > 0 ? h + ":" : "") + m.toString().padStart(2, '0') + ":" + s.toString().padStart(2, '0');
}

function seekTo(sec, element) {
    if (element) {
        element.style.backgroundColor = "#6441a5";
        element.style.color = "#ffffff";
        setTimeout(() => {
            element.style.backgroundColor = "rgba(100, 65, 165, 0.1)";
            element.style.color = "#666";
        }, 200);
    }
    
    // シーク開始時に自動トラッキングを一定時間ロック
    isSeeking = true;
    
    if (isTwitch) {
        player.seek(sec);
        
        // クリックした要素を、それが属するリスト内でひとまず即座にハイライト＆スクロール
        const targetItem = element ? element.closest('.comment-item, .transcript-item') : null;
        if (targetItem) {
            if (targetItem.classList.contains('comment-item')) setActiveCommentEl(targetItem);
            else setActiveTranscriptEl(targetItem);
            centerInScrollBox(targetItem);
        }

        // Twitchの再生位置が新しい時間に同期するのを待ってから、コメント・文字起こし両方を正しい時間に合わせる
        setTimeout(() => {
            isSeeking = false;
            updateActiveDisplay(true); // ★追加：もう片方のリストも同期させる
        }, 1500);

    } else {
        player.seekTo(sec, true);
        setTimeout(() => {
            updateActiveDisplay(true); // ★変更
            isSeeking = false;
        }, 100);
    }
}

// ★追加：文字起こし行クリック専用のシーク関数
// 動画のシークがフレーム単位でしか着地できないため、クリックした行を明示的に記憶しておく
function seekToTranscript(sec, index, element) {
    pendingTranscriptClick = { time: sec, index: index };

    // クリックした行を即座にハイライト＆スクロール
    tActiveIdx = index;
    const el = document.getElementById(`transcript-${index}`);
    if (el) {
        setActiveTranscriptEl(el);
        centerInScrollBox(el);
    }

    seekTo(sec, element);
}

const syncBtn = document.getElementById('syncBtn');
if (syncBtn) {
    syncBtn.addEventListener('click', () => {
        updateActiveDisplay(true); // ★変更：同期ボタンで両方スクロール
    });
}

// JSONの有無にかかわらず、検索窓を使えるようにする
initSearch();

// ★修正(スマホで動画が上にずれる不具合の対策・保険):
// ブラウザのアドレスバー・キーボード・他の処理などで、ページ全体や外枠(.container など)が
// 勝手にスクロールされても、すぐ先頭(0)に戻して動画が隠れないようにする
(function lockLayoutScroll() {
    const isOuter = (t) => t === document || t === document.documentElement || t === document.body ||
        (t && t.matches && t.matches('.container, .video-side, .chat-side'));
    const fix = () => {
        [document.scrollingElement, document.documentElement, document.body,
         ...document.querySelectorAll('.container, .video-side, .chat-side')].forEach(el => {
            if (el && (el.scrollTop || el.scrollLeft)) { el.scrollTop = 0; el.scrollLeft = 0; }
        });
    };
    window.addEventListener('scroll', fix, { passive: true });
    // 要素のscrollイベントは上に伝わらないので、捕捉(capture)して外枠のものだけ処理する
    document.addEventListener('scroll', (e) => { if (isOuter(e.target)) fix(); }, { passive: true, capture: true });
    window.addEventListener('resize', fix);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', fix);
})();
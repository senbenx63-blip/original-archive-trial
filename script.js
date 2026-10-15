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
let pageTitleRank = 0;      // タブ名の取得元の優先度(YouTube=3 > チャットJSON=2 > スプレッドシート=1)

const urlParams = new URLSearchParams(window.location.search);
const VIDEO_ID = urlParams.get('v') || 'JKaIKUHjXQQ'; 
const RAW_D = urlParams.get('d') || '011726';
const LAG_ADJUSTMENT = parseInt(urlParams.get('s')) || 0;
// ★追加：開始位置(動画の実際の時間・秒)。?t=3725 のように指定すると、その位置から始まる(「読む」配信のページ用)
const START_TIME = Math.max(0, parseInt(urlParams.get('t')) || 0);

// ★追加：データ(コメント・文字起こし)の読み込みが終わってから、指定位置にコメント欄・文字起こしを合わせる
function jumpToStartAfterLoad(promises) {
    if (!START_TIME) return;
    Promise.all(promises).then(() => {
        // 文字起こしがある場合は、自動で開く(「文字起こし表示」ボタンを押したのと同じ状態にする)
        const container = document.getElementById('transcriptContainer');
        const toggleBtn = document.getElementById('transcriptToggleBtn');
        if (container && toggleBtn && transcriptEntries.length > 0 && container.style.display === 'none') {
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
    
    const folder = (defaultExt === 'json') ? 'json' : 'txt';
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

async function loadData() {
    try {
        const response = await fetch(DATA_FILE);
        const data = await response.json();
        comments = data.comments; 
        if (data.video && data.video.title) setPageTitle(data.video.title, 2);
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

// [00:00:16.375] 形式のTXTテキストを画面にレンダリング
function renderTranscript(txtText) {
    const container = document.getElementById('transcriptContainer');
    if (!container) return;

    const lines = txtText.split(/\r?\n/).map(line => line.trim()).filter(line => line !== '');
    let html = '';
    transcriptEntries = []; // ★リセット

    lines.forEach(line => {
        // 行の先頭にある [00:00:16.375] のようなタイムスタンプパターンを検出
        const match = line.match(/^\[(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)\]\s*(.*)/);
        
        if (match) {
            const hours = parseInt(match[1], 10);
            const minutes = parseInt(match[2], 10);
            const seconds = parseFloat(match[3]); // ★修正：ミリ秒を切り捨てず小数のまま扱う
            const textContent = match[4].trim();

            // 合計秒数を計算（小数点以下=ミリ秒も保持）
            const totalSeconds = hours * 3600 + minutes * 60 + seconds;

            if (textContent) {
                const index = transcriptEntries.length; // ★このエントリのインデックス
                transcriptEntries.push({ time: totalSeconds, text: textContent }); // ★追加

                html += `
                    <div class="transcript-item" id="transcript-${index}" style="margin-bottom: 8px; font-size: 0.9em; line-height: 1.4;">
                        <span class="transcript-time" onclick="seekToTranscript(${totalSeconds}, ${index}, this)" 
                              style="cursor: pointer; color: #6441a5; font-weight: bold; margin-right: 8px;">
                            ${formatTime(totalSeconds)}
                        </span>
                        <span class="transcript-text">${textContent}</span>
                    </div>
                `;
            }
        }
    });

    container.innerHTML = html;
    if (currentSearchTerm !== '') applyTranscriptFilter();   // 先に検索語が入力されていた場合に反映
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
                c._nk = normSearch((c.commenter.display_name || "") + "\u0000" + (c.commenter.name || "") + "\u0000" + (c.message.body || ""));
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
        applySearch();
    });
}

function renderComments() {
    const listDiv = document.getElementById('commentList');
    if (!listDiv) return;
    listDiv.innerHTML = filteredComments.map((c, i) => {
        const displayName = c.commenter.display_name;
        const userName = c.commenter.name;
        const userColor = c.message.user_color || "#888";
        
        const idHtml = (displayName !== userName) 
            ? `<span class="user-id" style="margin-left: 5px; color: ${userColor}; opacity: 0.7; font-size: 0.9em;">(${userName})</span>` 
            : "";

        let bodyHtml = "";
        if (c.message.fragments) {
            c.message.fragments.forEach(frag => {
                if (frag.emoticon) {
                    bodyHtml += `<img src="https://static-cdn.jtvnw.net/emoticons/v2/${frag.emoticon.emoticon_id}/default/dark/1.0" title="${frag.text}">`;
                } else {
                    bodyHtml += frag.text;
                }
            });
        } else {
            bodyHtml = c.message.body;
        }

        const displayTime = c.content_offset_seconds + LAG_ADJUSTMENT;

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

function updateActiveComment(forceJump = false) {
    if (!player || isSeeking) return; // シーク中は定期更新による位置連戻しをスキップ
    
    // YouTubeとTwitchで再生位置取得関数を分岐
    const currentTime = isTwitch ? player.getCurrentTime() : (player.getCurrentTime ? player.getCurrentTime() : 0);
    const index = filteredComments.findLastIndex(c => c.content_offset_seconds <= (currentTime - LAG_ADJUSTMENT));
    
    if (index !== -1) {
        document.querySelectorAll('.comment-item').forEach(e => e.classList.remove('active'));
        const el = document.getElementById(`comment-${index}`);
        if (el) {
            el.classList.add('active');
            if (forceJump) {
                el.scrollIntoView({ behavior: 'auto', block: 'center' });
            }
        }
    }
}

// ★追加：文字起こし側のハイライト・自動スクロール（コメント版と同じロジック）
function updateActiveTranscript(forceJump = false) {
    if (!player || isSeeking || transcriptEntries.length === 0) return;

    const currentTime = isTwitch ? player.getCurrentTime() : (player.getCurrentTime ? player.getCurrentTime() : 0);
    const adjustedTime = currentTime; // ★修正：txtのtimeは元々実際の動画時間なのでLAG_ADJUSTMENTを引かない
    let index = transcriptEntries.findLastIndex(t => t.time <= adjustedTime);
    const rawIndex = index; // ★デバッグ用：クランプ前の値を保存

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

    // ★デバッグ用ログ（原因特定のため。確認が終わったら削除してOK）
    console.log(
        "[transcript debug]",
        "currentTime:", currentTime.toFixed(3),
        "adjustedTime:", adjustedTime.toFixed(3),
        "rawIndex:", rawIndex,
        "rawIndexTime:", rawIndex >= 0 ? transcriptEntries[rawIndex].time.toFixed(3) : null,
        "pendingClick:", pendingTranscriptClick,
        "finalIndex:", index,
        "finalIndexTime:", index >= 0 ? transcriptEntries[index].time.toFixed(3) : null,
        "finalIndexText:", index >= 0 ? transcriptEntries[index].text : null
    );

    if (index !== -1) {
        document.querySelectorAll('.transcript-item').forEach(e => e.classList.remove('active'));
        const el = document.getElementById(`transcript-${index}`);
        if (el) {
            el.classList.add('active');
            if (forceJump) {
                el.scrollIntoView({ behavior: 'auto', block: 'center' });
            }
        }
    }
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
            const listSelector = targetItem.classList.contains('comment-item') ? '.comment-item' : '.transcript-item';
            document.querySelectorAll(listSelector).forEach(e => e.classList.remove('active'));
            targetItem.classList.add('active');
            targetItem.scrollIntoView({ behavior: 'auto', block: 'center' });
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

    // ★デバッグ用ログ（原因特定のため。確認が終わったら削除してOK）
    console.log(
        "[transcript click]",
        "clicked sec:", sec,
        "clicked index:", index,
        "clicked text:", transcriptEntries[index] ? transcriptEntries[index].text : null
    );

    // クリックした行を即座にハイライト＆スクロール
    document.querySelectorAll('.transcript-item').forEach(e => e.classList.remove('active'));
    const el = document.getElementById(`transcript-${index}`);
    if (el) el.scrollIntoView({ behavior: 'auto', block: 'center' });
    if (el) el.classList.add('active');

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
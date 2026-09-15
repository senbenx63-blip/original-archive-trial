let player;
let comments = [];
let filteredComments = []; 

const urlParams = new URLSearchParams(window.location.search);
const VIDEO_ID = urlParams.get('v') || 'JKaIKUHjXQQ'; 
const DATA_FILE = (urlParams.get('d') || '011726') + '.json';
const LAG_ADJUSTMENT = parseInt(urlParams.get('s')) || 0;
// d パラメータの値（例: 072426_2）を元に .txt ファイル名を組み立て（txt パラメータでの個別上書きも可）
const TXT_FILE = urlParams.get('txt') || (urlParams.get('d') || '011726') + '.txt';

// YouTube API
const tag = document.createElement('script');
tag.src = "https://www.youtube.com/iframe_api";
document.body.appendChild(tag);

function onYouTubeIframeAPIReady() {
    player = new YT.Player('player', {
        height: '450',
        width: '100%',
        videoId: VIDEO_ID,
        playerVars: {
            'start': LAG_ADJUSTMENT,
            'playsinline': 1
        },
        events: {
            'onReady': () => {
                loadData(); 
                loadTranscript(); // 文字起こし(TXT)の読み込み
                setupTranscriptUI(); // トグルボタンと文字起こしエリアの生成
                startTracking();
            },
            'onStateChange': (event) => {
                // シークバーを操作して再生が始まった、あるいは一時停止した際、
                // 強制的に今の時間のコメントまでジャンプさせる
                if (event.data === YT.PlayerState.PLAYING || event.data === YT.PlayerState.PAUSED) {
                    updateActiveComment(true); // 引数 true でパッと移動
                }
            }
        }
    });
}

async function loadData() {
    try {
        const response = await fetch(DATA_FILE);
        const data = await response.json();
        comments = data.comments; 
        filteredComments = comments; 
        renderComments();
        updateCount(); 
        initSearch(); 
    } catch (error) {
        console.error("データの読み込み失敗:", error);
    }
}

/* ==========================================
 * 文字起こし (TXT) 関連の処理
 * ========================================== */

// トグルボタンと文字起こし表示エリアを動的に構築
function setupTranscriptUI() {
    const commentListContainer = document.getElementById('commentList');
    if (!commentListContainer) return;

    // トグルボタンの生成と挿入
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
            }
        });

        syncBtn.parentNode.insertBefore(toggleBtn, syncBtn.nextSibling);
    }

    // 文字起こしエリアの生成（高さ: 縦の3分の2 / 初期非表示）
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

// TXTファイルの読み込みと解析
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

// TXTテキスト（タイムスタンプと発言のペア）を画面にレンダリング
function renderTranscript(txtText) {
    const container = document.getElementById('transcriptContainer');
    if (!container) return;

    // 行ごとに分割し、余白をトリムして空行を除外
    const lines = txtText.split(/\r?\n/).map(line => line.trim()).filter(line => line !== '');
    let html = '';

    // 2行セット（1行目: タイムスタンプ, 2行目: テキスト）でループ処理
    for (let i = 0; i < lines.length; i += 2) {
        const timeStr = lines[i];
        const captionText = lines[i + 1];

        if (timeStr && captionText) {
            const seconds = parseTimeToSeconds(timeStr);
            
            html += `
                <div class="transcript-item" style="margin-bottom: 8px; font-size: 0.9em; line-height: 1.4;">
                    <span class="transcript-time" onclick="seekTo(${seconds}, this)" 
                          style="cursor: pointer; color: #6441a5; font-weight: bold; margin-right: 8px;">
                        ${formatTime(seconds)}
                    </span>
                    <span class="transcript-text">${captionText}</span>
                </div>
            `;
        }
    }

    container.innerHTML = html;
}

// タイムスタンプ ("00:00" または "00:00:00") を秒数に変換
function parseTimeToSeconds(timeString) {
    const parts = timeString.split(':').map(Number);
    if (parts.length === 2) {
        return parts[0] * 60 + parts[1];
    } else if (parts.length === 3) {
        return parts[0] * 3600 + parts[1] * 60 + parts[2];
    }
    return 0;
}

/* ========================================== */

function updateCount() {
    const countEl = document.getElementById('searchCount');
    if (countEl) {
        countEl.innerText = `${filteredComments.length}件`;
    }
}

function initSearch() {
    const searchInput = document.getElementById('commentSearch');
    if (!searchInput) return;
    searchInput.addEventListener('input', (e) => {
        const term = e.target.value.trim().toLowerCase();
        
        if (term === "") {
            filteredComments = comments;
        } else {
            filteredComments = comments.filter(c => {
                const displayName = (c.commenter.display_name || "").toLowerCase();
                const userId = (c.commenter.name || "").toLowerCase();
                const message = (c.message.body || "").toLowerCase();
                return displayName.includes(term) || userId.includes(term) || message.includes(term);
            });
        }
        renderComments();
        updateCount();
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

// 強制移動用の引数 forceJump を追加
function updateActiveComment(forceJump = false) {
    if (!player || !player.getCurrentTime) return;
    const currentTime = player.getCurrentTime();
    const index = filteredComments.findLastIndex(c => c.content_offset_seconds <= (currentTime - LAG_ADJUSTMENT));
    
    if (index !== -1) {
        document.querySelectorAll('.comment-item').forEach(e => e.classList.remove('active'));
        const el = document.getElementById(`comment-${index}`);
        if (el) {
            el.classList.add('active');
            
            // forceJumpがtrue（シーク操作時）のみ、パッと中央に移動させる
            if (forceJump) {
                el.scrollIntoView({ behavior: 'auto', block: 'center' });
            }
        }
    }
}

function startTracking() {
    // 追従モード（背景色変更のみ）を0.5秒おきに実行
    setInterval(() => updateActiveComment(false), 500);
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
    player.seekTo(sec, true);
    // 時間リンクをクリックした時もパッと移動させる
    setTimeout(() => updateActiveComment(true), 100);
}

const syncBtn = document.getElementById('syncBtn');
if (syncBtn) {
    syncBtn.addEventListener('click', () => {
        // 同期ボタンを押した際もパッと中央に移動
        updateActiveComment(true);
    });
}
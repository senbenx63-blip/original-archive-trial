let player;
let isTwitch = false; // Twitchプレイヤー判定用
let comments = [];
let filteredComments = []; 
let isSeeking = false; // シーク直後の自動追従ガードフラグ
let transcriptEntries = []; // ★追加：文字起こしの時間データを保持

const urlParams = new URLSearchParams(window.location.search);
const VIDEO_ID = urlParams.get('v') || 'JKaIKUHjXQQ'; 
const RAW_D = urlParams.get('d') || '011726';
const LAG_ADJUSTMENT = parseInt(urlParams.get('s')) || 0;

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
            // Twitchプレイヤー必須パラメータ（現在のドメインを自動設定）
            parent: [window.location.hostname || 'localhost']
        };
        
        player = new Twitch.Player('player', options);

        player.addEventListener(Twitch.Player.READY, () => {
            loadData(); 
            loadTranscript(); // 文字起こし(TXT)の読み込み
            setupTranscriptUI(); // トグルボタンと文字起こしエリアの生成
            startTracking();
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
        const match = line.match(/^\[(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?\]\s*(.*)/);
        
        if (match) {
            const hours = parseInt(match[1], 10);
            const minutes = parseInt(match[2], 10);
            const seconds = parseInt(match[3], 10);
            const textContent = match[4].trim();

            // 合計秒数を計算
            const totalSeconds = hours * 3600 + minutes * 60 + seconds;

            if (textContent) {
                const index = transcriptEntries.length; // ★このエントリのインデックス
                transcriptEntries.push({ time: totalSeconds, text: textContent }); // ★追加

                html += `
                    <div class="transcript-item" id="transcript-${index}" style="margin-bottom: 8px; font-size: 0.9em; line-height: 1.4;">
                        <span class="transcript-time" onclick="seekTo(${totalSeconds}, this)" 
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
    const index = transcriptEntries.findLastIndex(t => t.time <= (currentTime - LAG_ADJUSTMENT));

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

const syncBtn = document.getElementById('syncBtn');
if (syncBtn) {
    syncBtn.addEventListener('click', () => {
        updateActiveDisplay(true); // ★変更：同期ボタンで両方スクロール
    });
}
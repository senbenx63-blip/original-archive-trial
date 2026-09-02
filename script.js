let player;
let comments = [];
let filteredComments = []; 

const urlParams = new URLSearchParams(window.location.search);
const VIDEO_ID = urlParams.get('v') || 'JKaIKUHjXQQ'; 
const DATA_FILE = (urlParams.get('d') || '011726') + '.json';
const LAG_ADJUSTMENT = parseInt(urlParams.get('s')) || 0;

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

function updateCount() {
    const countEl = document.getElementById('searchCount');
    if (countEl) {
        countEl.innerText = `${filteredComments.length}件`;
    }
}

function initSearch() {
    const searchInput = document.getElementById('commentSearch');
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

document.getElementById('syncBtn').addEventListener('click', () => {
    // 同期ボタンを押した際もパッと中央に移動
    updateActiveComment(true);
});
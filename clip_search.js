const SHEET_ID = '1yubpjM0sqNAjwRMCoiWDgdTeTrB8zZ2YyomA-z2fvVg';
const SHEET_NAME = 'シート2'; 
const CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(SHEET_NAME)}`;

const ITEMS_PER_PAGE = 100; 
const MAX_TOTAL_ITEMS = 1000;

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

async function initData() {
    try {
        const response = await fetch(CSV_URL);
        const csvText = await response.text();
        const rows = csvText.split('\n').slice(1);
        
        allData = rows.map(row => {
            const cols = row.match(/(".*?"|[^",\s]+)(?=\s*,|\s*$)/g);
            if (!cols || cols.length < 8) return null;
            const clean = cols.map(c => c.replace(/^"|"$/g, '').trim());
            const timeValue = new Date(clean[0].replace(/\//g, '-')).getTime();
            
            return {
                dateTime: clean[0], time: timeValue, title: clean[1],
                url: clean[2], thumb: clean[3], views: parseInt(clean[4]) || 0,
                creator: clean[5], category: clean[6], duration: clean[7]
            };
        }).filter(c => c !== null && !isNaN(c.time));
    } catch (e) {
        document.getElementById('count').innerText = "データの読み込みに失敗しました。";
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

initData();
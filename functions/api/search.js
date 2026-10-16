// /api/search  (Cloudflare Pages Functions + D1)  ―― 公開サイト用の「読み取りを抑える」版
//
// 使うD1の列は、元の search.js と同じものだけ:
//   streams            : stream_key, title, youtube_video_id, stream_date
//   chat_messages      : body, offset_seconds, stream_key        (全文検索: chat_fts)
//   transcript_segments: id, text, start_seconds, stream_key     (全文検索: transcript_fts)
//
// D1の無料枠(1日500万行の読み取り)を、多くの人が使っても使い切らないための仕様:
//   1. 検索ワードは最大5個。3文字以上の単語を最低1つ含める(短い単語は、3文字以上の単語と一緒の時だけ追加条件として使える)
//   2. 3文字以上の単語でヒットした候補が MAX_CANDIDATES 件を超えたら、結果は出さず「絞り込んでください」と返す
//   3. 表示は最大 MAX_RESULTS 件(新しい配信順)
//   4. 検索ワード空欄 = 最新の配信1本分だけ一覧表示
//   5. 同じ条件の検索結果は1時間Cloudflare側に保存して使い回す(D1を読まない)
//
// パラメータ: q(検索ワード) / start, end(配信日 YYYY-MM-DD) / source(chat|transcript|all。画面からは chat か transcript)
//            / commenter(チャットしたユーザー名で絞る。部分一致。チャット検索のみ。検索ワード空欄なら、そのユーザーの最新の発言を表示)

const MAX_TERMS = 5;
const MIN_LONG_TERM = 3;          // この文字数以上の単語で検索の候補を絞る(trigram検索の仕組み上、これ未満の単語は索引を使えない)
const MAX_CANDIDATES = 2000;      // 候補がこれを超えたら「絞り込んでください」
const MAX_RESULTS = 50;
const MAX_QUERY_LENGTH = 100;
const MAX_COMMENTER_LENGTH = 30;   // ユーザー名(部分一致)の最大文字数
const MAX_COMMENTER_MATCHES = 10;  // ユーザー名だけで検索する時、該当するユーザーがこの人数を超えたら「絞り込んでください」
// ユーザー名だけの検索に必要な索引(D1で1回だけ作る):
//   CREATE INDEX idx_chat_user_time ON chat_messages(user_id, created_at);
const USER_INDEX_NAME = "idx_chat_user_time";
const CACHE_SECONDS = 3600;

// ★チャットしたユーザー名の取得設定(D1の実際の列名に合わせてここだけ直せばOK)
//   chat_messages.COMMENTER_KEY_COL  ↔  COMMENTER_TABLE.COMMENTER_KEY_COL  で結び付け、
//   COMMENTER_TABLE.COMMENTER_NAME_COL を表示名として使う
const COMMENTER_TABLE = "commenters";
const COMMENTER_KEY_COL = "user_id";
const COMMENTER_NAME_COL = "display_name";
const COMMENTER_FALLBACK_COL = "login_name"; // 表示名が空の人はこちらを使う

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };

function jsonResponse(body, status = 200, cacheable = false) {
  const headers = { ...JSON_HEADERS };
  if (cacheable) headers["Cache-Control"] = `public, max-age=${CACHE_SECONDS}`;
  return new Response(JSON.stringify(body), { status, headers });
}

// LIKE で % _ \ を普通の文字として扱うためのエスケープ(ESCAPE '\' とセットで使う)
function escapeLike(s) {
  return s.replace(/[\\%_]/g, (m) => "\\" + m);
}

// スペース(半角・全角)区切りで単語に分割
function parseTerms(q) {
  return q.trim().split(/[ \u3000]+/).filter((t) => t);
}

function formatRow(row, source) {
  const seconds = Math.floor(row.offset_seconds || 0);
  return {
    source, // "chat" または "transcript"
    text: row.text,
    user_name: row.user_name ?? null, // チャットの時だけ値が入る
    offset_seconds: seconds,
    stream_key: row.stream_key,
    title: row.title ?? null,
    stream_date: row.stream_date ?? null,
    youtube_url: row.youtube_video_id
      ? `https://youtu.be/${row.youtube_video_id}?t=${seconds}`
      : null,
  };
}

// 読み取った行数をログに出す(Cloudflareの「Workersのログ」で確認できる。上限の調整に使う)
function logRowsRead(label, meta) {
  if (meta && typeof meta.rows_read === "number") console.log(`[search] ${label} rows_read=${meta.rows_read}`);
}

// ---- 検索ワードあり: 候補を MAX_CANDIDATES+1 件までで打ち切ってから絞り込む ----
// 戻り値: { overflow: boolean, rows: [...] }
async function searchBySource(db, kind, longTerms, shortTerms, dateCond, dateParams, commenter) {
  const isChat = kind === "chat";
  const ftsTable = isChat ? "chat_fts" : "transcript_fts";
  const textCol = isChat ? "c.body" : "t.text";

  const matchQuery = longTerms.map((t) => `"${t.replace(/"/g, '""')}"`).join(" AND ");
  const shortCond = shortTerms.map(() => ` AND ${textCol} LIKE ?`).join("");
  const shortParams = shortTerms.map((t) => `%${t}%`);

  // ユーザー名で絞る(チャットのみ)。FTSで見つけた候補(最大 MAX_CANDIDATES 件)の中から絞り込む
  const useUser = isChat && commenter;
  const userCond = useUser
    ? ` AND (cm.${COMMENTER_NAME_COL} LIKE ? ESCAPE '\\' OR cm.${COMMENTER_FALLBACK_COL} LIKE ? ESCAPE '\\')`
    : "";
  const userParams = useUser ? [`%${escapeLike(commenter)}%`, `%${escapeLike(commenter)}%`] : [];

  // cand: 索引で見つかった候補(rowidだけ)。MAX_CANDIDATES+1件で打ち切る
  // res : 候補が上限以内の時だけ、日付・短い単語で絞って、新しい順に MAX_RESULTS+1 件
  const body = isChat
    ? `SELECT c.body AS text, COALESCE(cm.${COMMENTER_NAME_COL}, cm.${COMMENTER_FALLBACK_COL}) AS user_name, c.offset_seconds, c.stream_key, s.title, s.youtube_video_id, s.stream_date
       FROM cand
       JOIN chat_messages c ON c.rowid = cand.rid
       JOIN streams s ON s.stream_key = c.stream_key
       LEFT JOIN ${COMMENTER_TABLE} cm ON cm.${COMMENTER_KEY_COL} = c.${COMMENTER_KEY_COL}
       WHERE (SELECT COUNT(*) FROM cand) <= ${MAX_CANDIDATES} ${shortCond} ${userCond} ${dateCond}
       ORDER BY s.stream_date DESC, c.offset_seconds
       LIMIT ${MAX_RESULTS + 1}`
    : `SELECT t.text AS text, t.start_seconds AS offset_seconds, t.stream_key, s.title, s.youtube_video_id, s.stream_date
       FROM cand
       JOIN transcript_segments t ON t.id = cand.rid
       JOIN streams s ON s.stream_key = t.stream_key
       WHERE (SELECT COUNT(*) FROM cand) <= ${MAX_CANDIDATES} ${shortCond} ${dateCond}
       ORDER BY s.stream_date DESC, t.start_seconds
       LIMIT ${MAX_RESULTS + 1}`;

  const sql = `
    WITH cand AS MATERIALIZED (
      SELECT rowid AS rid FROM ${ftsTable} WHERE ${ftsTable} MATCH ? LIMIT ${MAX_CANDIDATES + 1}
    ),
    res AS (${body})
    SELECT (SELECT COUNT(*) FROM cand) AS cand_count, res.*
    FROM (SELECT 1) AS one LEFT JOIN res ON 1 = 1`;

  const out = await db.prepare(sql).bind(matchQuery, ...shortParams, ...userParams, ...dateParams).all();
  logRowsRead(kind, out.meta);

  const all = out.results || [];
  const candCount = all.length ? all[0].cand_count : 0;
  if (candCount > MAX_CANDIDATES) return { overflow: true, rows: [] };

  // 結果が0件の時は、res側が全部NULLの行が1つだけ返ってくる
  const rows = all.filter((r) => r.stream_key !== null && r.stream_key !== undefined).map((r) => formatRow(r, kind));
  return { overflow: false, rows };
}

// ---- ユーザー名だけ指定: そのユーザーの最新の発言を MAX_RESULTS 件 ----
// 索引 (user_id, created_at) を使うので、読む行数はユーザーの発言数に関係なく、表示する件数くらいで済む。
// 戻り値: { error } か { rows, truncated }
async function latestByCommenter(db, commenter, dateCond, dateParams) {
  // 索引がまだ無い時に実行すると、チャット全件を読んでしまうので、必ず先に確認する
  const idx = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?").bind(USER_INDEX_NAME).all();
  if (!(idx.results || []).length) {
    return { error: "ユーザー名だけの検索はまだ準備中です(管理者向け: D1に索引 " + USER_INDEX_NAME + " を作成してください)" };
  }

  // 該当するユーザーを探す(commenters は小さいテーブルなので全体を見ても軽い)
  const pat = `%${escapeLike(commenter)}%`;
  const usersOut = await db
    .prepare(
      `SELECT user_id FROM ${COMMENTER_TABLE}
       WHERE ${COMMENTER_NAME_COL} LIKE ? ESCAPE '\\' OR ${COMMENTER_FALLBACK_COL} LIKE ? ESCAPE '\\'
       LIMIT ${MAX_COMMENTER_MATCHES + 1}`
    )
    .bind(pat, pat)
    .all();
  logRowsRead("commenter-users", usersOut.meta);
  const userIds = (usersOut.results || []).map((r) => r[COMMENTER_KEY_COL]);
  if (userIds.length === 0) return { rows: [], truncated: false };
  if (userIds.length > MAX_COMMENTER_MATCHES) {
    return { error: `「${commenter}」に当てはまるユーザーが${MAX_COMMENTER_MATCHES}人を超えています。ユーザー名をもう少し長く入力してください。` };
  }

  // ユーザーごとに「最新の発言 MAX_RESULTS+1 件」を取り、まとめてもう一度新しい順に並べる
  const one = `SELECT * FROM (
      SELECT c.body AS text, COALESCE(cm.${COMMENTER_NAME_COL}, cm.${COMMENTER_FALLBACK_COL}) AS user_name,
             c.offset_seconds, c.stream_key, c.created_at, s.title, s.youtube_video_id, s.stream_date
      FROM chat_messages c
      JOIN streams s ON s.stream_key = c.stream_key
      JOIN ${COMMENTER_TABLE} cm ON cm.${COMMENTER_KEY_COL} = c.${COMMENTER_KEY_COL}
      WHERE c.${COMMENTER_KEY_COL} = ? ${dateCond}
      ORDER BY c.created_at DESC
      LIMIT ${MAX_RESULTS + 1})`;
  const sql = `SELECT * FROM (${userIds.map(() => one).join(" UNION ALL ")}) ORDER BY created_at DESC LIMIT ${MAX_RESULTS + 1}`;
  const params = userIds.flatMap((id) => [id, ...dateParams]);

  const out = await db.prepare(sql).bind(...params).all();
  logRowsRead("commenter-latest", out.meta);
  const all = out.results || [];
  return { rows: all.slice(0, MAX_RESULTS).map((r) => formatRow(r, "chat")), truncated: all.length > MAX_RESULTS };
}

// ---- 検索ワード空欄: 最新の配信1本分だけ、終わりの方から表示 ----
async function latestStream(db, source, startDate, endDate) {
  let dateCond = "";
  const dateParams = [];
  if (startDate) { dateCond += " AND stream_date >= ?"; dateParams.push(startDate); }
  if (endDate) { dateCond += " AND stream_date <= ?"; dateParams.push(endDate); }

  const streamOut = await db
    .prepare(
      `SELECT stream_key, stream_date, title, youtube_video_id
       FROM streams
       WHERE stream_date IS NOT NULL ${dateCond}
       ORDER BY stream_date DESC
       LIMIT 1`
    )
    .bind(...dateParams)
    .all();
  logRowsRead("latest-stream", streamOut.meta);
  const s = (streamOut.results || [])[0];
  if (!s) return [];

  const wantChat = source === "all" || source === "chat";
  const wantTranscript = source === "all" || source === "transcript";
  const perSource = wantChat && wantTranscript ? Math.floor(MAX_RESULTS / 2) : MAX_RESULTS;

  const attach = (row) => ({ ...row, title: s.title, stream_date: s.stream_date, stream_key: s.stream_key, youtube_video_id: s.youtube_video_id });
  const tasks = [];

  if (wantChat) {
    tasks.push(
      db.prepare(
        `SELECT c.body AS text, COALESCE(cm.${COMMENTER_NAME_COL}, cm.${COMMENTER_FALLBACK_COL}) AS user_name, c.offset_seconds
         FROM chat_messages c
         LEFT JOIN ${COMMENTER_TABLE} cm ON cm.${COMMENTER_KEY_COL} = c.${COMMENTER_KEY_COL}
         WHERE c.stream_key = ?
         ORDER BY c.offset_seconds DESC
         LIMIT ?`
      ).bind(s.stream_key, perSource).all()
        .then((o) => { logRowsRead("latest-chat", o.meta); return o.results.map((r) => formatRow(attach(r), "chat")); })
    );
  }
  if (wantTranscript) {
    tasks.push(
      db.prepare(
        `SELECT t.text AS text, t.start_seconds AS offset_seconds
         FROM transcript_segments t
         WHERE t.stream_key = ?
         ORDER BY t.start_seconds DESC
         LIMIT ?`
      ).bind(s.stream_key, perSource).all()
        .then((o) => { logRowsRead("latest-transcript", o.meta); return o.results.map((r) => formatRow(attach(r), "transcript")); })
    );
  }
  return (await Promise.all(tasks)).flat();
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  const q = (url.searchParams.get("q") || "").trim();
  const startDate = (url.searchParams.get("start") || "").trim();
  const endDate = (url.searchParams.get("end") || "").trim();
  let source = (url.searchParams.get("source") || "all").trim();
  let commenter = (url.searchParams.get("commenter") || "").trim();

  // ---- 入力チェック(D1は読まない) ----
  if (!["all", "chat", "transcript"].includes(source)) source = "all";
  if (q.length > MAX_QUERY_LENGTH) {
    return jsonResponse({ error: "検索ワードが長すぎます" }, 400);
  }
  if (commenter.length > MAX_COMMENTER_LENGTH) {
    return jsonResponse({ error: `ユーザー名は${MAX_COMMENTER_LENGTH}文字までにしてください` }, 400);
  }
  if (source === "transcript") commenter = ""; // 字幕にはユーザー名がないので無視する
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  if ((startDate && !dateRe.test(startDate)) || (endDate && !dateRe.test(endDate))) {
    return jsonResponse({ error: "日付の形式が正しくありません" }, 400);
  }

  const terms = parseTerms(q);
  if (terms.length > MAX_TERMS) {
    return jsonResponse({ error: `検索ワードは${MAX_TERMS}個までにしてください` }, 400);
  }
  const longTerms = terms.filter((t) => [...t].length >= MIN_LONG_TERM);
  const shortTerms = terms.filter((t) => [...t].length < MIN_LONG_TERM);

  if (terms.length > 0 && longTerms.length === 0) {
    return jsonResponse({ error: `${MIN_LONG_TERM}文字以上の単語を1つ以上含めてください(短い単語は、${MIN_LONG_TERM}文字以上の単語と一緒に使えます)` }, 400);
  }

  // ---- キャッシュ(同じ条件の検索はD1を読まずに返す) ----
  const canonical = new URL(`${url.origin}/api/search`);
  canonical.searchParams.set("v", "4"); // 返すデータの形を変えたら数字を上げる(古い保存結果を使わないため)
  canonical.searchParams.set("q", terms.join(" "));
  canonical.searchParams.set("source", source);
  if (commenter) canonical.searchParams.set("commenter", commenter);
  if (startDate) canonical.searchParams.set("start", startDate);
  if (endDate) canonical.searchParams.set("end", endDate);
  const cacheKey = new Request(canonical.toString(), { method: "GET" });
  const cache = typeof caches !== "undefined" ? caches.default : null;

  if (cache) {
    try {
      const hit = await cache.match(cacheKey);
      if (hit) return hit;
    } catch (e) { /* キャッシュが使えなくても検索は続ける */ }
  }

  const respond = (body) => {
    const res = jsonResponse(body, 200, true);
    if (cache) {
      try { context.waitUntil(cache.put(cacheKey, res.clone())); } catch (e) { /* 無視 */ }
    }
    return res;
  };

  try {
    // 検索ワード空欄 + ユーザー名あり: そのユーザーの最新の発言
    if (terms.length === 0 && commenter) {
      let dc = "";
      const dp = [];
      if (startDate) { dc += " AND s.stream_date >= ?"; dp.push(startDate); }
      if (endDate) { dc += " AND s.stream_date <= ?"; dp.push(endDate); }
      const out = await latestByCommenter(env.DB, commenter, dc, dp);
      if (out.error) return jsonResponse({ error: out.error }, 400); // エラーは保存しない
      const rows = out.rows.sort((a, b) => {
        const da = a.stream_date || "", db_ = b.stream_date || "";
        if (da !== db_) return da < db_ ? 1 : -1;
        return a.offset_seconds - b.offset_seconds;
      });
      return respond({ query: q, mode: "commenter", count: rows.length, truncated: out.truncated, results: rows });
    }

    // 検索ワード空欄: 最新の配信1本分
    if (terms.length === 0) {
      const results = await latestStream(env.DB, source, startDate, endDate);
      return respond({ query: q, mode: "latest", count: results.length, truncated: false, results });
    }

    let dateCond = "";
    const dateParams = [];
    if (startDate) { dateCond += " AND s.stream_date >= ?"; dateParams.push(startDate); }
    if (endDate) { dateCond += " AND s.stream_date <= ?"; dateParams.push(endDate); }

    const wantChat = source === "all" || source === "chat";
    const wantTranscript = (source === "all" || source === "transcript") && !commenter; // ユーザー名で絞る時は字幕は対象外

    const tasks = [];
    if (wantChat) tasks.push(searchBySource(env.DB, "chat", longTerms, shortTerms, dateCond, dateParams, commenter));
    if (wantTranscript) tasks.push(searchBySource(env.DB, "transcript", longTerms, shortTerms, dateCond, dateParams));
    const outs = await Promise.all(tasks);

    // 候補が多すぎる対象があれば、結果は出さずに絞り込みをお願いする
    const overflowed = [];
    let idx = 0;
    if (wantChat) { if (outs[idx].overflow) overflowed.push("チャット"); idx++; }
    if (wantTranscript) { if (outs[idx].overflow) overflowed.push("字幕"); idx++; }
    if (overflowed.length > 0) {
      return respond({
        error: `${overflowed.join("・")}のヒットが${MAX_CANDIDATES.toLocaleString("en-US")}件を超えています。` +
          (commenter ? "(ユーザー名で絞る前の件数です)" : "") + "単語を足して絞り込んでください。",
        overflow: true,
      });
    }

    // 新しい配信順(同じ配信なら時刻順)にまとめて MAX_RESULTS 件まで
    const merged = outs.flatMap((o) => o.rows).sort((a, b) => {
      const da = a.stream_date || "", db_ = b.stream_date || "";
      if (da !== db_) return da < db_ ? 1 : -1;
      return a.offset_seconds - b.offset_seconds;
    });
    const truncated = merged.length > MAX_RESULTS;
    const results = merged.slice(0, MAX_RESULTS);

    return respond({ query: q, mode: "search", count: results.length, truncated, results });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
}
#!/usr/bin/env python3
"""チャットtxt([UTC日時] #ch ID: 本文) → サイト用の軽量版JSON(json_slim)に変換する。

名簿は「数字のユーザーID」を基準に、既存の元形式JSON(Twitch由来)から作る。
  表示名・ログイン名 … 一番新しく取得されたJSON(ファイル内の作成日時)のもの
  色               … そのユーザーの一番新しいコメントのもの(空でない最新の色)
  ログイン名の履歴   … そのIDが過去に使った全ログイン名(txtの古いIDも引けるようにする)
※ 軽量版JSONには数字のIDが無いので、名簿には使わない(エモート対応表にだけ使う)

使い方(このファイルを original archive trial に置き、そのフォルダで):
  python txt_to_slim.py
  → chat_txt の *.txt を変換し、json の全年号フォルダのJSONから名簿を作り、json\\20YY\\ に出力する
  (場所を変えたいときだけ --starts / --emotes / --out-dir などで指定)

  ・txtのファイル名(例 021026)が、開始時刻ファイルの先頭の列(MMDDYY)と対応する
  ・開始時刻ファイルは日本時間(JST)、txt内の日時は UTC として扱う(--start-tz / --txt-tz で変更)
  ・出力は既定で <out-dir>/20YY/<名前>.json 、--slim-dirs なら <out-dir>/json_slim/20YY/<名前>.json
"""
import argparse, glob, json, os, re
from datetime import datetime, timedelta, timezone

LINE = re.compile(r'^\[(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)\] #(\S+) ([^:]+): (.*)$')
# 視聴継続のお知らせ: 「表示名 watched N consecutive streams and sparked a watch streak! (任意のコメント)」
STREAK = re.compile(r'^(.+?) watched \d+ consecutive streams and sparked a watch streak!\s*(.*)$')
BASE = os.path.dirname(os.path.abspath(__file__))   # このスクリプトがあるフォルダ(original archive trial)
ISO = re.compile(r'^(\d{4}-\d\d-\d\d)[T ](\d\d:\d\d:\d\d)(?:\.\d+)?\s*(Z|[+-]\d\d:?\d\d)?$')


def parse_iso(s):
    """ISO日時 → UTCのnaive datetime。小数点以下が7桁でも読める。失敗したら None"""
    m = ISO.match(s or '')
    if not m:
        return None
    dt = datetime.strptime(m.group(1) + ' ' + m.group(2), '%Y-%m-%d %H:%M:%S')
    tz = m.group(3)
    if tz and tz != 'Z':
        off = timedelta(hours=int(tz[1:3]), minutes=int(tz[-2:]))
        dt = dt - off if tz[0] == '+' else dt + off
    return dt


def load_starts(path, start_tz):
    starts = {}
    for line in open(path, encoding='utf-8'):
        m = re.match(r'^\s*(\d{6}(?:-\d+)?)\s+(\d{1,2}):(\d\d)\s*$', line)
        if not m:
            continue
        code, hh, mm = m.group(1), int(m.group(2)), int(m.group(3))
        month, day, yy = int(code[0:2]), int(code[2:4]), int(code[4:6])
        local = datetime(2000 + yy, month, day, hh, mm)
        starts[code] = local - timedelta(hours=start_tz)   # UTCに直す
    return starts


def load_reference(patterns, build_roster=True):
    """既存JSONから (エモート名→ID, 名簿, 元形式JSON数, 軽量版JSON数) を作る。
    名簿: 数字ID → {d:表示名, u:ログイン名, c:色, logins:[過去のログイン名...], last:最終発言日時}"""
    emap, users = {}, {}
    n_orig = n_slim = 0
    MIN = datetime.min
    for pat in patterns:
        for p in sorted(glob.glob(pat)):
            try:
                data = json.load(open(p, encoding='utf-8'))
            except Exception as e:
                print(f'  (reference: skip {p}: {e})')
                continue
            if not isinstance(data, dict):
                continue
            comments = data.get('comments') or []
            if data.get('v') == 1:                       # 軽量版: IDが無いのでエモートだけ使う
                n_slim += 1
                for c in comments:
                    for fr in c.get('f', []):
                        if isinstance(fr, list):
                            emap[fr[0]] = fr[1]
                continue
            n_orig += 1
            file_dt = (parse_iso((data.get('FileInfo') or {}).get('CreatedAt'))
                       or datetime.fromtimestamp(os.path.getmtime(p), timezone.utc).replace(tzinfo=None))
            for c in comments:
                m = c.get('message') or {}
                for fr in m.get('fragments') or []:
                    emo = fr.get('emoticon')
                    if emo and emo.get('emoticon_id'):
                        emap[fr['text']] = emo['emoticon_id']
                if not build_roster:
                    continue
                cm = c.get('commenter') or {}
                uid = str(cm.get('_id') or '')
                if not uid:
                    continue
                ct = parse_iso(c.get('created_at')) or MIN
                e = users.setdefault(uid, {'logins': set(), 'last': MIN, 'dkey': (MIN, MIN), 'ckey': MIN})
                login = (cm.get('name') or '').lower()
                if login:
                    e['logins'].add(login)
                if ct > e['last']:
                    e['last'] = ct
                # 表示名・ログイン名は「JSONを取得した時点」の値 → 新しいJSON、同じなら新しいコメントを優先
                key = (file_dt, ct)
                if cm.get('display_name') and key >= e['dkey']:
                    e['d'], e['dkey'] = cm['display_name'], key
                    if login:
                        e['u'] = login
                # 色はコメント投稿時の値 → 一番新しいコメントの(空でない)色
                if m.get('user_color') and ct >= e['ckey']:
                    e['c'], e['ckey'] = m['user_color'], ct
    roster = {}
    for uid, e in users.items():
        r = {'logins': sorted(e['logins']),
             'last': e['last'].strftime('%Y-%m-%dT%H:%M:%S') if e['last'] > MIN else ''}
        for k in ('d', 'u', 'c'):
            if e.get(k):
                r[k] = e[k]
        roster[uid] = r
    return emap, roster, n_orig, n_slim


def build_alias(roster):
    """ログイン名(過去のものも含む) → 数字ID。複数のIDが同じ名前を使っていた場合は、最後に発言した人を採用"""
    cand = {}
    for uid, r in roster.items():
        names = set(r.get('logins') or [])
        if r.get('u'):
            names.add(r['u'].lower())
        for lg in names:
            cand.setdefault(lg, []).append(uid)
    alias, ambiguous = {}, []
    for lg, uids in cand.items():
        if len(uids) > 1:
            ambiguous.append(lg)
            uids = sorted(uids, key=lambda x: roster[x].get('last', ''))
        alias[lg] = uids[-1]
    return alias, ambiguous


def to_fragments(body, emap):
    """本文を [文字列, [エモート名, ID], ...] に分割。エモートが無ければ None"""
    parts, buf, found = [], '', False
    for tok in re.split(r'(\s+)', body):
        if tok in emap:
            if buf:
                parts.append(buf)
                buf = ''
            parts.append([tok, emap[tok]])
            found = True
        else:
            buf += tok
    if buf:
        parts.append(buf)
    return parts if found else None


def convert(txt_path, start_utc, txt_tz, emap, roster, alias, title):
    rows = []
    for line in open(txt_path, encoding='utf-8').read().splitlines():
        m = LINE.match(line)
        if m:
            ts = datetime.strptime(m.group(1), '%Y-%m-%d %H:%M:%S') - timedelta(hours=txt_tz)
            rows.append([ts, m.group(3).strip(), m.group(4)])

    # 視聴継続のお知らせから、ログインID→表示名 を拾う(名簿に載っていない人の補助)
    display = {}
    for _, login, body in rows:
        s = STREAK.match(body)
        if s:
            display[login] = s.group(1).strip()

    comments, dropped_pre, dropped_notice = [], 0, 0
    for ts, login, body in rows:
        s = STREAK.match(body)
        if s:
            body = s.group(2).strip()
            if not body:
                dropped_notice += 1
                continue
        t = round((ts - start_utc).total_seconds())
        if t < 0:                    # 配信開始前のチャットは、Twitchのチャットリプレイにも無いので除外
            dropped_pre += 1
            continue
        uid = alias.get(login.lower())
        r = roster.get(uid, {}) if uid else {}
        d = r.get('d') or display.get(login) or login     # 名簿(最新) > お知らせから拾った名前 > ログインID
        u = r.get('u') or login                           # 最新のログイン名
        item = {'t': t, 'd': d, 'b': body}
        if d != u:
            item['u'] = u
        if r.get('c'):
            item['c'] = r['c']
        frag = to_fragments(body, emap) if emap else None
        if frag:
            item['f'] = frag
        comments.append(item)
    comments.sort(key=lambda c: c['t'])
    logins = {r[1].lower() for r in rows}
    known = sum(1 for lg in logins if lg in alias)
    return {'v': 1, 'title': title, 'comments': comments}, dropped_pre, dropped_notice, len(logins), known


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('txt', nargs='*', default=[os.path.join(BASE, 'chat_txt', '*.txt')],
                    help='変換するtxt(省略時: chat_txt\\*.txt)')
    ap.add_argument('--starts', default=os.path.join(BASE, 'chat_txt', 'streaming_start_time.txt'),
                    help='開始時刻ファイル(省略時: chat_txt\\streaming_start_time.txt)')
    ap.add_argument('--emotes', nargs='*', default=[os.path.join(BASE, 'json', '*', '*.json')],
                    help='名簿とエモート対応表を作る既存JSON(省略時: json\\*\\*.json)')
    ap.add_argument('--save-roster', default=os.path.join(BASE, 'roster.json'),
                    help='作った名簿の保存先(省略時: roster.json)')
    ap.add_argument('--roster', default='', help='名簿をJSONから作らず、保存済みの名簿(手直し後)を使う')
    ap.add_argument('--out-dir', default=os.path.join(BASE, 'json'), help='出力先(省略時: json)')
    ap.add_argument('--year-dirs', action='store_true', help='(互換用。今は既定の動作です)')
    ap.add_argument('--slim-dirs', action='store_true',
                    help='出力を <out-dir>/json_slim/20YY/ にする(既定は <out-dir>/20YY/)')
    ap.add_argument('--overwrite', action='store_true', help='同名の出力ファイルがあっても上書きする(既定はスキップ)')
    ap.add_argument('--start-tz', type=float, default=9, help='開始時刻ファイルのUTC差(JST=9)')
    ap.add_argument('--txt-tz', type=float, default=0, help='txt内日時のUTC差(UTC=0)')
    ap.add_argument('--title-prefix', default='')
    a = ap.parse_args()

    starts = load_starts(a.starts, a.start_tz)
    emap, roster, n_orig, n_slim = load_reference(a.emotes, build_roster=not a.roster)
    if a.roster:
        roster = json.load(open(a.roster, encoding='utf-8')).get('users', {})
    alias, ambiguous = build_alias(roster)
    if a.save_roster:
        with open(a.save_roster, 'w', encoding='utf-8') as f:
            json.dump({'users': roster}, f, ensure_ascii=False, indent=1, sort_keys=True)
    print(f'開始時刻 {len(starts)}件 / エモート対応 {len(emap)}種')
    print(f'名簿 {len(roster)}人 (元形式JSON {n_orig}本から作成 / 軽量版JSON {n_slim}本は名簿には使わず)')
    if ambiguous:
        print(f'  注意: 複数のIDが使っていたログイン名が {len(ambiguous)}件あります(最後に発言した人を採用)')

    files = []
    for pat in a.txt:                       # Windowsのcmdは * を展開しないので、ここで展開する
        files += sorted(glob.glob(pat)) or [pat]
    for p in files:
        code = os.path.splitext(os.path.basename(p))[0]
        if not re.match(r'^\d{6}(-\d+)?$', code):
            print(f'[skip] {os.path.basename(p)}: 配信日の名前(例 021026)ではないので対象外')
            continue
        key = code if code in starts else re.sub(r'-\d+$', '', code)
        if key not in starts:
            print(f'[skip] {code}: 開始時刻ファイルに該当なし')
            continue
        yy = re.match(r'^\d{4}(\d\d)', code)
        year = f'20{yy.group(1)}' if yy else ''
        folder = os.path.join(a.out_dir, 'json_slim', year) if a.slim_dirs else os.path.join(a.out_dir, year)
        dest = os.path.join(folder, code + '.json')
        if os.path.exists(dest) and not a.overwrite:
            print(f'[skip] {code}: {dest} が既にあるので上書きしません(--overwrite で上書き)')
            continue
        out, pre, notice, n_users, known = convert(
            p, starts[key], a.txt_tz, emap, roster, alias, a.title_prefix + code if a.title_prefix else '')
        os.makedirs(folder, exist_ok=True)
        with open(dest, 'w', encoding='utf-8') as f:
            json.dump(out, f, ensure_ascii=False, separators=(',', ':'))
        cs = out['comments']
        n_emo = sum(1 for c in cs if 'f' in c)
        print(f'[ok] {code}: {len(cs)}件 (エモート付き{n_emo}件, 開始前除外{pre}件, お知らせ除外{notice}件) → {dest}')
        print(f'     名簿に載っていたユーザー {known}/{n_users}人(載っていない人は表示名=ログインID・色=灰色)')


if __name__ == '__main__':
    main()

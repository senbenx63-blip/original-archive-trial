-- D1の全テーブルを削除する(FTS → 子テーブル → 親テーブルの順)
-- トリガーはテーブルと一緒に消えます
DROP TABLE IF EXISTS chat_fts;
DROP TABLE IF EXISTS transcript_fts;
DROP TABLE IF EXISTS chat_messages;
DROP TABLE IF EXISTS transcript_segments;
DROP TABLE IF EXISTS commenters;
DROP TABLE IF EXISTS streams;

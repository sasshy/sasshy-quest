# SASSHY v2

SASSHY QUESTの安定化版です。旧版とは別のURL・IndexedDB・Supabaseテーブルを使い、旧版のデータを上書きしません。

## 設計上の約束

- 端末での編集は最初にIndexedDBへ保存する
- 同期失敗でローカルデータを変更しない
- クラウドはタスク・メモ・作業記録を1件ずつ同期する
- 削除はゴミ箱への移動とし、履歴から復元できる
- タイマーの実績時間とカレンダーの予定時間を分離する
- カレンダー操作中は自動同期を保留する

## 開発

```bash
pnpm install
pnpm test
pnpm build
```

## Supabase

設定画面の「初期化SQLをコピー」または `supabase-setup.sql` をSupabase SQL Editorで一度実行します。旧版の `app_state` テーブルには触れません。

## 公開先

GitHub Pagesの `/v2/` 配下へ `dist/` の内容を配置します。旧版のルート `/sasshy-quest/` はそのまま残します。

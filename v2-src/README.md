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

## ChatGPTからタスク追加

`supabase/functions/sasshy-add-task` は、新しいタスクの追加だけを許可するEdge Functionです。既存タスクの読取・変更・削除は提供しません。

- 同期キーとSupabaseのservice role keyはサーバー側だけに置く
- ChatGPTには取り消し可能な追加専用キーだけを設定する
- 受付番号で再送を判定し、同じ依頼を二重登録しない
- タスク本文をログへ出力しない

設定手順とGPT Actions用の定義は `chatgpt-action/` にあります。

## 公開先

GitHub Pagesの `/v2/` 配下へ `dist/` の内容を配置します。旧版のルート `/sasshy-quest/` はそのまま残します。

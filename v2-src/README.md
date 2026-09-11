# SASSHY v2

SASSHY QUESTの安定化版です。旧版とは別のURL・IndexedDB・Supabaseテーブルを使い、旧版のデータを上書きしません。

## 設計上の約束

- 端末での編集は最初にIndexedDBへ保存する
- 同期失敗でローカルデータを変更しない
- クラウドはタスク・メモ・作業記録を1件ずつ同期する
- 削除はゴミ箱への移動とし、履歴から復元できる
- タイマーの実績時間とカレンダーの予定時間を分離する
- 予定変更と結果は予定版ごとの追記履歴として残し、過去の予定を上書きしない
- 予定履歴は汎用レコードとは別の専用キューで操作順に同期する
- カレンダー操作中は自動同期を保留する

## バックアップ

設定画面から、未送信編集・予定履歴・ゴミ箱を含むWebバックアップを書き出せます。接続キーは含めません。保存対象と隔離復元の仕様は [BACKUP.md](BACKUP.md) を参照してください。

## 開発

```bash
pnpm install
pnpm test
pnpm build
```

## Supabase

設定画面の「初期化SQLをコピー」を使うと、`supabase-setup.sql` と `supabase-calendar-history.sql` を実行順にまとめてコピーできます。既存環境では後者だけを追加実行できます。旧版の `app_state` テーブルには触れません。

予定履歴をクラウド同期する場合は、SQL実行後に `supabase/functions/sasshy-schedule-history` もデプロイします。この関数は同期キーをサーバー側でSHA-256化し、予定変更をrevision一致付きで1操作ずつ適用します。

## カレンダーと予定履歴

- 月表示は1日4件までを表示し、残りは「他○件」から日別詳細を開く
- 通常表示は現在の予定だけで、結果・実績は「結果」をONにした時だけ重ねる
- 日付・時刻・予定時間の変更は保存前に移動先を確認する
- 完了・未実行・キャンセル・見送りは自動判定せず、予定版ごとに明示して記録する
- 再予定しても過去の予定版と結果は残り、Undo/Redoも取消・再適用イベントとして追記する

## iPhoneバックグラウンド通知

v2.3では、ホーム画面へ追加したiPhone PWAへWeb Pushを送ります。

- 本人がタスク単位でONにした開始時刻（新規タスクは既定OFF、旧データは要確認として一時継続）
- 実行中タイマーの予定終了時刻に1回（無反応による追撃なし）
- メモの通知時刻
- Phase 1開始支援はCurrent Target・10分後・Latest Safe Startを合わせて1仕事日最大2回
- 購読情報は同期キーのSHA-256ハッシュ単位で分離する
- VAPID秘密鍵と定期実行用キーはSupabase Secretsだけに保存する
- `sasshy_v2_push_deliveries`で同じ通知の二重送信を防ぐ

関連ファイルは `supabase/functions/sasshy-push`、`supabase-push-setup.sql`、`supabase-push-cron.example.sql` です。本番のEdge Function・Secrets・毎分Cronは設定済みです。

## ChatGPTからタスク管理

`supabase/functions/sasshy-add-task` は、SASSHYのタスクだけを検索・追加・変更・完了・ゴミ箱移動・復元するEdge Functionです。

- 同期キーとSupabaseのservice role keyはサーバー側だけに置く
- ChatGPTには取り消し可能なタスク管理専用キーだけを設定する
- メモ、タイマー履歴、同期設定は公開しない
- 変更前のrevision一致を必須にし、Mac/iPhone側の新しい変更を上書きしない
- 削除は復元可能なゴミ箱移動だけに限定する
- 受付番号で再送を判定し、同じ依頼を二重登録しない
- タスク本文をログへ出力しない

設定手順とGPT Actions用の定義は `chatgpt-action/` にあります。

### 通常のCodexチャットから追加

`?task=<Base64URL化したJSON>` を付けたリンクを開くと、タスク名・予定・所要時間を確認してから端末へ追加できます。専用GPTやAPIキーは不要です。

- 内容を確認するまで保存しない
- 受付番号 `requestId` が同じリンクは同じ端末で二重登録しない
- 追加後は通常の同期キューへ入り、設定済みのSupabaseへ同期する
- URLからタスク情報をすぐ取り除き、再読み込みによる再表示を防ぐ

リンク用JSONは `v: 1`、`requestId`、`title` が必須です。任意で `notes`、`scheduledDate`、`startTime`、`durationMin`、`importance`、`urgency`、`horizon` を指定できます。

## 公開先

GitHub Pagesの `/v2/` 配下へ `dist/` の内容を配置します。旧版のルート `/sasshy-quest/` はそのまま残します。

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

## iPhoneバックグラウンド通知

v2.3では、ホーム画面へ追加したiPhone PWAへWeb Pushを送ります。

- 時刻付きタスクの開始時刻
- 実行中タイマーの予定終了時刻
- メモの通知時刻
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

## v2.6 Siri音声タスク・未対応再通知

`POST /functions/v1/sasshy-add-task/voice` を追加。既存のBearer認証をそのまま使用し、
`idempotency_key`（8〜120文字）と`transcript`（1〜4000文字）を受け付ける。
OpenAI Structured Outputsでtitle/dueDate/dueTime/counterparty/requestSource/notesを抽出し、
元の文字起こしと再通知ONを既存`sasshy_v2_records.payload`へ原子的に保存する。
期限はscheduledDate/startMinute（作業予定）と分ける。テーブル追加・全件置換は行わない。

- 先に `supabase/migrations/20260905122546_voice_tasks.sql` を適用。
- Edge Function Secretsに `OPENAI_API_KEY` を設定。モデルの既定は `gpt-4.1-mini-2025-04-14`。
  `SASSHY_VOICE_MODEL`で変更可。API料金はChatGPT契約とは別。
- `sasshy-add-task` は `index.ts`、`validation.ts`、`management.ts`、`voice.ts` を一緒にデプロイ。
- `sasshy-push` は `index.ts`、`notifications.ts`、`../_shared/work-reminder.ts` を一緒にデプロイ。
  既存の毎分Cron・購読先・配信重複防止テーブルを再利用。
- iPhoneの手順は `public/siri-setup.html`。受付トークンは既存設定から手元で入力する。
  未署名のインポート用ショートカットは同梱せず、手順から作成する。
- 同じ受付番号・同じ原文の再送は登録済み結果を返す。同じ番号・別原文は409。
  AI失敗・未設定・不完全な出力では保存しない。元のJSONを残して同じ番号で再送する。
- 日本時間の平日9〜18時、1時間おき。期限時刻なしは17時、期限なしは作成1時間後。
  祝日は判定しない。既存タスクはOFF。作業開始/完了/削除/停止/延期は同期後に反映。
  配信直前にも最新の仕事タスクを再取得し、完了や延期を確認する。
- 本番にだけあったタイマー終了10分後・30分後の再通知もソースへ取り込んで維持。
- 通常のpush/pullは既存の同期キー認証を維持。新RPCはSECURITY INVOKERかつservice_role限定。
  既存同期RPCのSECURITY DEFINER警告は認証方式由来で、この変更で権限を広げない。

検証: Vitest（AI応答はモック）、TypeScript/Viteビルド、実DBのトランザクション内で
作成・重複・不一致を検証してrollback。実機のSiri・AI API・Web Push到着確認は別途必要。

### この実装の反映状態（2026-09-05）

- DBの新RPCは適用済み。既存タスクは変更していない。ロール制限・RLS確認済み。
- ローカルの `feat/siri-work-tasks` にソースとv2生成物をコミット済み。
- 53テストとアプリのTypeScript/Viteビルド成功。
- Edge Functionsは未デプロイ、GitHub Pagesは未反映。
- GitHubへのpushは自動承認審査が未許可の外部書き込みとして拒否。ユーザー許可後に作業ブランチをpushし下書きPRを作成する。
- クラウドブラウザからローカル画面へERR_BLOCKED_BY_CLIENT。デスクトップ・iPhone幅のスクリーンショット確認は未完了で、本番公開の前に実施が必要。
- OPENAI_API_KEYの設定有無は取得できていない。秘密の値をチャットやリポジトリへ貼らずSupabase側で設定する。
- DenoのEdge全体チェックはJSR依存のダウンロード待ち。純粋ロジックはVitestで確認済み。

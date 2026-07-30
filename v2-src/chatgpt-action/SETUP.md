# iPhone ChatGPTからSASSHYを管理する設定

この入口でできるのは、タスクの検索・追加・変更・完了・ゴミ箱移動・復元です。
メモ、タイマー履歴、同期設定にはアクセスできません。削除は完全削除せず、SASSHYから復元できます。

## 1. SupabaseのSQLを更新

SupabaseのSQL Editorで、このリポジトリの `supabase-setup.sql` 全文を実行します。

## 2. タスク管理専用キーを作る

推測されない長いランダム文字列を1つ作ります。この値はGitHubやメモへ公開しません。

## 3. Supabase Edge Functionを設定

Function名は `sasshy-add-task` です。次の2つをSupabaseのSecretsへ設定します。

- `SASSHY_TASK_INGEST_TOKEN`: 2で作ったタスク管理専用キー
- `SASSHY_SYNC_KEY`: SASSHY v2の設定画面にある同期キー

FunctionはJWT検証をOFFにして公開しますが、処理内でタスク管理専用キーを必ず検証します。

## 4. SASSHY管理用GPTを作る

1. GPTの作成画面で `GPT_INSTRUCTIONS.md` の内容を指示へ貼ります。
2. Actionsへ `openapi.yaml` を読み込ませます。
3. AuthenticationはAPI key、Auth TypeはBearerを選びます。
4. API keyには2で作ったタスク管理専用キーを設定します。

## 5. テスト

SASSHY v2の自動同期をONにしてから、GPTへ次のように依頼します。

> 今日18時に「動作確認」を追加。所要時間10分。

同じ依頼を再試行しても1件だけ登録されることを確認します。

続けて「動作確認を検索」「明日に変更」「完了」「ゴミ箱へ移動」「復元」を試します。
別端末で変更された古い検索結果は409で止まり、再検索するまで上書きされません。

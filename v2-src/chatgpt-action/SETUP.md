# iPhone ChatGPTからSASSHYへ追加する設定

この入口でできるのは「新しいタスクの追加」だけです。既存タスクの読取・変更・削除はできません。

## 1. SupabaseのSQLを更新

SupabaseのSQL Editorで、このリポジトリの `supabase-setup.sql` 全文を実行します。

## 2. 追加専用キーを作る

推測されない長いランダム文字列を1つ作ります。この値はGitHubやメモへ公開しません。

## 3. Supabase Edge Functionを設定

Function名は `sasshy-add-task` です。次の2つをSupabaseのSecretsへ設定します。

- `SASSHY_TASK_INGEST_TOKEN`: 2で作った追加専用キー
- `SASSHY_SYNC_KEY`: SASSHY v2の設定画面にある同期キー

FunctionはJWT検証をOFFにして公開しますが、処理内で追加専用キーを必ず検証します。

## 4. SASSHY追加用GPTを作る

1. GPTの作成画面で `GPT_INSTRUCTIONS.md` の内容を指示へ貼ります。
2. Actionsへ `openapi.yaml` を読み込ませます。
3. AuthenticationはAPI key、Auth TypeはBearerを選びます。
4. API keyには2で作った追加専用キーを設定します。

## 5. テスト

SASSHY v2の自動同期をONにしてから、GPTへ次のように依頼します。

> 今日18時に「動作確認」を追加。所要時間10分。

同じ依頼を再試行しても1件だけ登録されることを確認します。

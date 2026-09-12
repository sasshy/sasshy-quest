# P3: 同じworkspaceの認証キーを更新する

## 現在の状態

サーバー互換対応を本番へ反映済み。migration `20260912150411_separate_workspace_credentials`、Edge `sasshy-add-task` v13、`sasshy-push` v8、`sasshy-schedule-history` v2。

**新credentialの登録・端末への設定・旧credential失効は未実施。P3全体は未完了。** 互換段階では旧認証が継続する。旧認証の無期限併用を完了として扱わない。

対象iPhoneのNative保存領域をMacへ2回読み取り、レコードと設定の一致を確認して非公開保存した。未送信操作72件がある。Safari/PWA、Keychain、iOSが管理するAlarmKit・通知予約はこのコピーに含まれない。端末への復元は未実施。実データと秘密値はこのリポジトリに含めない。

## 実装

- `sasshy_private.workspace_credentials`: 新credentialのSHA-256 → 既存workspace ID。失効済みmappingの再利用・他workspaceへの割当てを拒否。
- `workspace_auth`: 明示的に移行したworkspaceだけ旧認証を拒否。未対象workspaceの動作を変更しない。
- 一般ロールにはregistryの読書き権限なし。`resolve_credential`だけが生キーを検証して永久workspace IDを返す。ハッシュ直接解決はservice_roleのみ。
- 既存レコード、履歴、受付番号、Push登録先を移動しない。SQLは本番の8関数定義を照合してから適用し、6業務表をロックしたトランザクション内で適用前後の内容が一致することを確認。
- 設定画面で同期キーを変える時は、新旧キーのworkspace IDを照合してから設定を保存する。別workspace・認証失敗・通信失敗時は設定・ローカルデータ・未送信操作を維持する。キー変更と同時のURL変更は移行手順へ案内する。
- Nativeの401/503応答でSwiftの未確認音声依頼を捨てない変更を別差分に保持。現用アプリへのインストールは未実施。

## 受付の対応範囲

| 受付 | 判定 |
|---|---|
| `sasshy_v2_push` / `pull` | SQLの共通resolver |
| `connection_info` | 認証済みworkspace IDだけを返す読取り専用preflight |
| 予定履歴 `apply` / `list` | Edge resolver、apply側SQLでも再検証 |
| Push `subscribe` / `unsubscribe` / `test` / `work-start-status` | 共通resolverが返す既存workspaceを使用 |
| Push `config` / `dispatch` | configは公開VAPID鍵のみ。dispatchは既存Cron秘密またはservice roleで制限 |
| task追加・検索・変更・完了・再開・削除・復元 | 既存Bearerに加えサーバーの同期credentialを共通resolverで検証、SQLでも再検証 |
| `/voice` | 上記に加えNativeのcredential fingerprintを解決して同じworkspaceか照合。別workspace・失効済みfingerprintを拒否 |

タスク管理BearerとiOS音声専用Bearerの既存スコープは維持する。同期キーをBearerとして流用しても受付・Cronは認証しない。メモや作業記録へタスク受付の権限を広げない。

## 残る切替手順

1. 現用のMac・iPhone Native・iPhone PWAの利用有無と保存先を確認。各端末の未送信分を保全する。Nativeの72件は消去・一括置換しない。
2. 対応クライアントを反映し、既存キーで同期先の照合とバックアップを確認する。Nativeは同じBundle ID・署名Teamで更新し、削除しない。
3. 対象workspace IDを管理経路で確認し、十分な乱数（最低32bytes）の新credentialを非公開で作る。値をSQL・ログ・PR・チャットに貼らない。管理SQLへ渡すのはSHA-256だけ。
4. `sasshy_private.stage_credential(workspace_id, new_credential_hash)` を管理接続で呼ぶ。API一般ロールやservice_roleにはこの登録権限を与えていない。
5. 各端末の同期設定とサーバーSecret `SASSHY_SYNC_KEY`を新credentialへ切り替える。Nativeの音声用fingerprintは既存のSHA-256送信と互換。独立した音声／タスクBearerは維持できる。
6. 新credentialで同じID・履歴・Pushのworkspaceが見えることを確認。未送信操作の件数・IDと処理結果を照合する。通信・認証失敗で72件をclearしない。
7. 端末の確認後、管理接続から `sasshy_private.disable_legacy_credential(workspace_id, confirmed_new_hash)` を実行。旧credential、旧fingerprint、別workspaceのcredentialの拒否を全受付で確認する。
8. 必要なら追加mappingを `sasshy_private.revoke_credential(hash)` で失効する。生キーは引数にしない。

## 復旧

workspace対応とデータを保持し、問題のある端末の同期を保留する。閲覧・ローカル編集・バックアップは継続可能。失効credentialを再有効化しない。保存した旧Edgeソースは比較用であり、失効後に旧hash直結ロジックへ戻すことは安全なrollbackではない。復元は新規隔離領域で検証してから判断する。

## 検証

- Web: 132テスト成功、TypeScript/Viteビルド成功（既存bundleサイズ警告）。
- Native Web: 74テスト成功、TypeScript/Viteビルド成功。
- Swift: generic iPhone向け署名なしXcodeビルド成功。実機更新・新credentialでの実機照合は未実施。
- PostgreSQL 17.10: 新規socket専用clusterに合成fixtureを作り、8テスト成功。本番適用wrapperの定義照合とデータ不変性も含む。
- Edgeテストは実handlerのソースをネットワーク境界だけstub化して実行。全受付の拒否、workspace対応、Voiceの別workspace拒否・再送、resolver停止時の拒否を確認。実通知・AI送信は行わない。
- Advisor: 既存の公開SECURITY DEFINER警告4件は継続。追加した公開connection_infoはinvoker。非公開registryのRLS政策なしINFO2件は直接アクセス禁止の意図どおり。

参考: [関数の権限](https://supabase.com/docs/guides/database/functions)、[Data APIの保護](https://supabase.com/docs/guides/api/securing-your-api)、[公開definer警告](https://supabase.com/docs/guides/database/database-linter?lint=0028_anon_security_definer_function_executable)、[RLS政策なしINFO](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy)。

# Webバックアップ（P2 / formatVersion 1）

設定 → バックアップ →「バックアップを書き出す」でJSONを保存する。旧4表だけの書出しを、未送信操作を含む8表のsnapshotへ変更した。現用DBへの復元ボタンは追加していない。

## 保存するもの

`tasks`、`memos`、`sessions`、`history`、`outbox`、`scheduleHistory`、`scheduleOutbox`と、`settings`の下記許可項目を、一つのreadonly transactionで読む。各表のID、ゴミ箱、履歴、キューのID/順序/試行回数/baseRevision、result-only操作、競合payloadを維持する。JSONで表現できる未知のタスク/Siriフィールドもそのまま保持する。

| settings ID | 保存する項目 |
|---|---|
| `voice` | enabled、rate、volume、announcements、everyMinute、finalCountdown |
| `device` | value（端末識別ID） |
| `undo-redo` | undo/redo配列。操作ID・説明・時刻・期待revision・予定操作ID・タスクsnapshot/グループを保存 |
| `task-link:<requestId>` | taskId、importedAt（既存の受付IDの形式に合うもの） |
| `push` | deviceNameのみ |
| `google-calendar` | lastSyncAtと、eventのid/title/start/end/allDay/calendarName/color |

設定のオブジェクト全体を展開しない。各設定とそのevent/actionメタデータにもallowlistを適用し、追加の未知設定は除外する。undoのタスクsnapshotは利用者データなので、追加のタスクフィールドを維持する。

`sync`設定、同期/APIキー、token、Push endpoint/購読鍵、Google Calendar feed URL、接続エラー、Keychainなどは設定から出力しない。同期・通知登録・カレンダー接続は再設定が必要。localStorageの表示選択、sessionStorage、旧版データ、Web外の保存領域は対象外。

タスク本文・メモ・任意の追加データに利用者が書いた文字列は、秘密らしい語があっても削除・加工しない。ファイルは利用者の内容を含むため非公開で保管し、Gitや公開サイトへ追加しない。ハッシュは破損検知用で、暗号化や送信元の証明ではない。

## ファイル形式

- `format`: `sasshy-web-backup`
- `formatVersion`: `1`
- `schemaVersion`: `2`（Webの現行Dexie schema）
- `appVersion`: ビルド元package.jsonのversion
- `exportedAt`: snapshot読取り開始時のUTC時刻
- `tables`: 8表の配列。settingsは上記の許可項目のみ
- `counts`: 出力した各表の件数（settingsは除外後）
- `pending`: 通常操作・予定操作・競合を含む予定操作の件数
- `references.missing`: 見つからない参照先。該当データを捨てず、参照情報とともに保存
- `exclusions`: 設定ポリシー番号、全体を除外した設定行の件数、接続の再設定対象
- `checksum`: SHA-256。checksum自体を除く全内容を、オブジェクトのkey順を揃えたJSONにして計算

ハッシュ計算とファイル生成は読取りtransactionの終了後に行う。DB schemaが変わった場合は、未知の表を黙って落とさず書出しを中断する。Date/Map/非有限数値/循環参照等、JSONで完全には表せない値も黙って変換しない。通常のoptionalプロパティであるundefinedはJSONの仕様どおり省略する。undefinedを含む配列や疎配列は中断する。

ID重複、キューpayloadと対象IDの不一致、予定operation IDとhistory IDの不一致を拒否する。session→task、history→task/session、通常キュー→レコード、予定履歴/キュー→task、予定キュー→history、relatedEntryId、task-link受付→taskの欠落を報告する。全業務ルール・過去予定versionの完全性を検証する機能ではない。

## 隔離復元と再検証

`src/backup.ts` の `readBackup(json)` は形式・hash・件数・キューID整合性・参照検査結果・設定allowlistを確認する。従来の `{version:2,...}` 書出しや将来versionは、形式未対応として元ファイルの保持を促す。

`restoreBackupForVerification(json)` は検証専用API。既存DBや復元先名を渡す引数はなく、ランダムな `sasshy-v2-backup-check-...` DBを新規作成する。同名DBが存在する場合は中断する。8表を一つのwrite transactionで追加し、元IDとqueue IDを維持する。

復元DBでは同期を無効化して接続キーを空にする。PushとCalendarの保存対象があれば、それらも無効・接続先空にする。アプリのsingleton store、同期スケジューラ、ensureDefaultsは起動しない。復元後に再書出しして全対象payloadとpending件数を照合し、不一致や途中失敗の場合は自分で新規作成した検証DBだけを削除する。

開発者が検証する場合:

```ts
const isolated = await restoreBackupForVerification(json);
try {
  // 自動照合済み。必要な追加の読取り確認をここで行う。
  const verificationSnapshot = await createBackup(isolated);
} finally {
  await isolated.delete();
}
```

現用DBのimport/置換、現用端末での復元操作はP2の範囲外。Native Webの6表やSwift pending/Alarm状態は保全していない。

## 検証結果（2026-09-12）

- `pnpm test`: 13ファイル、105/105成功（バックアップ専用19件を含む）。既存の保存・予定同期・通常同期・音声テストも成功。
- `pnpm build`: TypeScriptとViteビルド成功。既存の大きなbundleに対する500kB警告あり。
- 実ブラウザ（Chrome、独立した一時context、localhost）: 1280×900と390×844で書出し・ファイル読取り・隔離IndexedDB復元・hash失敗時表示・元DB不変を確認。横はみ出しとpageerrorなし。
- 合成fixture: 未送信task/memo/session、過去予定のresult-only、競合、削除済みtask、session参照、undo、追加フィールド、設定内の秘密項目を含めて検証。
- readonly transaction中に別接続から編集を待機させても、snapshotの表間で時点が混ざらないことを確認。
- 読取り失敗/hash失敗、改変ファイル、参照メタデータ改変、重複ID、既存復元先との衝突、復元途中の書込み失敗を検証。

テスト実行環境はNode 24。テストの自動依存インストールを避けるため、この作業では `pnpm --config.verify-deps-before-run=false --config.update-notifier=false test` / `build` を使用した。アプリ依存関係やlockfileは変更していない。

## 反映と戻し方

Webリリース2.6.1に含める。公開生成物とSWキャッシュを更新済み。実iPhone/Safariでのダウンロードと各端末の実データ保全は、公開後に端末ごとに確認する。P1で行った本番DB権限変更と、今回のWebクライアントの公開は別である。

公開時は通常のバージョン・SWキャッシュ更新と生成物の反映手順に従う。UIを切り戻す場合も、既に書き出したformatVersion 1を読む `backup.ts` とテストは保持する。schema変更やキューの移行は不要。次の段階はWeb版への反映と各対象端末の保全確認であり、それまではP3のキー失効条件を満たしたと扱わない。

設計根拠: [Dexie transaction](https://dexie.org/docs/Dexie/Dexie.transaction())、[Dexie exists](https://dexie.org/docs/Dexie/Dexie.exists())。

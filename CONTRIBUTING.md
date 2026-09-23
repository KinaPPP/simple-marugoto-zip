# Contributing

Issue / Pull Requestを歓迎します。

## バグ報告

可能であれば以下を添えてください。

- Chromeのバージョン
- 拡張機能のバージョン
- 対象SNS（現在はX）
- 再現手順
- 期待した動作
- 実際の動作
- `chrome://extensions/` のService Worker Consoleに表示されたエラー

認証Cookie、アクセストークン、パスワード等は投稿しないでください。

## UI変更

シンプルシリーズでは、機能追加のたびに下へ項目を増やすより、主要操作が可能な限り1画面に収まることを優先します。

## Provider追加

SNS固有の取得処理は `providers/` 配下へ分離し、ZIP・レジューム・共通UI処理への依存を最小限にしてください。

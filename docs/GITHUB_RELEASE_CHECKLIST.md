# GitHub公開チェックリスト

## v1.0.0候補前

- [x] v0.0.24を実機で確認（初期設定が手動、疑似429 UIなし、10ファイル選択なし、300 MB/300ファイルの説明）。旧ユーザーの収集モード設定は変更しない。
- [x] 4つの既存回帰テストに加え `node tests/release-candidate.test.cjs` を実行する。
- [ ] 1000件以上の大量メディア警告を実装・確認
- [ ] X表示件数が取得できない場合も通常収集できる
- [ ] 自動スクロール / GraphQL待機の安定化
- [ ] 429時の停止・再開を確認
- [ ] 手動停止・Chrome再起動からのレジュームを確認
- [ ] ZIPファイル名と連番を確認
- [ ] Chromeのダウンロード設定ON/OFFを確認
- [ ] ポップアップに不要な縦スクロールが出ない
- [x] READMEを正式版向けに更新
- [x] `manifest.json` のdescriptionから「テスト版」を削除
- [x] TESTING.mdのテスト版専用記述を整理
- [x] LICENSE年表記を確認
- [ ] SECURITY.md / PRIVACY.mdを最終確認
- [ ] GitHubにトークン、Cookie、ローカルファイルが含まれていないことを確認

## GitHub Release

- [ ] Tag `v1.0.0`
- [ ] Release notes作成
- [ ] `simple-marugoto-zip-v1.0.0.zip` を添付
- [ ] ZIP内部の最上位フォルダが `simple-marugoto-zip/` になっていることを確認

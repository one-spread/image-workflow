# plan-copy-targets-20261107

詳細な計画・判断ログは Vault の `21_Notes/Image Workflow 20261107.md` に集約。

## Goal

貼り付け先（Google Docs / Gmail / Slack / Google Chat / Chatwork / プレーン）ごとに崩れないコピーを提供する。Cmd+C は標準の Markdown コピーのまま。

## Phase 1（1.3.0）

- [x] Cmd+C の自動リッチコピーを初期値 OFF
- [x] 自動コピー時も editor.getSelection() を優先（Live Preview で `==` が消える問題）
- [x] `<mark>` → `span background-color`、`del` → line-through span、内部リンク・タグはテキスト化
- [x] 自前クリップボード HTML に `data-image-workflow-copy` を付け、貼り戻し判定に使用
- [x] `copy-text.ts`: Slack / Google Chat / Chatwork / プレーン変換、チャット用簡易 HTML
- [x] 「Copy for…」一覧（前回選択を先頭）、各貼り付け先コマンド、右クリック
- [x] バージョン 1.3.0 に統一（manifest / package / lock / versions）
- [x] tsc / build / 変換結果テスト（jsdom）
- [x] 実機確認（Google Docs）
- [ ] 実機確認（Gmail / Slack / Google Chat / Chatwork）

## Phase 2 以降

- Gmail 向け画像縮小・圧縮、チャット向け画像の順次コピー
- [x] 画像の簡易編集 v1（枠・矢印・文字・Undo・Copy・Save）
- [x] PNG は元ファイルに上書き保存し、元画像と図形を PNG 内に保持（再編集・Revert 可能）
- [ ] モザイク・切り抜き

# plan-gdocs-table-list-layout-20261113

## Overview

- 作成日：2026-11-13
- 目的：「Copy for Google Docs」で貼った議事録（NLCS 20261113）の見栄えのずれを直す
- 元の資料：Google Docs「NLCS Meeting 20261113」（EN／JAタブ）、Vault `20_Fleeting/NLCS/共通・全体運用/議事録/NLCS 20261113.md`

## 見つかった問題（Google Docsで確認）

| No. | 症状 | 原因（推定） | 対応 |
|---|---|---|---|
| 1 | 表がページ幅の約7割で止まり、短い列（"No."、"15 min"）まで折り返す | Docsは貼り付けHTMLの `width:100%` を使わず、列幅を自前で決める | gdocs向けに列ごとの幅（pt）を `<colgroup>` とセルに明示し、合計を本文幅に合わせる |
| 2 | 箇条書きの先頭に空の「•」が出る／項目の間が1行ずつ空く | 項目の間に空行があるMarkdownリストは `<li><p>…</p></li>` になり、Docsが `<p>` を別段落として扱う | gdocs向けに `li > p` を外し、複数段落は `<br>` でつなぐ |
| 3 | 表の直後の箇条書き・段落が表にくっつく | 表の margin を消している（セル内の段落間隔になるため） | gdocs向けに、表の後ろが本文・リスト・表なら空段落を1つ入れる |
| 4 | Ganttの日付ラベルが詰まる | 期間が長い（10月〜1月）ため | プラグイン外。ノート側でGanttを11月だけにした |

## Scope

- `html-style.ts` の gdocs 向け処理（上記1〜3）
- `tests/browser-verify.mjs` に確認を追加

## Non-Scope

- Gmail・Slack など他の貼り付け先の見た目変更
- バージョン番号の更新・リリース（別途）

## Review Criteria

- `npm run check`（tsc＋eslint）と `npm test`、`npm run test:browser` が通る
- Google Docsへの実貼り付けで表幅・箇条書きを目視確認（Das）

## Decision Log

| Date | Decision | Reason |
|---|---|---|
| 2026-11-13 | 本文幅は 468pt（6.5in、Letter・余白1in）を既定にする | Docsの既定ページ設定。A4（余白1in）なら451pt |

## Status

- [x] 原因の特定
- [x] 実装
- [ ] Google Docsでの実機確認（Das）

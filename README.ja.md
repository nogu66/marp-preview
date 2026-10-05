<div align="center">

<img src="docs/icon.svg" alt="marp-preview のアイコン" width="112">

# marp-preview

Claude Code の pane に Marp スライドのプレビューを表示します。Claude にスライドの修正を頼むと、ターミナルを離れずにその結果を確認できます。

![Claude Code plugin](docs/badges/claude-code-plugin.svg)
![Claude Code 2.1.289+](docs/badges/claude-code-version.svg)
![Function hooks](docs/badges/function-hooks.svg)
![License: MIT](docs/badges/license.svg)

[English](README.md)

</div>

## クイックスタート

必要なものは 3 つです。Claude Code 2.1.289 以降、kitty graphics protocol 対応の端末(Ghostty、kitty)、そして [marp-cli](https://github.com/marp-team/marp-cli) です。marp-cli はプロジェクト内(`node_modules/.bin/marp`)にあるか、`npx` で実行できれば使えます。

1. シェル、またはセッション内でインストールします。

   ```bash
   claude plugin marketplace add nogu66/marp-preview
   claude plugin install marp-preview@marp-preview
   ```

   ```
   /plugin marketplace add nogu66/marp-preview
   /plugin install marp-preview@marp-preview
   ```

2. スライドのあるプロジェクト、またはデッキのあるフォルダで新しいセッションを始め、次を実行します。

   ```
   /marp                  # いまいるフォルダ以下で、いちばん最近更新されたデッキ(`marp: true` のある .md)
   /marp slides/deck.md   # ファイルを指定する場合
   /marp slides           # フォルダを指定する場合: その中でいちばん最近更新されたデッキ
   ```

```
deck.md 12 slides [ ⏭ Last ]

1 / 12
┌────────────────────────────────┐
│           1 枚目のスライド         │
└────────────────────────────────┘

2 / 12
┌────────────────────────────────┐
│           2 枚目のスライド         │
└────────────────────────────────┘
  ⋮
```

## 使い方

pane にはデッキ全体が、スライドを縦に並べた形で表示されます。マウスホイールでスクロールするか、pane をクリックしてから矢印キーや PageUp / PageDown で動かします。Esc でキー入力がプロンプトに戻ります。上端の `⏭ Last` で最後のスライドへ、下端の `⏮ First` で最初のスライドへ移動します。

**ファイルの変更に追従します。** Claude やエディタがデッキを保存すると、1 秒以内に検知して描き直し、変更された最初のスライドまでスクロールします。そのスライドのページ番号は黄色になります。pane はデッキを読むだけです。編集は Claude かエディタで行います。

## 仕組み

<details>
<summary>ファイルの保存からプレビュー更新まで</summary>

```mermaid
flowchart LR
  F[deck.md が保存される] -->|"$.fs.stat を 1 秒ごと"| H[register.tsx]
  H -->|"$.process.run: marp --images png"| P["/tmp/marp-preview/…/s.NNN.png"]
  P -->|"Image(ファイル名で指定)"| T[端末がスライドを描画]
```

hooks module は、pane が開いている間、デッキの更新時刻を 1 秒ごとに確認します。変更があると、最後に描いたテキストとスライド単位で比較し、デッキ全体に marp-cli を実行してから、最初に違いがあったスライドまで pane をスクロールします。PNG は端末がファイル名からディスクを直接読むため、画像データはプラグインを通りません。

`marp` は、デッキから上へ最大 6 階層さかのぼって最初に見つかった `node_modules/.bin/marp`(または `marp/node_modules/.bin/marp`)を使い、なければ `npx --yes @marp-team/marp-cli` を使います。その途中にある `theme/`、`themes/`、`marp/themes/` はすべて `--theme-set` として渡します。

スライドの数え方は Marp の区切り方と同じです。`---`、`***`、`___` の行が区切りですが、コードフェンスの中、front matter、段落直後の setext 見出しの下線、HTML ブロックの中は区切りません。

| ファイル | 役割 |
| --- | --- |
| [`hooks/register.tsx`](plugins/marp-preview/hooks/register.tsx) | `/marp` コマンド、pane、レンダリング、ファイルへの追従 |
| [`hooks/lib/deck.ts`](plugins/marp-preview/hooks/lib/deck.ts) | 純粋関数: デッキのテキストからスライドへの分割、変更されたスライドの特定 |
| [`types/index.d.ts`](plugins/marp-preview/types/index.d.ts) | プラグインの状態の型 |

</details>

## トラブルシューティング

**`/marp` が unknown command になる。** Claude Code は、信頼済みのワークスペースでしかプラグインの hooks module を読み込まず、読み込まなかった場合も何も表示しません。信頼済みのディレクトリから起動するか、このディレクトリの信頼プロンプトを承認してください。

**pane が「Rendering the deck…」のまま、または赤い行が出る。** marp-cli が失敗しています。赤い行はエラーの最終行です。全文を見るには `npx @marp-team/marp-cli your-deck.md --images png` を自分で実行してください。独自テーマは、デッキと同じかそれより上の階層の `theme/` か `themes/` に置く必要があります。

**画像が出ず、代替テキストだけが出る。** 端末が kitty graphics protocol に対応していないか、tmux や ssh を経由しています。

## 制約

<details>
<summary>既知の制約</summary>

- function hooks は early access で、Claude Code のリリース間で API が変わることがあります。macOS の Ghostty と 2.1.289 で確認しています。
- レンダリングのたびにデッキ全体へ marp-cli を実行するため(十数枚で約 5 秒)、プレビューは保存からその分だけ遅れます。
- 画像は、縦が横の約 2.1 倍のセルを前提にサイズを決めています。フォントによっては少し伸びて見えます。
- 端末専用です。デスクトップアプリ、VS Code 拡張、モバイルアプリではスライドの画像を表示できず、pane にその旨が表示されます。

</details>

## 開発

```bash
claude --plugin-dir plugins/marp-preview     # このチェックアウトを読み込む。保存でリロード(または bun run dev)
bun test tests                              # 純粋ロジック(または bun run test)
claude plugin test plugins/marp-preview      # pane をエンジンのテストホストで(または bun run test:hooks)
claude plugin validate .                    # マーケットプレイス
claude plugin validate plugins/marp-preview  # プラグイン: どのイベントを hook し、どの `$` を呼ぶか
tsc -p plugins/marp-preview                  # 型チェック(または bun run typecheck)
```

セッションでプラグインを読み込むと(`claude --plugin-dir plugins/marp-preview`、ヘッドレスなら `claude -p "/cost" --plugin-dir plugins/marp-preview`)、その Claude Code ビルドの型宣言と `tsconfig.json` がプラグインの隣に書き出されます。`tsc` にはこれが必要で、`bun run typecheck` は両方を実行します。インストール済みのコピーはバージョンが変わったときだけ更新されるので、リリースのたびに `plugins/marp-preview/.claude-plugin/plugin.json` の version を上げてください。

## ライセンス

[MIT](LICENSE)

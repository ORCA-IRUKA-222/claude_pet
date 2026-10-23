# Claude Pet

ChatGPT の「ペット」機能と同じことを **Claude Code** でできるようにする、デスクトップのペットです。

画面の端に小さなペットが浮かび、Claude Code が「作業中」「あなたの入力待ち」「完了」「エラーで停止」のどれなのかを動きと吹き出しで知らせます。ほかのウィンドウで作業していても、Claude の様子がひと目で分かります。

![状態ごとの表示（作業中・許可待ち・完了・エラー）](docs/states.png)

## ChatGPT のペット機能との対応

| ChatGPT / Codex のペット | Claude Pet |
| --- | --- |
| デスクトップに浮かぶアニメーション付きの相棒 | 同じ。常に手前に表示、ドラッグで移動、位置は保存 |
| 4 つの状態（実行中 / 入力が必要 / 準備完了 / ブロック中） | 作業中 / 入力待ち（許可・質問・プラン確認）/ 完了（未読）/ エラー |
| 複数のチャットの進み具合を追跡 | 複数の Claude Code セッションを一覧表示。いちばん急ぐものを吹き出しに表示 |
| ペットから新しいチャットを始める（Quick Chat） | クイックチャット。ペットの下の入力欄から Claude Code に質問し、続きはターミナルで再開できる |
| Mini 表示 | ミニ表示（状態と件数だけの小さなピル） |
| `/pet` で表示・非表示 | Claude Code で `/pet`（モデルを呼ばないのでトークンを消費しない） |
| カスタムペット / `hatch-pet` スキル | `/hatch-pet` で Claude がペットをコードで描いて作成。画像 1 枚からも作れる |
| Codex のペット形式（`pet.json` + 8x9 スプライトシート） | そのまま読み込めます。`~/.codex/pets` や Petdex のペットも使えます |

## 必要なもの

- Node.js 22 以上
- Claude Code（ターミナル版で動作確認しています。`~/.claude/settings.json` のフックを読む環境なら同じように動きます）
- macOS / Windows / Linux（Linux は透過ウィンドウに対応したデスクトップ環境が必要です）

## インストール

```bash
git clone https://github.com/ORCA-IRUKA-222/claude_pet.git
cd claude_pet
npm install
npm link                # claude-pet コマンドを使えるようにする（任意）
claude-pet setup        # Claude Code にフックと /pet, /hatch-pet を登録
claude-pet              # ペットを起動
```

`npm link` をしない場合は `node bin/claude-pet.js setup` のように実行してください。

`setup` は `~/.claude/settings.json` に Claude Pet のフックを**追記**します（既存の設定やフックはそのまま残り、元のファイルは `settings.json.claude-pet.bak` にバックアップされます）。設定は次に起動した Claude Code のセッションから有効になります。

## 使い方

| 操作 | 動作 |
| --- | --- |
| ペットをクリック | セッション一覧を開く / 閉じる |
| ペットをドラッグ | 移動（走って付いてきます） |
| ペットを右クリック / トレイアイコン | メニュー（ペットの切り替え、サイズ、ミニ表示、通知など） |
| 吹き出しをクリック | セッション一覧を開く |
| `Ctrl+Alt+P`（macOS は `Cmd+Option+P`） | ペットの表示 / 非表示 |
| `Ctrl+Alt+C`（macOS は `Cmd+Option+C`） | クイックチャットを開く |
| `Esc` | 入力欄・一覧を閉じる |

### 状態の見方

| 状態 | ペット | いつ |
| --- | --- | --- |
| 作業中 | 集中して作業 / ファイルを読むときはきょろきょろ | プロンプトを送ってから応答が終わるまで |
| 入力待ち | 手を挙げて呼ぶ（オレンジ） | ツールの許可、`AskUserQuestion` の質問、プランの承認などを待っているとき |
| 完了 | ジャンプして喜ぶ → 緑のバッジ | 応答が終わって、まだ見ていないとき |
| エラー | しょんぼり（赤いバッジ） | 利用上限・認証エラーなどで止まったとき |
| ひと休み | 呼吸・まばたき | 何も起きていないとき |

バッジの数字は「入力待ち + エラー + 未読の完了」の件数です。一覧で項目を開くか「既読」を押すと消えます。次のプロンプトを送ったときも自動で消えます。

### セッション一覧

![セッション一覧](docs/panel.png)

項目を開くと、最後のプロンプトと Claude の返答が読めます。「ターミナルで開く」で `claude --resume <セッション>` を新しいターミナルで開きます。

### クイックチャット

![クイックチャット](docs/quickchat.png)

ペットから直接 Claude Code に質問できます（内部では `claude -p` を使います）。続けて送ると同じ会話の続きになります。📁 ボタンで作業フォルダを選べます。

クイックチャットは軽い質問向けです。ファイル編集などの許可が必要な作業は自動では許可されないので、「ターミナルで続ける」でいつもの Claude Code に引き継いでください。

### ミニ表示

![ミニ表示](docs/mini.png)

右クリックメニューの「ミニ表示」か `/pet mini` で、状態と件数だけの小さな表示になります。`/pet full` で元に戻ります。

### `/pet` コマンド

Claude Code の入力欄で使えます。フックが処理するので、モデルは呼ばれずトークンも使いません。

```text
/pet              表示 / 非表示（起動していなければ起動）
/pet show | hide
/pet mini | full
/pet list         使えるペットの一覧
/pet use <id>     ペットを切り替え
/pet next         次のペットに交代
/pet rotate on | off | <分>   一定時間ごとに自動で交代
/pet quit         終了
```

ターミナルからは `claude-pet toggle`, `claude-pet status`, `claude-pet use <id>` なども使えます（`claude-pet help` で一覧）。

### ペットを自動で交代する

1 体に決められないときは、一定時間ごとにペットを入れ替えられます。交代すると、新しいペットが手を振って吹き出しで名前を知らせます。

```bash
claude-pet rotate on --every 60            # 1 時間ごとに交代（すべてのペットから）
claude-pet rotate on --group "グループ名"   # pet.json の group が同じペットだけで交代
claude-pet next                            # 今すぐ交代
claude-pet rotate off                      # やめる
```

Claude Code からは `/pet rotate on`, `/pet rotate 30`（30 分ごと）, `/pet next` でも操作できます。右クリックメニューの「ペットの交代」でも、オン・オフ、間隔（15 分〜3 時間）、対象のグループを選べます。

- 全員が一度ずつ出てから次の一巡に入るので、同じペットばかり続くことはありません。
- メニューや `/pet use` で選んだペットは、そこから 1 回分の間隔だけ表示が続きます。
- スリープから復帰したときも、時間が過ぎていればすぐ交代します。

## ペットを増やす

### Claude に作ってもらう（`/hatch-pet`）

```text
/hatch-pet 青いペンギン。マフラーを巻いている
```

ChatGPT の hatch-pet は画像生成でペットを作りますが、Claude は画像を生成しないので、**ペットを JavaScript のコードでピクセルアートとして描きます**。Claude はデザインを書き、スプライトシートに書き出し、できた画像を自分で見て直してから、インストールまで行います。

自分で描く場合は [`tools/designs/mochi.js`](tools/designs/mochi.js)（標準ペットの Mochi）が見本です。

```bash
claude-pet build path/to/design.js --install
claude-pet use <id>
```

複数のキャラクターをまとめて作るときは、`{ template: 'chibi', group, characters: [...] }` を書いたファイルを `build` に渡すと、[`tools/designs/chibi.js`](tools/designs/chibi.js) のテンプレートで 1 体ずつ書き出し、`group` 付きでインストールします（交代のグループに使えます）。

![Mochi の全アニメーション](pets/mochi/qa/contact-sheet.png)

### 画像 1 枚から作る

透過 PNG / WebP / GIF があれば、そのままペットにできます（動きはアプリが付けます）。

```bash
claude-pet add-image ~/Pictures/neko.png --name ねこ
claude-pet use ねこ
```

### Codex / ChatGPT / Petdex のペットを使う

Codex 形式のペット（`pet.json` + `spritesheet.webp|png`、192x208 のセルが 8 列 x 9 行）は変換なしで使えます。次のフォルダを自動で探します。

| 場所 | 内容 |
| --- | --- |
| `~/.claude-pet/pets/<id>/` | Claude Pet 用（`/hatch-pet` や `add-image` の出力先） |
| `~/.codex/pets/<id>/` | Codex / ChatGPT の hatch-pet で作ったペット |
| `~/.petdex/pets/<id>/` | `npx petdex install <name>` で入れたペット |

追加したら右クリックメニューの「ペットを再読み込み」か `/pet list` で確認できます。

## 設定

`~/.claude-pet/config.json` に保存されます。メニューで変えられないものは直接編集してください（再起動後に反映）。

| キー | 既定値 | 内容 |
| --- | --- | --- |
| `pet` | `"mochi"` | 表示するペット |
| `scale` | `0.5` | 大きさ（0.5 / 0.75 / 1） |
| `mini` | `false` | ミニ表示 |
| `showBubble` | `true` | 吹き出しを表示 |
| `notifications` | `false` | 入力待ち・完了・エラーでデスクトップ通知 |
| `language` | `"ja"` | `"ja"` または `"en"` |
| `shortcuts.toggle` / `shortcuts.quickChat` | `CommandOrControl+Alt+P` / `+C` | グローバルショートカット（空文字で無効） |
| `quickChat.permissionMode` | `"default"` | クイックチャットの権限モード（`plan`, `acceptEdits` など） |
| `quickChat.model` | `null` | クイックチャットで使うモデル |
| `claudePath` | `null` | `claude` コマンドの場所（PATH にない場合） |
| `terminalCommand` | `null` | 「ターミナルで開く」のコマンド。例: `"wezterm start --cwd {cwd} -- {command}"` |
| `rotation.enabled` / `rotation.intervalMinutes` | `false` / `60` | ペットの自動交代と、その間隔（分） |
| `rotation.group` / `rotation.pets` | `null` / `[]` | 交代するペットをグループ名か id の一覧で絞る（両方空ならすべて） |
| `rotation.order` | `"shuffle"` | `"shuffle"`（一巡ずつランダム）または `"sequence"`（順番） |
| `staleMinutes` | `30` | 何も届かない「作業中」をひと休みに戻すまでの分数 |
| `port` | `47717` | ペットが待ち受けるポート（環境変数 `CLAUDE_PET_PORT` でも指定可） |

## 仕組み

```text
Claude Code ──(hooks)──▶ src/hook/pet-hook.js ──HTTP──▶ ペット (127.0.0.1:47717)
   SessionStart / UserPromptSubmit / PreToolUse / PermissionRequest /
   Notification / Stop / StopFailure / SessionEnd など
```

- フックは受け取ったイベントを小さく要約して、ローカルのペットに送るだけです。何も出力せず、ペットが起動していなくてもすぐ終了するので、Claude Code の動作には影響しません。
- ツールごとに発生するイベント（`PreToolUse` など）はバックグラウンド（`async`）で実行し、Claude を待たせません。
- `/pet` だけは `UserPromptExpansion` フックで先に処理し、展開をブロックします。そのためモデルは呼ばれません。
- 通信は `127.0.0.1` だけで、外部には何も送りません。ブラウザからのリクエストは拒否します。

## アンインストール

```bash
claude-pet uninstall    # フックと /pet, /hatch-pet を削除（ほかの設定は残ります）
```

そのあと `claude_pet` フォルダと `~/.claude-pet` を削除してください。

## 制限

- 対象は Claude Code のセッションです。claude.ai や Claude アプリの通常のチャットにはフックがないため、追跡できません。
- クラウドで動く Claude Code（Claude Code on the web など）のセッションは、手元のペットに届きません。
- `Esc` で中断した応答には `Stop` が届きません。その場合、次のプロンプトを送るか、Claude Code の `idle_prompt` 通知が届くまで「作業中」のままです（最長でも `staleMinutes` 後にひと休みに戻ります）。
- Linux の Wayland ではウィンドウの位置を変えられない場合があります。

## 開発

```bash
npm test             # テスト
npm start            # ペットを起動（electron .）
npm run build:pet    # tools/designs/mochi.js から pets/mochi とアイコンを作り直す
```

| 場所 | 内容 |
| --- | --- |
| `src/hook/pet-hook.js` | Claude Code から呼ばれるフック |
| `src/core/sessions.js` | フックのイベントからセッションの状態を決める |
| `src/core/server.js` | ローカルの受け口 |
| `src/core/quickchat.js` | クイックチャット（`claude -p --output-format stream-json`） |
| `src/core/installer.js` | `setup` / `uninstall` |
| `src/electron/` , `src/renderer/` | デスクトップアプリ |
| `tools/` | ピクセルアートの描画とスプライトシートの書き出し |
| `skills/` | `/pet` と `/hatch-pet` のひな形 |

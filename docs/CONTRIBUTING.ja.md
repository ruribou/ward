# 貢献

_English: [CONTRIBUTING.md](./CONTRIBUTING.md)_

ward の成長に協力いただきありがとうございます。このガイドは、貢献者がいちばんよく行う作業——**操作（operation）の追加**——を扱います。まず [README](../README.ja.md) を、特に _安全モデル_ と _自律ラダー_ を読んでください。以下の手順はすべて、その保証を保つために存在します。

## 操作とは

**操作（operation）** とは、ward が substrate（NUC）に対して実行できる 1 つの能力で、AI には単一の [MCP](https://modelcontextprotocol.io) ツールとして見えます。ward が実行しうる操作はすべて、リポジトリ直下の [`operations.yaml`](../operations.yaml) に宣言されています——「ward に何ができるか」の単一の真実源（single source of truth）です。この許可リストの外にあるものには一切到達できません。

各操作には **risk（リスク）** クラスがあり、ガードレールのゲートはこのクラスで判定します。

- **`read-only`** — 観察するだけ。substrate を変更できない。常に許可。
- **`mutating`** — substrate を変更する。既定の `read-only` 自律フロアでは禁止（ツールにすら出てこない）。`approval` レベルでも頼んだだけでは動かず、_提案として staged_ され、人間が別ツール `ward approve <id>` を自分のターミナルで叩いたときだけ実行される。AI には承認ツールが無いので、自分の提案を自分で承認できない。

  | autonomy \ risk | read-only | mutating   |
  | --------------- | --------- | ---------- |
  | `read-only`     | 許可      | 禁止       |
  | `approval`      | 許可      | 承認が必要 |

操作の構造は `operations.yaml` に、その人間／LLM 向けの文言（title・description、mutating なら plan）は i18n ラベルファイルに分かれて置かれます。したがって操作の追加は **3 ファイルの変更**です。

1. `operations.yaml` — 操作そのもの（name・risk・command）。
2. `i18n/labels_en.yaml` — 英語ラベル。
3. `i18n/labels_ja.yaml` — 日本語ラベル。

## injection-safety 不変条件

`command` は **定数の argv 配列**です。モデルはその一部すら組み立てず（引数 1 つも）、シェルを通りません（executor は `execFile` を使う）。モデルが注入できる文字列が存在しません。

ローダ（`src/registry/operations.ts`）が起動時にこれを強制し、**fail-closed** です——不正・危険なレジストリは、ツールを 1 つも登録する前にサーバを throw させます。

- `name` は `^sys_[a-z]+(_[a-z]+)*$` に一致——`sys_` プレフィックスの後は、単一のアンダースコアで区切った小文字の語のみ（数字は不可）。
- `risk` はちょうど `read-only` か `mutating`。
- `command`（および任意の `precheck`）の各要素は `^[A-Za-z0-9_.-]+$` に一致——英数字・`_`・`.`・`-`。**スペース・スラッシュ・シェルメタ文字は不可**（`;` `|` `$` `(` `)` `` ` `` …）。つまり `/etc/hosts` のようなパスや `sh -c "…"` のような引数は渡せません。各 argv 要素は裸のトークンです。
- 操作名は一意であること。

許可文字セットが禁じる引数が必要になったら、それは文字セットを広げる合図ではなく、操作の形を見直す合図です。

## 操作を追加する — 実例

`docker version` を read-only 操作として公開したいとします。

### 1. `operations.yaml` に宣言する

```yaml
- name: sys_docker_version
  risk: read-only
  command: [docker, version]
```

read-only 操作の構造変更はこれだけです：`name`、`risk`、定数 `command` argv。

### 2. `i18n/labels_en.yaml` に英語ラベルを追加

`ops:` マップの下、操作名をキーに：

```yaml
sys_docker_version:
  title: Docker version
  description: Returns the Docker client and server versions on the NUC (docker version).
```

### 3. `i18n/labels_ja.yaml` に日本語ラベルを追加

**同じキー**を訳します：

```yaml
sys_docker_version:
  title: Docker バージョン
  description: NUC の Docker クライアント／サーバのバージョン（docker version）を返す。
```

read-only 操作はこれで完了です。

### mutating な操作：plan と precheck も追加する

`mutating` 操作には、人間が裸のコマンド文字列ではなく _informed_ な書き込みを承認できるよう、あと 2 つ要ります。

- **`precheck`**（`operations.yaml`）— 承認者が先に現状を確認できる任意の read-only argv（`command` と同じ文字セット）。ward は _表示_ するだけで、代わりに実行はしません。
- **`plan`**（**両方の**ラベルファイルの `ops.<name>` の下）— 何が変わるかの平易な説明。

既存の `sys_pull_image` の例にならって：

```yaml
# operations.yaml
- name: sys_pull_image
  risk: mutating
  command: [docker, pull, hello-world]
  precheck: [docker, images, hello-world]
```

```yaml
# i18n/labels_en.yaml — under ops:
sys_pull_image:
  title: Pull image
  description: Pulls the Docker image hello-world onto the NUC (docker pull). A write operation that changes the NUC's disk state — it requires approval. Check the result with sys_images.
  plan: Adds the hello-world image to the NUC's local Docker image store. If it is already present this only refreshes it — nothing else changes. Reversible with sys_remove_image.
```

```yaml
# i18n/labels_ja.yaml — under ops:
sys_pull_image:
  title: イメージ取得
  description: NUC に Docker イメージ hello-world を取得する（docker pull）。NUC のディスク状態を変える書き込み操作——承認が要る。取得結果は sys_images で確認できる。
  plan: hello-world イメージを NUC のローカル Docker イメージストアに追加する。既にあれば更新のみで他は変わらない。sys_remove_image で巻き戻せる。
```

良い `plan` は、何が変わるか・既に済んでいる場合に no-op か・どう巻き戻すかを述べます——互いに逆操作である `sys_pull_image` / `sys_remove_image` を参照。

## バイリンガル規約

ward は英語と日本語を同梱します（既定は英語、`WARD_LANG=ja` で切り替え）。**すべてのラベルは `labels_en.yaml` と `labels_ja.yaml` の両方に存在しなければなりません。** read-only 操作は両方に `title` ＋ `description`、mutating 操作はさらに両方に `plan` が要ります。テストスイートがこの parity を強制します——片方のロケールにしか無いラベルは CI で落ちます（_ローカルで検証_ 参照）。

## ローカルで検証

PR を開く前に 4 つすべてを実行：

```bash
npm run typecheck   # tsc --noEmit
npm run lint        # eslint
npm test            # vitest run
npm run format      # prettier --write（その後 format:check を再実行、または次の行）
npm run format:check
```

`src/tests/registry/operations.test.ts` のレジストリテストが操作を honest に保ちます。すべての操作が `sys_` 命名規約に従うこと、既知の risk クラスを持つこと、シェルメタ文字の無い定数コマンドを持つこと、そして——parity ガード——**すべての操作が各ロケールに `title` と `description` を持つこと**、**すべての mutating 操作が各ロケールに `plan` と空でない `precheck` を持つこと**を確認します。ローダ自身のガード（危険な引数・未知の risk・重複名・fail-closed ロード）もそこで網羅されます。日本語ラベルを忘れたり禁止文字を使ったりすると、これらのテストが正確に場所を教えてくれます。

## 変更を提出する

ward は trunk ベースで、`main` への直 push はしません。

```bash
git switch main && git pull
git switch -c feat/your-change
# ...3 ファイルを編集し、ローカルで検証...
git commit -m "feat: add sys_docker_version operation"
git push -u origin feat/your-change
gh pr create --base main
```

コミットメッセージは英語・conventional-commit 形式で。PR では、変更が実 NUC に触れるのか、コード／ドキュメントのみかを明記してください。

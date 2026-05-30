# ward

> 自宅インフラを、**自然言語で・安全に・クライアントから**操作する。
> 安全（ガードレール）が、インフラに不慣れな人でも触れる未来を開く。

ward は、AI（Claude Code）から自宅サーバを操作するための **MCP サーバ**です。
頭脳は手元の Claude Code（サブスク認証＝API キー不要）で、ward は「何ができるか（道具）」を提供する側に徹します。

## いまできること（M1）

**読み取り専用**で NUC の状態を報告します。Claude Code に「NUC 大丈夫?」と聞くと、ward の道具を呼んで状態を集め、要約して返します。**書き込み・破壊は一切できません。**

| 道具             | 中で走る固定コマンド |
| ---------------- | -------------------- |
| `nuc_uptime`     | `uptime`             |
| `nuc_disk`       | `df -h`              |
| `nuc_memory`     | `free -h`            |
| `nuc_containers` | `docker ps`          |
| `nuc_images`     | `docker images`      |

## 安全の不変条件（M1 の核）

事故れないことを、運用ルールではなく**コードの構造で**保証しています:

1. **read-only のみ** — 状態を変える操作はコードに存在しない。
2. **モデルはコマンドも引数も渡せない** — 各コマンドはコード内の定数（`src/operations.ts`）。注入面ゼロ。
3. **ガードレール門** — すべての操作は `guard()` を通り、read-only 以外は実行を拒否（`src/guard.ts`）。
4. **シェル非経由** — `execFile` で SSH を直接起動（`src/executor.ts`）。
5. **秘密を持たない** — 実 IP は `~/.ssh/config`、API キーは不要。リポジトリに秘密は入らない。

## 構成

```
頭脳/クライアント (Claude Code)
        │ MCP (stdio)
        ▼
ward MCP サーバ
  ├─ operations.ts  能力レジストリ（"何ができるか" の単一の真実）
  ├─ guard.ts       ガードレール門（その操作を今 許すか）
  ├─ executor.ts    実行層（substrate への唯一の出口・SSH）
  ├─ audit.ts       監査（操作の痕跡を必ず残す）
  └─ config.ts      設定（秘密なし）
        │ ssh
        ▼
NUC（substrate）
```

## 必要なもの

- Node.js >= 22（現行サポート中の LTS）
- `~/.ssh/config` に NUC への接続エイリアス（既定: `nuc`。`WARD_NUC_HOST` で変更可）
- Claude Code

## セットアップ

```bash
npm install
npm run build
```

Claude Code への登録（例: プロジェクト直下の `.mcp.json`）:

```json
{
  "mcpServers": {
    "ward": { "command": "node", "args": ["./dist/index.js"] }
  }
}
```

開発中はビルド無しでも起動できます（`"command": "npx", "args": ["tsx", "src/index.ts"]`）。

## 開発

```bash
npm run dev          # ビルド無しで起動 (tsx)
npm run typecheck
npm run lint
npm run format
npm test
```

## ロードマップ

- **M1（いま）**: read-only 報告。自律レベル = read-only。
- M2: 自前の tool-use ループ。
- M3: 書き込みを初解禁（dry-run → 人間承認 → 実行）。
- M4: NUC 上で実行 / 任意で常駐。
- M5: 公開・磨き。

## ライセンス

MIT

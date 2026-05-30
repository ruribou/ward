import type { Operation } from "./types.js";

/**
 * The capability registry — ward's single source of truth for "what it can do".
 *
 * M1: every operation is strictly read-only. Adding a capability means adding one
 * entry here, which shows up as a reviewable diff. Each `command` is a constant
 * argv array; the model never supplies commands or arguments.
 */
export const operations: readonly Operation[] = [
  {
    name: "nuc_uptime",
    title: "稼働状況",
    description: "NUC の稼働時間とロードアベレージ（uptime）を返す。",
    risk: "read-only",
    command: ["uptime"],
  },
  {
    name: "nuc_disk",
    title: "ディスク使用量",
    description:
      "NUC のファイルシステム使用量（df -h）を返す。単一 SSD のため満杯は事故源——状態確認の最優先項目。",
    risk: "read-only",
    command: ["df", "-h"],
  },
  {
    name: "nuc_memory",
    title: "メモリ使用量",
    description: "NUC のメモリ／スワップ使用量（free -h）を返す。",
    risk: "read-only",
    command: ["free", "-h"],
  },
  {
    name: "nuc_containers",
    title: "稼働中コンテナ",
    description: "NUC で稼働中の Docker コンテナ一覧（docker ps）を返す。",
    risk: "read-only",
    command: ["docker", "ps"],
  },
  {
    name: "nuc_images",
    title: "Docker イメージ",
    description: "NUC が保持する Docker イメージ一覧（docker images）を返す。",
    risk: "read-only",
    command: ["docker", "images"],
  },
];

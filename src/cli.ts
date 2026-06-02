#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import {
  CONFIG_FILE_KEYS,
  loadConfigFile,
  resolveConfigPath,
  setConfigValue,
} from "./configFile.js";
import { audit as defaultAudit } from "./guardrail/audit.js";
import { formatMetrics, parseAuditLog, summarize } from "./guardrail/metrics.js";
import { ProposalStore } from "./guardrail/proposals.js";
import { getLabel } from "./i18n/index.js";
import { buildPlan, formatResult } from "./render.js";
import { runOperation as defaultRunOperation } from "./substrate/executor.js";
import type { AuditEntry, ExecResult, Locale, Operation } from "./types.js";

/**
 * `ward` — the HUMAN's surface, deliberately separate from the AI's MCP server.
 *
 * The MCP server can only *propose* mutating operations (it has no approve tool);
 * a proposal sits in the shared proposal store until a human runs this CLI in
 * their own terminal. `ward approve <id>` is the only thing that executes a
 * mutating operation — so approval happens out of band, in a process the AI does
 * not drive. That is what makes "a human approves" a structural fact, not a norm
 * the AI is asked to honour.
 */
export interface CliDeps {
  runOperation: (op: Operation) => Promise<ExecResult>;
  audit: (entry: AuditEntry) => void;
  proposals: ProposalStore;
  lang: Locale;
  /** Sink for output lines; injected so tests can capture without touching stdout. */
  out: (line: string) => void;
  /** Reads an audit log file; injected so the metrics summarizer is testable without disk. */
  readFile: (path: string) => string;
  /** Reads a piped audit log from stdin; injected for tests. */
  readStdin: () => string;
  /** Path of the user config file (~/.ward/config.yaml); injected so tests use a temp file. */
  configFilePath: string;
}

/** Run one `ward` invocation. Returns the process exit code. */
export async function runCli(argv: string[], deps: Partial<CliDeps> = {}): Promise<number> {
  const proposals = deps.proposals ?? new ProposalStore();
  const lang = deps.lang ?? config.lang;
  const out = deps.out ?? ((line: string) => process.stdout.write(`${line}\n`));
  const runOperation = deps.runOperation ?? defaultRunOperation;
  const audit = deps.audit ?? defaultAudit;
  const readFile = deps.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  const readStdin = deps.readStdin ?? (() => readFileSync(0, "utf8"));
  const configFilePath = deps.configFilePath ?? resolveConfigPath();

  const [command, id] = argv;

  switch (command) {
    case "list":
    case "pending": {
      const pending = proposals.list();
      if (pending.length === 0) {
        out(getLabel("cli.noPending", lang));
        return 0;
      }
      out(getLabel("cli.pendingHeader", lang));
      for (const proposal of pending) {
        out(`  ${proposal.id}: $ ${proposal.op.command.join(" ")}${buildPlan(proposal.op, lang)}`);
      }
      return 0;
    }

    case "approve": {
      if (id === undefined) {
        out(getLabel("cli.usage", lang));
        return 2;
      }
      const proposal = proposals.consume(id);
      if (proposal === null) {
        out(getLabel("cli.notFound", lang, { id }));
        return 1;
      }
      const result = await runOperation(proposal.op);
      audit({ event: "executed", op: proposal.op, result, proposalId: proposal.id });
      out(formatResult(proposal.op, result));
      return result.exitCode === 0 ? 0 : 1;
    }

    case "reject": {
      if (id === undefined) {
        out(getLabel("cli.usage", lang));
        return 2;
      }
      const proposal = proposals.consume(id);
      if (proposal === null) {
        out(getLabel("cli.notFound", lang, { id }));
        return 1;
      }
      audit({ event: "rejected", op: proposal.op, proposalId: proposal.id });
      out(getLabel("cli.discarded", lang, { id }));
      return 0;
    }

    case "metrics": {
      const rest = argv.slice(1);
      const json = rest.includes("--json");
      const source = rest.find((arg) => !arg.startsWith("-")) ?? config.auditLog;
      if (source === undefined && deps.readStdin === undefined && process.stdin.isTTY === true) {
        out(getLabel("cli.metricsNoSource", lang));
        return 2;
      }
      let text: string;
      try {
        text = source === undefined ? readStdin() : readFile(source);
      } catch (err) {
        out(
          getLabel("cli.metricsReadFailed", lang, {
            source: source ?? "<stdin>",
            error: err instanceof Error ? err.message : String(err),
          }),
        );
        return 1;
      }
      const metrics = summarize(parseAuditLog(text));
      out(json ? JSON.stringify(metrics) : formatMetrics(metrics));
      return 0;
    }

    case "config": {
      const sub = argv[1] ?? "get";
      switch (sub) {
        case "get": {
          const stored = loadConfigFile(configFilePath);
          out(getLabel("cli.config.getHeader", lang, { path: configFilePath }));
          for (const key of CONFIG_FILE_KEYS) {
            const value = stored[key];
            out(
              value === undefined || value === ""
                ? getLabel("cli.config.unsetLine", lang, { key })
                : getLabel("cli.config.valueLine", lang, { key, value }),
            );
          }
          return 0;
        }
        case "path": {
          out(getLabel("cli.config.path", lang, { path: configFilePath }));
          return 0;
        }
        case "set": {
          const [key, value] = argv.slice(2);
          if (key === undefined || value === undefined) {
            out(getLabel("cli.config.usage", lang));
            return 2;
          }
          try {
            setConfigValue(configFilePath, key, value);
          } catch (err) {
            const known = (CONFIG_FILE_KEYS as readonly string[]).includes(key);
            out(
              getLabel(known ? "cli.config.invalidValue" : "cli.config.unknownKey", lang, {
                key,
                value,
                error: err instanceof Error ? err.message : String(err),
              }),
            );
            return 2;
          }
          out(getLabel("cli.config.setOk", lang, { key, value, path: configFilePath }));
          return 0;
        }
        default:
          out(getLabel("cli.config.usage", lang));
          return 2;
      }
    }

    default:
      out(getLabel("cli.usage", lang));
      return command === undefined ? 0 : 2;
  }
}

/**
 * Was this module invoked directly as the entry (the `ward` binary), rather than
 * imported by a test? `npm`/`nodebrew` install the bin as a SYMLINK to dist/cli.js,
 * so process.argv[1] is the symlink path while import.meta.url is the resolved real
 * path — a plain string compare misses, and the CLI would silently do nothing.
 * Resolving both with realpath makes the symlinked bin match.
 */
export function isEntrypoint(argv1: string | undefined, moduleUrl: string): boolean {
  if (argv1 === undefined) {
    return false;
  }
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

if (isEntrypoint(process.argv[1], import.meta.url)) {
  process.exit(await runCli(process.argv.slice(2)));
}

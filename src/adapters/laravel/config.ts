/**
 * Configuration: which environment keys the code reads, by name only.
 * Values are never read: .env is not opened at all, and only the key names of
 * .env.example are used. Defaults written in code are noted as "has a default",
 * never copied.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ConfigFact, SkippedFact } from "../../core/types.js";
import { phpFiles, type PhpCache } from "./files.js";
import { lineOf, phpText, stringValue, walk, type PhpNode } from "./php.js";

export interface ConfigResult {
  keys: ConfigFact[];
  /** config key ("services.erp.url") -> env keys behind it. */
  configEnv: Map<string, string[]>;
  skipped: SkippedFact[];
}

export function readConfig(root: string, php: PhpCache): ConfigResult {
  const keys = new Map<string, ConfigFact>();
  const configEnv = new Map<string, string[]>();
  const skipped: SkippedFact[] = [];
  const key = (name: string): ConfigFact => {
    let k = keys.get(name);
    if (!k) {
      k = { kind: "config", key: name, uses: [], inExample: false };
      keys.set(name, k);
    }
    return k;
  };

  // 1. config/*.php: return [ 'erp' => [ 'url' => env('ERP_URL') ] ]
  for (const file of phpFiles(root, "config", 2)) {
    const parsed = php.get(file);
    if (!parsed) continue;
    const prefix = file.replace(/^config\//, "").replace(/\.php$/, "").split("/").join(".");
    const seen = new Set<PhpNode>();
    walk(parsed.ast, (n) => {
      if (n.kind === "return" && n.expr?.kind === "array") {
        readConfigArray(n.expr, prefix, file, (envKey, path, call) => {
          seen.add(call);
          key(envKey).uses.push({ source: { file, line: lineOf(call) }, config: path, hasDefault: (call.arguments ?? []).length > 1 });
          for (let i = path.split(".").length; i >= 1; i--) {
            const p = path.split(".").slice(0, i).join(".");
            const list = configEnv.get(p) ?? [];
            if (!list.includes(envKey)) list.push(envKey);
            configEnv.set(p, list);
          }
        });
      }
    });
    // env() outside the returned array (rare) still counts
    walk(parsed.ast, (n) => {
      if (isEnvCall(n) && !seen.has(n)) recordEnv(n, file, key, skipped);
    });
  }

  // 2. env() anywhere else in the app (it returns null once config is cached)
  for (const dir of ["app", "routes", "bootstrap", "database"]) {
    for (const file of phpFiles(root, dir)) {
      const parsed = php.get(file);
      if (!parsed) continue;
      walk(parsed.ast, (n) => {
        if (isEnvCall(n)) recordEnv(n, file, key, skipped);
      });
    }
  }

  // 3. .env.example: key names only
  const example = join(root, ".env.example");
  if (existsSync(example)) {
    for (const line of readFileSync(example, "utf8").split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
      if (m) key(m[1]).inExample = true;
    }
  }

  for (const k of keys.values()) if (isLaravelKey(k.key)) k.framework = true;
  return { keys: [...keys.values()].sort((a, b) => a.key.localeCompare(b.key)), configEnv, skipped };
}

/**
 * Keys read by the config files and .env.example that ship with Laravel (8 to 12),
 * so the docs can tell them apart from the keys a team added for its own app.
 */
const LARAVEL_KEYS = new Set(
  `APP_NAME APP_ENV APP_KEY APP_DEBUG APP_URL APP_TIMEZONE APP_LOCALE APP_FALLBACK_LOCALE APP_FAKER_LOCALE APP_CIPHER
  APP_MAINTENANCE_DRIVER APP_MAINTENANCE_STORE APP_PREVIOUS_KEYS ASSET_URL BCRYPT_ROUNDS ARGON_MEMORY ARGON_THREADS ARGON_TIME
  HASH_DRIVER HASH_VERIFY AUTH_GUARD AUTH_PASSWORD_BROKER AUTH_MODEL AUTH_PASSWORD_RESET_TOKEN_TABLE AUTH_PASSWORD_TIMEOUT
  LOG_CHANNEL LOG_STACK LOG_LEVEL LOG_DAILY_DAYS LOG_DEPRECATIONS_CHANNEL LOG_DEPRECATIONS_TRACE LOG_SLACK_WEBHOOK_URL
  LOG_SLACK_USERNAME LOG_SLACK_EMOJI LOG_PAPERTRAIL_HANDLER LOG_STDERR_FORMATTER LOG_SYSLOG_FACILITY
  DB_CONNECTION DB_HOST DB_PORT DB_DATABASE DB_USERNAME DB_PASSWORD DB_URL DATABASE_URL DB_SOCKET DB_CHARSET DB_COLLATION
  DB_FOREIGN_KEYS DB_ENCRYPT DB_TRUST_SERVER_CERTIFICATE MYSQL_ATTR_SSL_CA DB_CACHE_CONNECTION DB_CACHE_TABLE
  DB_CACHE_LOCK_CONNECTION DB_CACHE_LOCK_TABLE DB_QUEUE_CONNECTION DB_QUEUE_TABLE DB_QUEUE DB_QUEUE_RETRY_AFTER
  BROADCAST_DRIVER BROADCAST_CONNECTION CACHE_DRIVER CACHE_STORE CACHE_PREFIX FILESYSTEM_DRIVER FILESYSTEM_CLOUD FILESYSTEM_DISK
  QUEUE_CONNECTION QUEUE_DRIVER QUEUE_FAILED_DRIVER SESSION_DRIVER SESSION_LIFETIME SESSION_ENCRYPT SESSION_PATH SESSION_DOMAIN
  SESSION_CONNECTION SESSION_STORE SESSION_COOKIE SESSION_SECURE_COOKIE SESSION_EXPIRE_ON_CLOSE SESSION_HTTP_ONLY
  SESSION_SAME_SITE SESSION_PARTITIONED_COOKIE SESSION_TABLE MAIL_MAILER MAIL_DRIVER MAIL_HOST MAIL_PORT MAIL_USERNAME
  MAIL_PASSWORD MAIL_ENCRYPTION MAIL_SCHEME MAIL_URL MAIL_FROM_ADDRESS MAIL_FROM_NAME MAIL_EHLO_DOMAIN MAIL_LOG_CHANNEL
  MAIL_SENDMAIL_PATH MAILGUN_DOMAIN MAILGUN_SECRET MAILGUN_ENDPOINT MAILGUN_SCHEME POSTMARK_TOKEN POSTMARK_MESSAGE_STREAM_ID
  RESEND_KEY SANCTUM_STATEFUL_DOMAINS SANCTUM_TOKEN_PREFIX VIEW_COMPILED_PATH SLACK_BOT_USER_OAUTH_TOKEN
  SLACK_BOT_USER_DEFAULT_CHANNEL`.split(/\s+/),
);
const LARAVEL_PREFIXES = /^(REDIS|MEMCACHED|PUSHER|REVERB|ABLY|VITE|MIX|PAPERTRAIL|DYNAMODB|SQS|SES|AWS)_/;

export function isLaravelKey(key: string): boolean {
  return LARAVEL_KEYS.has(key) || LARAVEL_PREFIXES.test(key);
}

function readConfigArray(arr: PhpNode, path: string, file: string, onEnv: (key: string, path: string, call: PhpNode) => void): void {
  for (const it of arr.items ?? []) {
    if (it?.kind !== "entry") continue;
    const k = it.key ? stringValue(it.key) : null;
    const childPath = k !== null ? `${path}.${k}` : path;
    if (it.value?.kind === "array") readConfigArray(it.value, childPath, file, onEnv);
    else {
      walk(it.value, (n) => {
        if (isEnvCall(n)) {
          const envKey = stringValue(n.arguments?.[0]);
          if (envKey) onEnv(envKey, childPath, n);
        }
      });
    }
  }
}

function isEnvCall(n: PhpNode): boolean {
  return n?.kind === "call" && n.what?.kind === "name" && /^\\?(env|getenv)$/.test(n.what.name);
}

function recordEnv(n: PhpNode, file: string, key: (k: string) => ConfigFact, skipped: SkippedFact[]): void {
  const name = stringValue(n.arguments?.[0]);
  if (!name) {
    skipped.push({ kind: "skipped", reason: `Environment key not readable: ${phpText(n)}`, source: { file, line: lineOf(n) } });
    return;
  }
  key(name).uses.push({ source: { file, line: lineOf(n) }, hasDefault: (n.arguments ?? []).length > 1 });
}

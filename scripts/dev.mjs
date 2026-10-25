/**
 * 同时启动后端和前端。
 *
 * 不用 `pnpm --parallel`。在 Windows 上它会给子进程留一条一直开着的 stdin 管道，
 * 后端进程会停住：进程还在、不占 CPU、8787 不监听，也没有报错。
 * 这里分别 spawn，stdin 设为 ignore，stdout / stderr 立刻转发。Ctrl+C 一起停。
 *
 * 启动前按 DATABASE_URL 探测数据库端口。Windows 上若是本机地址且连不上，
 * 用 WSL 执行 `service postgresql start`，并留一个 `sleep infinity` 保活，
 * 避免发行版闲置后被系统停掉。退出时只结束保活进程，不停止 PostgreSQL。
 *
 * 用法：node scripts/dev.mjs
 * 通常由根目录的 `pnpm dev` 在编译检索包之后调用。
 */
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isWindows = process.platform === "win32";
const DB_PROBE_TIMEOUT_MS = 1000;
const DB_WAIT_TIMEOUT_MS = 30_000;
const DB_WAIT_INTERVAL_MS = 500;

const services = [
  { name: "backend", dir: path.join(root, "packages", "backend") },
  { name: "frontend", dir: path.join(root, "packages", "frontend") },
];

export function isInvokedDirectly(entry, moduleUrl) {
  if (!entry) return false;
  return moduleUrl === pathToFileURL(path.resolve(entry)).href;
}

/** 与 packages/backend/src/env.ts 相同：不覆盖已经存在的环境变量。 */
export function parseEnvFile(text) {
  const values = {};
  for (const line of String(text).split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

export function readConfigValue(name, fileValues, env = process.env) {
  if (env[name] !== undefined) return env[name];
  return fileValues[name];
}

export function readDotEnv(file) {
  if (!existsSync(file)) return {};
  return parseEnvFile(readFileSync(file, "utf8"));
}

export function isSkipDbStart(value) {
  return typeof value === "string" && value.trim() === "1";
}

export function normalizeDistro(value) {
  if (typeof value !== "string") return undefined;
  const name = value.trim();
  return name || undefined;
}

/**
 * 只取出主机和端口。调用方用这个结果打日志，避免把连接串里的密码打印出来。
 * 没写端口时按 PostgreSQL 默认的 5432。
 */
export function parseDatabaseTarget(databaseUrl) {
  if (typeof databaseUrl !== "string") return null;
  const raw = databaseUrl.trim();
  if (!raw) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") return null;
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host) return null;
  const port = url.port === "" ? 5432 : Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port };
}

/** 只有这两个地址才在 Windows 上尝试拉起 WSL 里的 PostgreSQL。 */
export function isLocalDatabaseHost(host) {
  const name = String(host ?? "")
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  return name === "localhost" || name === "127.0.0.1";
}

export function actionAfterProbe({ platform, host, reachable }) {
  if (reachable) return "ready";
  if (platform === "win32" && isLocalDatabaseHost(host)) return "start-wsl";
  return "hint";
}

/**
 * 本机库在 Windows 上视为 WSL 里的 PostgreSQL。
 * 已经连得上，或者刚刚成功调用过 wsl 时，挂保活，避免发行版闲置后被停掉。
 * 找不到 wsl 时不挂。
 */
export function shouldKeepWslAlive({ platform, host, reachable, wslMissing }) {
  if (platform !== "win32" || !isLocalDatabaseHost(host)) return false;
  if (reachable) return true;
  return wslMissing === false;
}

export function buildWslServiceStartArgs(distro) {
  const args = [];
  const name = normalizeDistro(distro);
  if (name) args.push("-d", name);
  args.push("-u", "root", "service", "postgresql", "start");
  return args;
}

export function buildWslKeepaliveArgs(distro) {
  const args = [];
  const name = normalizeDistro(distro);
  if (name) args.push("-d", name);
  args.push("--", "sleep", "infinity");
  return args;
}

function quoteShellWord(word) {
  const text = String(word);
  if (text === "") return '""';
  if (/[\s"]/.test(text)) return `"${text.replace(/"/g, '\\"')}"`;
  return text;
}

/** 只用于打印给用户看的手动命令，真正执行时走参数数组，不经过 shell。 */
export function formatShellCommand(program, args) {
  return [program, ...args].map(quoteShellWord).join(" ");
}

export function redactSensitive(text, databaseUrl) {
  let out = String(text ?? "");
  const secrets = new Set();
  if (typeof databaseUrl === "string" && databaseUrl) {
    secrets.add(databaseUrl);
    secrets.add(databaseUrl.trim());
    try {
      const url = new URL(databaseUrl.trim());
      if (url.password) {
        secrets.add(url.password);
        secrets.add(`${url.username}:${url.password}`);
        try {
          const decoded = decodeURIComponent(url.password);
          if (decoded) secrets.add(decoded);
        } catch {
          // 密码里有非法 % 转义时，只遮住原文。
        }
      }
    } catch {
      // 整段连接串已经放进 secrets。
    }
  }
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join("***");
  }
  return out.replace(/\s+/g, " ").trim().slice(0, 200);
}

export function probeTcp(host, port, timeoutMs = DB_PROBE_TIMEOUT_MS) {
  const limit = Math.max(1, timeoutMs);
  return new Promise((resolve) => {
    let socket;
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      if (socket) {
        socket.removeAllListeners();
        socket.destroy();
      }
      resolve(ok);
    };
    try {
      socket = net.connect({ host, port });
    } catch {
      finish(false);
      return;
    }
    socket.setTimeout(limit);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function waitForTcp(host, port, options = {}) {
  const timeoutMs = options.timeoutMs ?? DB_WAIT_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? DB_WAIT_INTERVAL_MS;
  const probeTimeoutMs = options.probeTimeoutMs ?? DB_PROBE_TIMEOUT_MS;
  const shouldStop = options.shouldStop ?? (() => false);
  const runProbe = options.probe
    ? (nextHost, nextPort) => options.probe(nextHost, nextPort)
    : (nextHost, nextPort, limit) => probeTcp(nextHost, nextPort, limit);
  const deadline = Date.now() + timeoutMs;
  while (!shouldStop()) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    let open = false;
    try {
      open = Boolean(await runProbe(host, port, Math.min(probeTimeoutMs, remaining)));
    } catch {
      open = false;
    }
    if (open) return true;
    const after = deadline - Date.now();
    if (after <= 0) return false;
    await delay(Math.min(intervalMs, after));
  }
  return false;
}

function formatDuration(ms) {
  if (ms >= 1000 && ms % 1000 === 0) return `${ms / 1000} 秒`;
  return `${ms} 毫秒`;
}

function keepaliveLog(distro) {
  const which = distro ? `发行版 ${distro}` : "WSL 默认发行版";
  return `[db] 已启动 WSL 保活（${which}），避免闲置后自动停止。退出时会结束保活进程，不会停止 PostgreSQL。`;
}

async function openKeepaliveAndLog(openKeepalive, distro, log, warn) {
  try {
    const opened = await openKeepalive(buildWslKeepaliveArgs(distro));
    if (opened && opened.ok === false) {
      warn(`[db] WSL 保活没有启动：${opened.message || "未知错误"}`);
      return;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warn(`[db] WSL 保活没有启动：${message}`);
    return;
  }
  log(keepaliveLog(distro));
}

/**
 * 探测数据库，必要时在 Windows 上通过 WSL 启动。
 * 失败只打印说明，不抛错，调用方继续启动前后端。
 */
export async function ensureDatabase(options = {}) {
  const log = options.log ?? ((line) => console.log(line));
  const warn = options.warn ?? ((line) => console.error(line));
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const fileValues =
    options.fileValues ?? readDotEnv(options.envFile ?? path.join(root, ".env"));
  const probe =
    options.probe ??
    ((host, port) => probeTcp(host, port, options.probeTimeoutMs ?? DB_PROBE_TIMEOUT_MS));
  const spawnService = options.spawnService ?? ((args) => runWslCommand(args));
  const openKeepalive = options.openKeepalive ?? ((args) => startKeepaliveProcess(args));
  const shouldStop = options.shouldStop ?? (() => stopping);
  const waitTimeoutMs = options.waitTimeoutMs ?? DB_WAIT_TIMEOUT_MS;
  const waitIntervalMs = options.waitIntervalMs ?? DB_WAIT_INTERVAL_MS;

  if (isSkipDbStart(readConfigValue("SKIP_DB_START", fileValues, env))) {
    log("[db] 已跳过数据库检查（SKIP_DB_START=1）。");
    return;
  }

  const databaseUrl = readConfigValue("DATABASE_URL", fileValues, env);
  if (typeof databaseUrl !== "string" || databaseUrl.trim() === "") {
    log("[db] 未配置 DATABASE_URL，跳过数据库检查。");
    return;
  }

  const target = parseDatabaseTarget(databaseUrl);
  if (!target) {
    warn("[db] DATABASE_URL 无法解析出主机和端口，跳过自动启动。请检查 .env 里的连接串。仍会继续启动前后端。");
    return;
  }

  const where = `${target.host}:${target.port}`;
  log(`[db] 正在检查 ${where} …`);
  let reachable = false;
  try {
    reachable = Boolean(await probe(target.host, target.port));
  } catch {
    reachable = false;
  }
  if (shouldStop()) return;

  const distro = normalizeDistro(readConfigValue("WSL_DISTRO", fileValues, env));
  const manual = formatShellCommand("wsl", buildWslServiceStartArgs(distro));
  const action = actionAfterProbe({ platform, host: target.host, reachable });

  if (action === "ready") {
    log(`[db] 数据库已就绪（${where}）。`);
    if (shouldKeepWslAlive({ platform, host: target.host, reachable: true, wslMissing: false })) {
      await openKeepaliveAndLog(openKeepalive, distro, log, warn);
    }
    return;
  }

  if (action !== "start-wsl") {
    if (platform === "win32") {
      warn(
        `[db] 数据库不可达（${where}）。主机不是 localhost 或 127.0.0.1，不会通过 WSL 启动。请确认数据库已在运行。仍会继续启动前后端。`,
      );
    } else {
      warn(
        `[db] 数据库不可达（${where}）。当前系统不会自动启动数据库，请先自行启动 PostgreSQL。仍会继续启动前后端。`,
      );
    }
    return;
  }

  log(`[db] 数据库不可达（${where}），正在通过 WSL 启动 PostgreSQL…`);
  log(`[db] 执行：${manual}`);
  let result;
  try {
    result = await spawnService(buildWslServiceStartArgs(distro));
  } catch (error) {
    result = {
      missing: false,
      code: 1,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  if (shouldStop()) return;
  if (result?.missing) {
    warn(`[db] 没有找到 wsl 命令，无法自动启动 PostgreSQL。可手动执行：${manual}`);
    warn("[db] 仍会继续启动前后端。");
    return;
  }

  if (typeof result?.code === "number" && result.code !== 0) {
    warn(`[db] 启动命令退出码为 ${result.code}。`);
    const detail = redactSensitive(result.detail, databaseUrl);
    if (detail) warn(`[db] wsl 输出：${detail}`);
  }

  if (shouldKeepWslAlive({ platform, host: target.host, reachable: false, wslMissing: false })) {
    await openKeepaliveAndLog(openKeepalive, distro, log, warn);
  }

  log(
    `[db] 正在等待 ${where}（每 ${formatDuration(waitIntervalMs)}探测一次，最多 ${formatDuration(waitTimeoutMs)}）。`,
  );
  const up = await waitForTcp(target.host, target.port, {
    timeoutMs: waitTimeoutMs,
    intervalMs: waitIntervalMs,
    probe,
    shouldStop,
  });
  if (shouldStop()) return;
  if (up) {
    log(`[db] 数据库已就绪（${where}）。`);
    return;
  }
  warn(`[db] 等待 ${formatDuration(waitTimeoutMs)}后仍然连不上 ${where}。可手动执行：${manual}`);
  warn("[db] 仍会继续启动前后端。");
}

function resolveBin(packageDir, packageName) {
  const require = createRequire(path.join(packageDir, "package.json"));
  let packageJsonPath;
  try {
    packageJsonPath = require.resolve(`${packageName}/package.json`);
  } catch {
    throw new Error(`找不到依赖 ${packageName}。请先在仓库根目录执行 pnpm install。`);
  }
  const manifest = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  const bin = manifest.bin;
  const relative = typeof bin === "string" ? bin : bin?.[packageName];
  if (!relative) {
    throw new Error(`${packageName} 没有可执行文件 ${packageName}。`);
  }
  return path.resolve(path.dirname(packageJsonPath), relative);
}

function commandFromDevScript(packageDir) {
  const manifest = JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8"));
  const script = manifest.scripts?.dev?.trim();
  if (!script) {
    throw new Error(`${path.relative(root, packageDir)} 没有 dev 脚本。`);
  }
  if (/[|&;<>]/.test(script) || script.includes("\n")) {
    throw new Error(`dev 脚本只能是一条直接命令，不能包含 shell 运算符：${script}`);
  }
  const [binName, ...args] = script.split(/\s+/);
  return { bin: resolveBin(packageDir, binName), args };
}

function forward(stream, destination, name) {
  if (!stream) return;
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  lines.on("line", (line) => {
    destination.write(`[${name}] ${line}\n`);
  });
}

function signalPid(pid, signal) {
  try {
    process.kill(pid, signal);
  } catch {
    // 进程已经退出。
  }
}

function stopChild(child, signal) {
  const pid = child.pid;
  if (!pid) return;
  if (isWindows) {
    // /T 连同 tsx、vite 拉起的子进程一起结束。
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }
  if (signal === "SIGKILL") {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      signalPid(pid, "SIGKILL");
    }
    return;
  }
  // 只通知直接子进程。tsx / vite 会自己关掉它们拉起的进程。
  // 若把信号打到整个进程组，后端会收到两次，pool.end() 会抛错。
  signalPid(pid, signal);
}

const children = new Set();
let stopping = false;
let exitCode = 0;
let killTimer;
let wslStartChild;
let keepaliveChild;

function stopTracked(child) {
  if (!child) return;
  stopChild(child, "SIGTERM");
}

function stopAll(code) {
  if (stopping) return;
  stopping = true;
  exitCode = code;
  for (const child of children) stopChild(child, "SIGTERM");
  // 保活只是 WSL 里的 sleep infinity。结束这个进程不会停止 PostgreSQL。
  stopTracked(wslStartChild);
  stopTracked(keepaliveChild);
  killTimer = setTimeout(() => {
    for (const child of children) stopChild(child, "SIGKILL");
    stopTracked(wslStartChild);
    stopTracked(keepaliveChild);
    process.exit(exitCode);
  }, 3000);
  killTimer.unref();
  if (children.size === 0) process.exit(exitCode);
}

function watchChild(child, name) {
  children.add(child);
  let settled = false;
  const finish = (code) => {
    if (settled) return;
    settled = true;
    children.delete(child);
    if (!stopping) {
      console.error(`[${name}] 已退出（code ${code}），正在停止另一个进程`);
      stopAll(code);
      return;
    }
    if (children.size === 0) process.exit(exitCode);
  };
  child.on("error", (error) => {
    console.error(`[${name}] 启动失败：${error.message}`);
    finish(1);
  });
  child.on("exit", (code) => {
    finish(code === null ? 1 : code);
  });
}

function start(service, command) {
  const child = spawn(process.execPath, [command.bin, ...command.args], {
    cwd: service.dir,
    env: process.env,
    // stdin 用 ignore，避免 Windows 上留下一条没人关的管道。
    // 不要 windowsHide：那会脱离控制台，Ctrl+C 到不了子进程。
    stdio: ["ignore", "pipe", "pipe"],
    detached: !isWindows,
  });
  forward(child.stdout, process.stdout, service.name);
  forward(child.stderr, process.stderr, service.name);
  watchChild(child, service.name);
}

function runWslCommand(args) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("wsl", args, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      resolve({
        missing: error?.code === "ENOENT",
        code: 1,
        detail: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    wslStartChild = child;
    let output = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (wslStartChild === child) wslStartChild = undefined;
      resolve(result);
    };
    child.stdout?.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.once("error", (error) => {
      finish({ missing: error.code === "ENOENT", code: 1, detail: error.message });
    });
    child.once("exit", (code) => {
      finish({ missing: false, code: code ?? 1, detail: output });
    });
  });
}

function startKeepaliveProcess(args) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("wsl", args, {
        // stdin 忽略，避免 Windows 上留下没人关的管道。保活不需要输出。
        stdio: ["ignore", "ignore", "ignore"],
        windowsHide: true,
      });
    } catch (error) {
      resolve({ ok: false, message: error instanceof Error ? error.message : String(error) });
      return;
    }
    keepaliveChild = child;
    let spawned = false;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child.once("error", (error) => {
      if (keepaliveChild === child) keepaliveChild = undefined;
      finish({ ok: false, message: error.message });
    });
    child.once("spawn", () => {
      spawned = true;
      finish({ ok: true });
    });
    child.once("exit", (code) => {
      if (keepaliveChild === child) keepaliveChild = undefined;
      if (spawned && !stopping) {
        const status = code === null ? 1 : code;
        console.error(`[db] WSL 保活已退出（code ${status}）。发行版闲置后仍可能自动停止。`);
      }
    });
  });
}

async function main() {
  process.on("SIGINT", () => {
    console.log("\n正在停止后端和前端…");
    stopAll(0);
  });
  process.on("SIGTERM", () => {
    stopAll(0);
  });

  try {
    const commands = services.map((service) => ({
      service,
      command: commandFromDevScript(service.dir),
    }));
    await ensureDatabase();
    if (stopping) return;
    const port = process.env.PORT?.trim() || "8787";
    console.log(`同时启动后端 http://127.0.0.1:${port} 和前端 http://127.0.0.1:5174 。Ctrl+C 一起停止。`);
    for (const { service, command } of commands) start(service, command);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    stopAll(1);
  }
}

if (isInvokedDirectly(process.argv[1], import.meta.url)) {
  void main();
}

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import {
  actionAfterProbe,
  buildWslKeepaliveArgs,
  buildWslServiceStartArgs,
  ensureDatabase,
  formatShellCommand,
  isInvokedDirectly,
  isLocalDatabaseHost,
  isSkipDbStart,
  parseDatabaseTarget,
  parseEnvFile,
  probeTcp,
  readConfigValue,
  redactSensitive,
  shouldKeepWslAlive,
} from "./dev.mjs";

const SECRET_URL = "postgres://resume:Sup3rSecret@127.0.0.1:5432/resume";

test("直接运行脚本时才进入启动流程", () => {
  const moduleUrl = pathToFileURL(path.resolve("scripts/dev.mjs")).href;
  assert.equal(isInvokedDirectly(undefined, moduleUrl), false);
  assert.equal(isInvokedDirectly("", moduleUrl), false);
  assert.equal(isInvokedDirectly(path.resolve("scripts/dev.mjs"), moduleUrl), true);
  assert.equal(isInvokedDirectly(path.resolve("scripts/dev.test.mjs"), moduleUrl), false);
});

test("解析 DATABASE_URL 只保留主机和端口", () => {
  assert.deepEqual(parseDatabaseTarget(SECRET_URL), { host: "127.0.0.1", port: 5432 });
  assert.deepEqual(parseDatabaseTarget("postgresql://resume:Sup3rSecret@LocalHost/resume"), {
    host: "localhost",
    port: 5432,
  });
  assert.deepEqual(parseDatabaseTarget("postgres://resume:p%40ss@[::1]:5433/resume"), {
    host: "::1",
    port: 5433,
  });
  assert.equal(parseDatabaseTarget("postgres:///resume"), null);
  assert.equal(parseDatabaseTarget("mysql://127.0.0.1:5432/resume"), null);
  assert.equal(parseDatabaseTarget("not a url"), null);
  assert.equal(parseDatabaseTarget(""), null);
  assert.equal(JSON.stringify(parseDatabaseTarget(SECRET_URL)).includes("Sup3rSecret"), false);
});

test("只有 localhost 和 127.0.0.1 算本机", () => {
  assert.equal(isLocalDatabaseHost("localhost"), true);
  assert.equal(isLocalDatabaseHost("LocalHost"), true);
  assert.equal(isLocalDatabaseHost("127.0.0.1"), true);
  assert.equal(isLocalDatabaseHost("[127.0.0.1]"), true);
  assert.equal(isLocalDatabaseHost("::1"), false);
  assert.equal(isLocalDatabaseHost("db.example.com"), false);
  assert.equal(isLocalDatabaseHost("10.0.0.1"), false);
});

test("Windows 本机且连不上时才启动 WSL", () => {
  assert.equal(actionAfterProbe({ platform: "win32", host: "127.0.0.1", reachable: false }), "start-wsl");
  assert.equal(actionAfterProbe({ platform: "win32", host: "localhost", reachable: false }), "start-wsl");
  assert.equal(actionAfterProbe({ platform: "win32", host: "127.0.0.1", reachable: true }), "ready");
  assert.equal(actionAfterProbe({ platform: "win32", host: "db.example.com", reachable: false }), "hint");
  assert.equal(actionAfterProbe({ platform: "win32", host: "::1", reachable: false }), "hint");
  assert.equal(actionAfterProbe({ platform: "linux", host: "127.0.0.1", reachable: false }), "hint");
  assert.equal(actionAfterProbe({ platform: "darwin", host: "localhost", reachable: false }), "hint");
});

test("保活只在 Windows 本机、并且 WSL 真正用得上时开启", () => {
  const localDown = { platform: "win32", host: "127.0.0.1", reachable: false, wslMissing: false };
  const localUp = { platform: "win32", host: "localhost", reachable: true, wslMissing: false };
  assert.equal(shouldKeepWslAlive(localDown), true);
  assert.equal(shouldKeepWslAlive(localUp), true);
  assert.equal(shouldKeepWslAlive({ ...localDown, wslMissing: true }), false);
  assert.equal(shouldKeepWslAlive({ ...localDown, platform: "linux" }), false);
  assert.equal(shouldKeepWslAlive({ ...localUp, host: "10.1.2.3" }), false);
});

test("WSL 命令：有发行版才加 -d，保活使用 sleep infinity", () => {
  assert.deepEqual(buildWslServiceStartArgs("Ubuntu-24.04"), [
    "-d",
    "Ubuntu-24.04",
    "-u",
    "root",
    "service",
    "postgresql",
    "start",
  ]);
  assert.deepEqual(buildWslServiceStartArgs("  "), ["-u", "root", "service", "postgresql", "start"]);
  assert.deepEqual(buildWslServiceStartArgs(undefined), ["-u", "root", "service", "postgresql", "start"]);
  assert.deepEqual(buildWslKeepaliveArgs("Ubuntu-24.04"), ["-d", "Ubuntu-24.04", "--", "sleep", "infinity"]);
  assert.deepEqual(buildWslKeepaliveArgs(undefined), ["--", "sleep", "infinity"]);
  assert.equal(
    formatShellCommand("wsl", buildWslServiceStartArgs("Ubuntu-24.04")),
    "wsl -d Ubuntu-24.04 -u root service postgresql start",
  );
  assert.equal(
    formatShellCommand("wsl", buildWslServiceStartArgs(undefined)),
    "wsl -u root service postgresql start",
  );
  assert.equal(
    formatShellCommand("wsl", buildWslKeepaliveArgs("Ubuntu 24.04")),
    'wsl -d "Ubuntu 24.04" -- sleep infinity',
  );
});

test("遮住连接串和密码", () => {
  const detail = `password Sup3rSecret url ${SECRET_URL} encoded p%40ss`;
  const redacted = redactSensitive(detail, "postgres://resume:p%40ss@127.0.0.1:5432/resume");
  assert.equal(redacted.includes("p%40ss"), false);
  assert.equal(redacted.includes("p@ss"), false);
  const hidden = redactSensitive(`see ${SECRET_URL} and Sup3rSecret`, SECRET_URL);
  assert.equal(hidden.includes("Sup3rSecret"), false);
  assert.equal(hidden.includes(SECRET_URL), false);
});

test(".env 解析不覆盖已有环境变量", () => {
  const file = parseEnvFile(
    '# comment\n\nDATABASE_URL="postgres://resume:Sup3rSecret@10.0.0.8:5432/resume"\nSKIP_DB_START=1\nWSL_DISTRO=\'Ubuntu-24.04\'\nbroken\n=no\n',
  );
  assert.equal(file.DATABASE_URL, "postgres://resume:Sup3rSecret@10.0.0.8:5432/resume");
  assert.equal(file.WSL_DISTRO, "Ubuntu-24.04");
  assert.equal(readConfigValue("DATABASE_URL", file, { DATABASE_URL: SECRET_URL }), SECRET_URL);
  assert.equal(readConfigValue("DATABASE_URL", file, {}), file.DATABASE_URL);
  assert.equal(readConfigValue("DATABASE_URL", file, { DATABASE_URL: "" }), "");
  assert.equal(isSkipDbStart("1"), true);
  assert.equal(isSkipDbStart(" 1 "), true);
  assert.equal(isSkipDbStart("true"), false);
  assert.equal(isSkipDbStart(undefined), false);
});

test("TCP 探测能区分开着和关着的端口", async () => {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  const port = address && typeof address === "object" ? address.port : 0;
  try {
    assert.equal(await probeTcp("127.0.0.1", port, 500), true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  const closed = await probeTcp("127.0.0.1", 1, 500);
  assert.equal(closed, false);
});

function capture(overrides = {}) {
  const lines = [];
  const calls = { spawn: [], keepalive: [] };
  let probes = 0;
  const log = (line) => lines.push(line);
  const options = {
    platform: "linux",
    env: {},
    fileValues: {},
    log,
    warn: log,
    probe: async () => {
      probes += 1;
      return false;
    },
    spawnService: async (args) => {
      calls.spawn.push(args);
      return { missing: false, code: 0, detail: "" };
    },
    openKeepalive: async (args) => {
      calls.keepalive.push(args);
      return { ok: true };
    },
    waitTimeoutMs: 40,
    waitIntervalMs: 10,
    ...overrides,
  };
  return { lines, calls, options, probeCount: () => probes };
}

test("数据库可达时只提示就绪，Linux 不启动 WSL", async () => {
  const captured = capture({
    env: { DATABASE_URL: SECRET_URL },
    probe: async () => true,
  });
  await ensureDatabase(captured.options);
  const text = captured.lines.join("\n");
  assert.match(text, /\[db\] 数据库已就绪（127\.0\.0\.1:5432）。/);
  assert.equal(captured.calls.spawn.length, 0);
  assert.equal(captured.calls.keepalive.length, 0);
  assert.equal(text.includes("Sup3rSecret"), false);
});

test("Linux 上数据库不可达时只提示，不尝试启动", async () => {
  const captured = capture({ env: { DATABASE_URL: SECRET_URL } });
  await ensureDatabase(captured.options);
  const text = captured.lines.join("\n");
  assert.match(text, /当前系统不会自动启动数据库/);
  assert.match(text, /仍会继续启动前后端/);
  assert.equal(captured.calls.spawn.length, 0);
  assert.equal(captured.calls.keepalive.length, 0);
  assert.equal(text.includes("Sup3rSecret"), false);
});

test("SKIP_DB_START=1 跳过整个数据库步骤", async () => {
  let probed = false;
  const captured = capture({
    env: { SKIP_DB_START: "1", DATABASE_URL: SECRET_URL },
    probe: async () => {
      probed = true;
      return true;
    },
  });
  await ensureDatabase(captured.options);
  assert.match(captured.lines.join("\n"), /已跳过数据库检查（SKIP_DB_START=1）/);
  assert.equal(probed, false);
  assert.equal(captured.calls.spawn.length, 0);
});

test("未配置 DATABASE_URL 时跳过", async () => {
  let probed = false;
  const captured = capture({
    probe: async () => {
      probed = true;
      return false;
    },
  });
  await ensureDatabase(captured.options);
  assert.match(captured.lines.join("\n"), /未配置 DATABASE_URL，跳过数据库检查/);
  assert.equal(probed, false);
});

test("Windows 本机连不上时执行 wsl 启动并保活，超时后给出手动命令", async () => {
  const captured = capture({
    platform: "win32",
    env: { DATABASE_URL: SECRET_URL, WSL_DISTRO: "Ubuntu-24.04" },
    spawnService: async (args) => {
      captured.calls.spawn.push(args);
      return { missing: false, code: 1, detail: `boom ${SECRET_URL} Sup3rSecret` };
    },
  });
  await ensureDatabase(captured.options);
  const text = captured.lines.join("\n");
  assert.deepEqual(captured.calls.spawn, [
    ["-d", "Ubuntu-24.04", "-u", "root", "service", "postgresql", "start"],
  ]);
  assert.deepEqual(captured.calls.keepalive, [["-d", "Ubuntu-24.04", "--", "sleep", "infinity"]]);
  assert.match(text, /正在通过 WSL 启动 PostgreSQL/);
  assert.match(text, /执行：wsl -d Ubuntu-24.04 -u root service postgresql start/);
  assert.match(text, /启动命令退出码为 1/);
  assert.match(text, /等待 .*后仍然连不上 127\.0\.0\.1:5432/);
  assert.match(text, /可手动执行：wsl -d Ubuntu-24.04 -u root service postgresql start/);
  assert.match(text, /仍会继续启动前后端/);
  assert.match(text, /已启动 WSL 保活（发行版 Ubuntu-24.04）/);
  assert.match(text, /不会停止 PostgreSQL/);
  assert.equal(text.includes("Sup3rSecret"), false);
  assert.equal(text.includes(SECRET_URL), false);
  assert.match(text, /wsl 输出：boom \*\*\* \*\*\*/);
});

test("找不到 wsl 时打印手动命令，不保活，也不退出", async () => {
  const captured = capture({
    platform: "win32",
    env: { DATABASE_URL: "postgres://resume:Sup3rSecret@localhost:5432/resume" },
    spawnService: async (args) => {
      captured.calls.spawn.push(args);
      return { missing: true, code: 1, detail: "ENOENT" };
    },
  });
  await ensureDatabase(captured.options);
  const text = captured.lines.join("\n");
  assert.deepEqual(captured.calls.spawn, [["-u", "root", "service", "postgresql", "start"]]);
  assert.equal(captured.calls.keepalive.length, 0);
  assert.match(text, /没有找到 wsl 命令/);
  assert.match(text, /可手动执行：wsl -u root service postgresql start/);
  assert.match(text, /仍会继续启动前后端/);
  assert.equal(text.includes("仍然连不上"), false);
  assert.equal(text.includes("Sup3rSecret"), false);
});

test("Windows 上数据库已经可达时只保活，不重复启动", async () => {
  const captured = capture({
    platform: "win32",
    env: { DATABASE_URL: SECRET_URL },
    probe: async () => true,
  });
  await ensureDatabase(captured.options);
  assert.equal(captured.calls.spawn.length, 0);
  assert.deepEqual(captured.calls.keepalive, [["--", "sleep", "infinity"]]);
  assert.match(captured.lines.join("\n"), /数据库已就绪/);
});

test("Windows 上远程主机不可达时不调用 wsl", async () => {
  const captured = capture({
    platform: "win32",
    env: { DATABASE_URL: "postgres://resume:Sup3rSecret@db.example.com:5432/resume" },
  });
  await ensureDatabase(captured.options);
  const text = captured.lines.join("\n");
  assert.match(text, /不会通过 WSL 启动/);
  assert.equal(captured.calls.spawn.length, 0);
  assert.equal(captured.calls.keepalive.length, 0);
  assert.equal(text.includes("Sup3rSecret"), false);
});

test("端口稍后打开时不再报超时", async () => {
  let probes = 0;
  const captured = capture({
    platform: "win32",
    env: { DATABASE_URL: SECRET_URL, WSL_DISTRO: "Ubuntu-24.04" },
    probe: async () => {
      probes += 1;
      return probes > 1;
    },
  });
  await ensureDatabase(captured.options);
  const text = captured.lines.join("\n");
  assert.match(text, /数据库已就绪（127\.0\.0\.1:5432）。/);
  assert.equal(text.includes("仍然连不上"), false);
  assert.ok(probes >= 2);
});

test("环境变量优先于 .env 文件", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "resume-dev-env-"));
  const file = path.join(dir, ".env");
  try {
    writeFileSync(
      file,
      [
        "DATABASE_URL=postgres://resume:FromFileSecret@10.9.8.7:5432/resume",
        "WSL_DISTRO=Ubuntu-24.04",
        "SKIP_DB_START=0",
        "",
      ].join("\n"),
    );
    const captured = capture({
      envFile: file,
      fileValues: undefined,
      env: { DATABASE_URL: "postgres://resume:Sup3rSecret@127.0.0.1:1/resume" },
      platform: "linux",
    });
    delete captured.options.fileValues;
    await ensureDatabase(captured.options);
    const text = captured.lines.join("\n");
    assert.match(text, /127\.0\.0\.1:1/);
    assert.equal(text.includes("10.9.8.7"), false);
    assert.equal(text.includes("FromFileSecret"), false);
    assert.equal(text.includes("Sup3rSecret"), false);

    const fromFile = capture({
      envFile: file,
      env: {},
      platform: "linux",
    });
    delete fromFile.options.fileValues;
    await ensureDatabase(fromFile.options);
    const fileText = fromFile.lines.join("\n");
    assert.match(fileText, /10\.9\.8\.7:5432/);
    assert.equal(fileText.includes("FromFileSecret"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

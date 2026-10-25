import assert from "node:assert/strict";
import test from "node:test";
import { testDatabaseUrl } from "./test-database.mjs";

test("默认连接独立测试库，不读取业务 DATABASE_URL", () => {
  const value = testDatabaseUrl({ DATABASE_URL: "postgres://example/production" });
  assert.equal(new URL(value).pathname, "/resume_test");
});

test("允许自定义测试库，拒绝业务库和不合法的库名", () => {
  assert.equal(new URL(testDatabaseUrl({ TEST_DATABASE_URL: "postgresql://example/ci_test" })).pathname, "/ci_test");
  for (const name of ["resume", "postgres", "resume_test%22", "resume_test/production"]) {
    assert.throws(() => testDatabaseUrl({ TEST_DATABASE_URL: `postgres://example/${name}` }), /独立测试库/);
  }
});

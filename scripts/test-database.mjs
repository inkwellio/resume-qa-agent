/** 所有会清空表的集成测试共用此校验，禁止误连业务库。 */
export function testDatabaseUrl(env = process.env) {
  const value = env.TEST_DATABASE_URL || "postgres://resume:resume@127.0.0.1:5432/resume_test";
  const url = new URL(value);
  const name = decodeURIComponent(url.pathname.slice(1));
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !/^[a-z][a-z0-9_]*_test$/.test(name)) {
    throw new Error("TEST_DATABASE_URL 必须指向名称以 _test 结尾的独立测试库。");
  }
  return url.href;
}

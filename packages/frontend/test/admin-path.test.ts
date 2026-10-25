import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isAdminPath, parseAdminRoute } from "../src/admin-path.ts";

const USER = "11111111-1111-4111-8111-111111111111";

describe("站长路径", () => {
  it("只把 /admin 当成后台，避免误伤访客页", () => {
    assert.equal(isAdminPath("/admin"), true);
    assert.equal(isAdminPath("/admin/"), true);
    assert.equal(isAdminPath("/admin/login"), true);
    assert.equal(isAdminPath("/admin/sessions"), true);
    assert.equal(isAdminPath("/"), false);
    assert.equal(isAdminPath("/administrator"), false);
    assert.equal(isAdminPath("/sessions"), false);
  });

  it("解析后台路由，并拒绝不合法的用户编号", () => {
    assert.deepEqual(parseAdminRoute("/admin"), { page: "users" });
    assert.deepEqual(parseAdminRoute("/admin/"), { page: "users" });
    assert.deepEqual(parseAdminRoute("/admin/login"), { page: "login" });
    assert.deepEqual(parseAdminRoute("/admin/setup"), { page: "setup" });
    assert.deepEqual(parseAdminRoute("/admin/ips"), { page: "ips" });
    assert.deepEqual(parseAdminRoute("/admin/feedback"), { page: "feedback" });
    assert.deepEqual(parseAdminRoute("/admin/usage"), { page: "usage" });
    assert.deepEqual(parseAdminRoute("/admin/sessions", `?userId=${USER}&email=a%40b.test`), {
      page: "sessions",
      userId: USER,
      email: "a@b.test",
      userIdInvalid: false,
    });
    assert.deepEqual(parseAdminRoute("/admin/sessions", "?userId=not-a-uuid"), {
      page: "sessions",
      userId: null,
      email: null,
      userIdInvalid: true,
    });
    assert.deepEqual(parseAdminRoute(`/admin/sessions/${USER}`), { page: "session", id: USER });
    assert.deepEqual(parseAdminRoute("/admin/sessions/nope"), { page: "missing" });
    assert.deepEqual(parseAdminRoute("/admin/unknown"), { page: "missing" });
  });
});

import express from "express";
import { createApp as realCreateApp, type AppDeps } from "../src/app.js";
import type { AppConfig } from "../src/config.js";

export type { AppDeps };
/** 旧聊天/防刷用例的已验证身份夹具；真实邮箱登录和拒绝未登录请求在 email-auth.test 中覆盖。 */
export function createApp(config: AppConfig, deps: AppDeps) {
  const app = express();
  if (!deps.auth) app.use((req, _res, next) => {
    const visitor = req.headers.cookie?.split(";").find((part) => part.trim().startsWith("resume_visitor="))?.trim().slice("resume_visitor=".length);
    if (visitor) req.headers.cookie = `${req.headers.cookie}; resume_auth=${visitor}`;
    next();
  });
  app.use(realCreateApp(config, {
    ...deps,
    auth: deps.auth ?? {
      configured: true,
      authenticate: async (token) => ({ email: "verified@example.com", visitorId: await deps.business.ensureVisitor(token) }),
      sendCode: async () => { throw new Error("夹具不发送邮件"); },
      verify: async () => { throw new Error("夹具不校验验证码"); },
      logout: async () => {},
    },
  }));
  return app;
}

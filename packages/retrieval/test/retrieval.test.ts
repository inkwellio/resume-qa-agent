import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { createEmbeddingClient } from "../src/embeddings.js";
import { searchResume } from "../src/store.js";
import type { VectorStore } from "../src/vector-store.js";
import { VECTOR_DIMENSION } from "../src/vector-store.js";

describe("检索", () => {
  it("调用 OpenAI 兼容的 embeddings 接口", async () => {
    const seen: { url?: string; authorization?: string; model?: string; input?: string[] } = {};
    const client = createEmbeddingClient({
      baseUrl: "https://api.siliconflow.cn/v1/",
      model: "BAAI/bge-m3",
      apiKey: "test-key",
      fetchImpl: async (url, init) => {
        seen.url = String(url);
        seen.authorization = new Headers(init?.headers).get("authorization") ?? "";
        const body = JSON.parse(String(init?.body)) as { model: string; input: string[] };
        seen.model = body.model;
        seen.input = body.input;
        return new Response(
          JSON.stringify({
            data: body.input.map((_item, index) => ({ index: body.input.length - 1 - index, embedding: [index, 1, 2] })),
          }),
          { status: 200 },
        );
      },
    });
    await expect(client.embed([])).resolves.toEqual([]);
    const vectors = await client.embed(["甲", "乙"]);
    expect(seen.url).toBe("https://api.siliconflow.cn/v1/embeddings");
    expect(seen.authorization).toBe("Bearer test-key");
    expect(seen.model).toBe("BAAI/bge-m3");
    expect(vectors).toEqual([
      [1, 1, 2],
      [0, 1, 2],
    ]);
  });

  it("超时覆盖连接成功后卡住的响应体，用户停止也会结束请求", async () => {
    let headersSent: (() => void) | undefined;
    const server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write('{"data":');
      headersSent?.();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("没有监听端口");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    try {
      const client = createEmbeddingClient({ baseUrl, model: "test", apiKey: "test", timeoutMs: 100 });
      await expect(client.embed(["超时"])).rejects.toThrow();
      const controller = new AbortController();
      const received = new Promise<void>((resolve) => { headersSent = resolve; });
      const request = createEmbeddingClient({ baseUrl, model: "test", apiKey: "test", timeoutMs: 5000 }).embed(["停止"], controller.signal);
      const rejected = expect(request).rejects.toThrow();
      await received;
      controller.abort();
      await rejected;
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("上游失败不会把响应体里的凭据带进工具错误", async () => {
    const client = createEmbeddingClient({
      baseUrl: "https://example.invalid/v1", model: "test", apiKey: "test",
      fetchImpl: async () => new Response("Bearer sk-SECRET", { status: 401 }),
    });
    await expect(client.embed(["测试"])).rejects.toThrow(/^向量接口返回 401$/);
  });
});

describe("检索降级与停止", () => {
  function store(): VectorStore {
    return { upsert: vi.fn(), rebuild: vi.fn(), delete: vi.fn(), search: vi.fn(async () => []) };
  }

  it("向量失败或返回错误维度时降级到关键词，空查询不调用向量", async () => {
    const vector = store();
    const embed = vi.fn(async () => { throw new Error("服务不可用"); });
    const query = { query: "React", type: "project" as const, limit: 4 };
    await searchResume(vector, { model: "test", embed }, query);
    expect(vector.search).toHaveBeenLastCalledWith(query, null);
    await searchResume(vector, { model: "test", embed: async () => [[1, 2]] }, query);
    expect(vector.search).toHaveBeenLastCalledWith(query, null);
    await searchResume(vector, { model: "test", embed }, { query: "" });
    expect(embed).toHaveBeenCalledTimes(1);
  });

  it("用户停止不降级，也不继续访问数据库", async () => {
    const vector = store();
    const controller = new AbortController();
    const embed = vi.fn(async (_texts, signal?: AbortSignal) => {
      expect(signal).toBe(controller.signal);
      controller.abort();
      throw controller.signal.reason;
    });
    await expect(searchResume(vector, { model: "test", embed }, { query: "React" }, controller.signal)).rejects.toThrow();
    await expect(searchResume(vector, { model: "test", embed }, { query: "React" }, controller.signal)).rejects.toThrow();
    expect(embed).toHaveBeenCalledTimes(1);
    expect(vector.search).not.toHaveBeenCalled();
  });

  it("数据库查询失败不会被当作向量失败再次查询", async () => {
    const vector = store();
    vi.mocked(vector.search).mockRejectedValue(new Error("数据库不可用"));
    await expect(searchResume(vector, { model: "test", embed: async () => [Array(VECTOR_DIMENSION).fill(1)] }, { query: "React" })).rejects.toThrow("数据库不可用");
    expect(vector.search).toHaveBeenCalledTimes(1);
  });
});

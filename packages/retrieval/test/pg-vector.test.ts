import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../../backend/src/migrate.js";
import { createPgVectorStore } from "../src/pg-vector-store.js";
import { segmentText } from "../src/segment.js";
import { rebuildResumeIndex } from "../src/store.js";
import type { EmbeddingClient, ResumeChunk } from "../src/types.js";
import { VECTOR_DIMENSION, type VectorRecord } from "../src/vector-store.js";
import { testDatabaseUrl } from "../../../scripts/test-database.mjs";

const DATABASE_URL = testDatabaseUrl();

const chunks: ResumeChunk[] = [
  {
    id: "proj-starmap",
    type: "project",
    title: "星图检索台",
    period: "2024.06 - 2025.02",
    tech_stack: ["React", "Node.js"],
    text: "示例项目。云栖实验室的 React 检索台，名叫星图。",
  },
  {
    id: "proj-harbor",
    type: "project",
    title: "港湾协作平台",
    period: "2023.03 - 2024.01",
    tech_stack: ["React", "TypeScript", "Node.js"],
    text: "示例项目。2023 年的 React 看板。",
  },
  {
    id: "proj-orders",
    type: "project",
    title: "订单同步服务",
    period: "2023.08 - 2024.06",
    tech_stack: ["Node.js", "TypeScript"],
    text: "示例项目。纯 Node.js 服务，没有 React。",
  },
  {
    id: "proj-ledger",
    type: "project",
    title: "票据归档小工具",
    period: "2021.04 - 2022.11",
    tech_stack: ["Vue", "Java"],
    text: "示例项目。2023 年之前的 Vue 工具。",
  },
  {
    id: "edu-example",
    type: "education",
    title: "示例理工大学",
    period: "2018.09 - 2022.06",
    tech_stack: [],
    text: "计算机科学与技术。",
  },
];

function hashEmbedding(text: string): number[] {
  const vector = Array.from({ length: VECTOR_DIMENSION }, () => 0);
  for (let index = 0; index < text.length; index += 1) {
    const current = vector[index % VECTOR_DIMENSION] ?? 0;
    vector[index % VECTOR_DIMENSION] = current + ((text.charCodeAt(index) % 97) - 48) / 48;
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / norm);
}

function records(): VectorRecord[] {
  return chunks.map((chunk) => ({ ...chunk, embedding: hashEmbedding(chunk.id + chunk.text) }));
}

function fakeClient(dimension: number): EmbeddingClient {
  return {
    model: "fake",
    async embed(texts: string[]) {
      return texts.map((text) => {
        const vector = hashEmbedding(text);
        return dimension === VECTOR_DIMENSION ? vector : vector.slice(0, dimension);
      });
    },
  };
}

describe("pgvector 检索", () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const store = createPgVectorStore(pool);

  beforeAll(async () => {
    await runMigrations(DATABASE_URL);
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE resume_chunks");
  });

  afterAll(async () => {
    await pool.end();
  });

  it("结巴把星图切成一个词", () => {
    expect(segmentText("星图检索台")).toContain("星图");
  });

  it("混合检索、过滤，并且重建失败时旧数据还在", async () => {
    await store.rebuild(records());
    const byName = await store.search({ query: "星图" }, hashEmbedding("星图"));
    expect(byName[0]?.id).toBe("proj-starmap");

    const reactAfter2023 = await store.search(
      { query: "React", type: "project", techStack: "React", periodFrom: 2023, limit: 10 },
      hashEmbedding("React"),
    );
    expect(reactAfter2023.map((chunk) => chunk.id).sort()).toEqual(["proj-harbor", "proj-starmap"]);

    const education = await store.search({ query: "计算机", type: "education" }, hashEmbedding("计算机"));
    expect(education.map((chunk) => chunk.id)).toEqual(["edu-example"]);

    await expect(store.rebuild([{ ...records()[0]!, embedding: [1, 2, 3] }])).rejects.toThrow(/维度/);
    const kept = await store.search({ query: "", limit: 20 }, null);
    expect(kept.map((chunk) => chunk.id).sort()).toEqual(chunks.map((chunk) => chunk.id).sort());
  });

  it("重新入库沿用原文 id，不另起一套", async () => {
    await store.rebuild(records());
    await store.rebuild(records().map((record) => ({ ...record, text: `${record.text}（更新）` })));
    const hits = await store.search({ query: "", limit: 20 }, null);
    expect(hits.map((chunk) => chunk.id).sort()).toEqual(chunks.map((chunk) => chunk.id).sort());
    expect(hits.find((chunk) => chunk.id === "proj-harbor")?.text).toContain("更新");

    await store.upsert([{ ...records()[0]!, text: "只更新星图" }]);
    await store.delete(["proj-ledger"]);
    const after = await store.search({ query: "", limit: 20 }, null);
    expect(after.map((chunk) => chunk.id).sort()).toEqual(["edu-example", "proj-harbor", "proj-orders", "proj-starmap"]);
    expect(after.find((chunk) => chunk.id === "proj-starmap")?.text).toBe("只更新星图");
  });

  it("维度和表结构不一致时，入库函数不会动已有数据", async () => {
    await store.rebuild(records());
    await expect(rebuildResumeIndex({ store, chunks, client: fakeClient(8) })).rejects.toThrow(/1024/);
    const kept = await store.search({ query: "", limit: 20 }, null);
    expect(kept).toHaveLength(chunks.length);
  });
});

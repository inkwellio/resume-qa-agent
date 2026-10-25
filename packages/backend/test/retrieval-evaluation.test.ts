import { describe, expect, it } from "vitest";
import { summarizeRetrieval } from "../src/retrieval-evaluation.js";

describe("检索评测统计", () => {
  it("按应召回条目统计 Recall，按第一个正确结果统计 MRR，无证据题不计入分母", () => {
    const report = summarizeRetrieval([
      { id: "a", query: "a", expectedIds: ["a", "b"], actualIds: ["x", "b", "b"], durationMs: 10 },
      { id: "b", query: "b", expectedIds: ["z"], actualIds: ["x", "y"], durationMs: 20 },
      { id: "c", query: "c", expectedIds: [], actualIds: ["x"], durationMs: 30 },
      { id: "d", query: "d", expectedIds: [], actualIds: [], durationMs: 40 },
    ]);
    expect(report).toMatchObject({ total: 4, positiveCases: 2, noEvidenceCases: 2, recallAtK: 0.25, hitRateAtK: 0.5, mrrAtK: 0.25, noEvidenceWithCandidates: 1, latencyP50Ms: 20, latencyP95Ms: 40 });
  });

  it("前 k 名之外的命中不计分，空样本的指标留空", () => {
    expect(summarizeRetrieval([{ id: "a", query: "a", expectedIds: ["a"], actualIds: ["x", "a"], durationMs: 10 }], 1).recallAtK).toBe(0);
    expect(summarizeRetrieval([])).toMatchObject({ total: 0, recallAtK: null, mrrAtK: null, latencyP95Ms: null });
    expect(() => summarizeRetrieval([], 0)).toThrow();
  });
});

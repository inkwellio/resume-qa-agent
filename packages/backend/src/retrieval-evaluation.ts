export interface RetrievalEvaluationRow {
  id: string;
  query: string;
  expectedIds: string[];
  actualIds: string[];
  durationMs: number;
}

/** 无证据题单独统计候选情况，不能把“返回候选”当成“模型编造答案”。 */
export function summarizeRetrieval(rows: RetrievalEvaluationRow[], k = 4) {
  if (!Number.isInteger(k) || k < 1) throw new Error("k 必须为正整数");
  const positive = rows.filter((row) => row.expectedIds.length > 0);
  const negative = rows.filter((row) => row.expectedIds.length === 0);
  const average = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  const recalls = positive.map((row) => {
    const expected = new Set(row.expectedIds);
    const actual = new Set(row.actualIds.slice(0, k));
    return [...expected].filter((id) => actual.has(id)).length / expected.size;
  });
  const ranks = positive.map((row) => {
    const rank = row.actualIds.slice(0, k).findIndex((id) => row.expectedIds.includes(id));
    return rank < 0 ? 0 : 1 / (rank + 1);
  });
  const times = rows.map((row) => row.durationMs).sort((a, b) => a - b);
  const percentile = (fraction: number) => times.length ? times[Math.ceil(times.length * fraction) - 1] : null;
  return {
    k, total: rows.length, positiveCases: positive.length, noEvidenceCases: negative.length,
    recallAtK: average(recalls), hitRateAtK: average(ranks.map((rank) => Number(rank > 0))), mrrAtK: average(ranks),
    noEvidenceWithCandidates: negative.filter((row) => row.actualIds.length > 0).length,
    latencyP50Ms: percentile(0.5), latencyP95Ms: percentile(0.95),
  };
}

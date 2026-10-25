export interface PeriodYears {
  startYear: number;
  endYear: number;
}

/**
 * 从「2023.03 - 2024.01」「2024.06 - 至今」这类展示用时间里抽出年份。
 * 抽不出来时不过滤（0 到 9999）。
 */
export function parsePeriod(period: string | undefined): PeriodYears {
  if (!period?.trim()) return { startYear: 0, endYear: 9999 };
  const years = [...period.matchAll(/(?:19|20)\d{2}/g)].map((match) => Number(match[0]));
  if (years.length === 0 || years[0] === undefined) return { startYear: 0, endYear: 9999 };
  const startYear = years[0];
  const ongoing = /至今|现在|present/i.test(period);
  const endYear = ongoing ? 9999 : (years[1] ?? startYear);
  return { startYear, endYear };
}

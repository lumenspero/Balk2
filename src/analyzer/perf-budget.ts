import * as fs from 'fs';
import * as path from 'path';
import { expect } from 'vitest';

/**
 * Phase 0.7 performance budgets for the perf tests. Budgets live in test/perf-budgets.json, keyed
 * first by process.platform ('linux', 'win32') and then by test name. A missing or null entry means
 * there is no baseline yet: the test logs its time and asserts nothing. Set each budget to 1.5x the
 * first measured time on that platform.
 *
 * Imported only by the perf tests, which run in CI under BALK2_PERF=1 (see .github/workflows/perf.yml).
 */
const BUDGET_FILE = path.resolve(process.cwd(), 'test/perf-budgets.json');

type Budgets = Record<string, Record<string, number | null | undefined>>;

function readBudgets(): Budgets {
  if (!fs.existsSync(BUDGET_FILE)) return {};
  return JSON.parse(fs.readFileSync(BUDGET_FILE, 'utf8')) as Budgets;
}

/** Fails when the measured time exceeds the stored budget for this platform. No-op without a budget. */
export function assertWithinBudget(name: string, elapsedMs: number): void {
  const budget = readBudgets()[process.platform]?.[name];
  if (typeof budget !== 'number') return;
  expect(
    elapsedMs,
    `${name} on ${process.platform}: ${Math.round(elapsedMs)} ms exceeds budget ${budget} ms`,
  ).toBeLessThanOrEqual(budget);
}

/**
 * Immune System — involuntary antibody scanning.
 *
 * Like the inference loop, this runs silently. Tools import scanAntibodies()
 * to check content against threat patterns before storage. The immune system
 * advises — it doesn't block. Warnings are appended to tool responses.
 *
 * Antibody trigger counts are incremented on match, giving the introspect
 * dashboard real data on which patterns are actually firing.
 */
import type { PoolClient } from 'pg';
import { pool } from '../db/pool.js';

export interface ImmuneWarning {
  pattern: string;
  threat_type: string;
  response: string;
  severity: number;
}

export interface ImmuneScanResult {
  triggered: number;
  warnings: ImmuneWarning[];
}

/**
 * Scan text against all antibody patterns. Returns warnings for any matches.
 * Increments times_blocked counter for matched antibodies.
 * Never throws — immune scan failure is non-fatal.
 */
export async function scanAntibodies(
  text: string,
  client?: PoolClient,
): Promise<ImmuneScanResult> {
  const warnings: ImmuneWarning[] = [];
  const shouldRelease = !client;
  const conn = client || await pool.connect();

  try {
    const antibodies = await conn.query<{
      id: number; pattern: string; threat_type: string; response: string; severity: number;
    }>('SELECT id, pattern, threat_type, response, severity FROM antibodies');

    for (const ab of antibodies.rows) {
      try {
        const regex = new RegExp(ab.pattern, 'i');
        if (regex.test(text)) {
          warnings.push({
            pattern: ab.pattern,
            threat_type: ab.threat_type,
            response: ab.response,
            severity: ab.severity,
          });
          // 2026-05-17 fix: also increment times_triggered + last_triggered.
          // 2026-06-01 (immunology dive): SEPARATE matched from blocked. scanAntibodies
          // is mostly advisory (it returns warnings; it doesn't halt). Counting every
          // match as a "block" conflated pattern-match with real blocking and hid the
          // autoimmune signature (high-match / low-true-block = firing on self). Now:
          //   times_matched++ on every match (the firing signal)
          //   times_blocked++ ONLY for severity>=8 (the antibodies that actually halt)
          // This gives self/non-self discrimination the schema-level signal it lacked —
          // a high times_matched with low times_blocked is the measurable autoimmune clone.
          const actuallyBlocks = ab.severity >= 8;
          await conn.query(
            'UPDATE antibodies SET times_matched = COALESCE(times_matched, 0) + 1, ' +
            'times_triggered = COALESCE(times_triggered, 0) + 1, ' +
            (actuallyBlocks ? 'times_blocked = times_blocked + 1, ' : '') +
            'last_triggered = NOW() WHERE id = $1',
            [ab.id]
          );
        }
      } catch { /* skip invalid regex */ }
    }
  } catch { /* non-fatal */ }
  finally {
    if (shouldRelease) conn.release();
  }

  return { triggered: warnings.length, warnings };
}

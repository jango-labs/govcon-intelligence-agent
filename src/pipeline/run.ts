// The daily run: discover → scope + relevance → reconcile → compare with baseline → enrich → score → lifecycle → report → notify.
// A source outage yields a clearly labelled PARTIAL run; absence caused by an outage is never read as disappearance.
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { Db, J, openDb } from '../db.ts';
import { loadProfile, paths, type Profile } from '../config.ts';
import { logger, redactText } from '../util/log.ts';
import { getSecret } from '../secrets.ts';
import { toKeywords, compile, matchKeywords, isStrong, type MatchResult } from '../keywords.ts';
import { normalizeOrg, inScope } from '../scope.ts';
import { upsert } from './store.ts';
import { rescoreAll } from './rescore.ts';
import { updateLifecycle, snapshots } from './lifecycle.ts';
import { linkPredecessors } from './predecessor.ts';
import { buildWorkbook, type ReportMeta } from './report.ts';
import { builtinConnectors, loadPlugins } from '../connectors/registry.ts';
import { sampleConnector } from '../connectors/sample.ts';
import { pullGao } from '../connectors/gao.ts';
import { getAward, toIncumbent } from '../connectors/usaspending.ts';
import { parseJ } from '../db.ts';
import type { Candidate, Connector, SourceCoverage, DiscoverContext } from '../types.ts';

export interface RunOpts { trigger?: string; dryRun?: boolean; now?: Date; demo?: boolean; db?: Db; profile?: Profile; connectors?: Connector[]; reportDir?: string; sampleStep?: number; sampleAnchor?: string; skipGao?: boolean }
export interface RunSummary { runId: number; status: 'complete' | 'partial' | 'failed'; dryRun: boolean; file: string | null; counts: Record<string, number>; coverage: SourceCoverage[]; log: string[]; validation?: unknown; }
export const iso = (d: Date) => d.toISOString().slice(0, 10);
export function windowFor(now: Date, months: number) { const to = new Date(now); to.setUTCMonth(to.getUTCMonth() + months); return { from: iso(now), to: iso(to) }; }

/** Single-run lock: a lock file holding the PID; a lock whose process is gone is treated as stale. */
function acquireLock(file: string): () => void {
  if (existsSync(file)) {
    const pid = Number(readFileSync(file, 'utf8').split(/\s+/)[0]);
    let alive = false; if (pid) { try { process.kill(pid, 0); alive = true; } catch { alive = false; } }
    if (alive && pid !== process.pid) throw new Error(`another run is already in progress (pid ${pid}). If that is wrong, delete ${file}.`);
  }
  writeFileSync(file, `${process.pid} ${new Date().toISOString()}\n`);
  return () => { try { unlinkSync(file); } catch { /* gone */ } };
}

interface Funnel { [k: string]: number }
class Audit {
  funnel: Record<string, Funnel> = {}; byKeyword: Record<string, number> = {}; byAgency: Record<string, { discovered: number; qualifying: number; review: number }> = {};
  f(src: string) { return (this.funnel[src] ??= { discovered: 0, out_of_scope: 0, no_keyword_match: 0, qualifying: 0, review: 0, below_min_value: 0, duplicate_in_run: 0, new_opportunities: 0, merged_into_existing: 0 }); }
  a(key: string) { return (this.byAgency[key] ??= { discovered: 0, qualifying: 0, review: 0 }); }
}

export async function runPipeline(o: RunOpts = {}): Promise<RunSummary> {
  const now = o.now ?? new Date(); const today = iso(now); const dry = !!o.dryRun; const demo = !!o.demo;
  const profile = o.profile ?? loadProfile(); const db = o.db ?? openDb();
  const log: string[] = []; const L = (m: string) => { log.push(`${new Date().toISOString().slice(11, 19)} ${redactText(m)}`); logger.info('run: ' + m); };
  const release = acquireLock(join(paths.dataDir, demo ? 'run.demo.lock' : 'run.lock'));
  let runId = 0; const coverage: SourceCoverage[] = []; const counts: Record<string, number> = {}; let began = false;
  try {
    db.run(`update run set status='failed', finished_at=?, error='abandoned: the process stopped before this run finished' where status='running'`, [new Date().toISOString()]);   // holding the lock proves no other run is alive
    if (dry) { db.raw.exec('begin'); began = true; }
    const win = windowFor(now, profile.windowMonths);
    const prior = db.get(`select count(*) n from run where dry_run=0 and status in ('complete','partial')`)!.n as number; const mode = prior ? 'incremental' : 'backfill';
    const baseline = db.get(`select id, status from run where dry_run=0 and status in ('complete','partial') order by (status='complete') desc, id desc limit 1`);
    runId = Number(db.run(`insert into run(trigger, dry_run, window_from, window_to, mode, baseline_run_id, demo) values (?,?,?,?,?,?,?)`, [o.trigger ?? 'manual', dry ? 1 : 0, win.from, win.to, mode, baseline?.id ?? null, demo ? 1 : 0]).lastInsertRowid);
    L(`Run ${runId} (${dry ? 'DRY RUN' : demo ? 'DEMO' : o.trigger ?? 'manual'}) window ${win.from} → ${win.to}; ${baseline ? `baseline run ${baseline.id} (${baseline.status})` : 'no baseline yet (everything is new)'}`);

    const kws = toKeywords(profile.keywords); const compiled = compile(kws); const threshold = profile.relevance.threshold;
    const ctx: DiscoverContext = { profile, keywords: kws.map((k) => k.term), window: win, today, db, getSecret, log: L };
    const connectors = o.connectors ?? (demo ? [sampleConnector(o.sampleStep ?? 1, o.sampleAnchor)] : [...builtinConnectors(), ...(await loadPlugins(profile, L))]);
    const results = await Promise.allSettled(connectors.map((c) => c.discover(ctx)));
    const all: Candidate[] = [];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') { all.push(...r.value.candidates); coverage.push(r.value.coverage); }
      else coverage.push({ source: connectors[i].name, status: 'failed', detail: `connector error: ${redactText((r.reason as Error)?.message ?? String(r.reason))}` });
    });
    if (!demo && !o.skipGao && profile.sources.gao.enabled) {
      try { const g = await pullGao(db); coverage.push({ source: 'GAO reports (market signals)', status: 'ok', detail: `${g.fetched} items in feed, ${g.created} new relevant report(s) stored`, fetched: g.fetched }); }
      catch (e) { coverage.push({ source: 'GAO reports (market signals)', status: 'failed', detail: `GAO RSS feed unavailable: ${redactText((e as Error).message)}` }); }
    }
    counts.discovered = all.length;
    for (const c of coverage) L(`${c.source}: ${c.status} — ${c.detail}`);

    // ── scope + relevance validation ──
    const th = { dateDays: profile.changeThresholds.dateShiftDays, valuePct: profile.changeThresholds.valueChangePct };
    const keep: { c: Candidate; m: MatchResult }[] = []; const audit = new Audit();
    const strongOnly = profile.relevance.evidence === 'strong'; const naicsSet = new Set(profile.filters.naics); const exclude = profile.scope.excludeComponents.map((x) => x.toLowerCase());
    let outOfScope = 0, noMatch = 0, dup = 0; const seenKey = new Set<string>();
    const stored = new Map<string, number>(); for (const r of db.all(`select s.source, s.source_id, o.id from source_record s join opp o on o.id=s.opp_id where o.lifecycle='active'`)) stored.set(`${r.source}:${r.source_id}`, r.id);
    for (const c of all) {
      const f = audit.f(c.source); f.discovered++;
      const org = normalizeOrg(c.department ?? '', c.agency, c.subagency); audit.a(`${org.department ?? c.department ?? 'unclassified'} — ${org.agency || c.agency}`).discovered++;
      const inDept = inScope(org, profile.scope.departments);
      const otherAgency = !inDept && c.source === 'gsa_forecast' && profile.scope.otherAgencyForecasts && (!!org.department || !!c.department);
      if (!inDept && !otherAgency) { outOfScope++; f.out_of_scope++; continue; }
      if (inDept && exclude.includes(org.agency.toLowerCase())) { outOfScope++; f.out_of_scope++; continue; }
      if (org.department) { c.department = org.department; if (!c.agency || /unspecified/i.test(c.agency)) c.agency = org.agency; }
      const k = `${c.source}:${c.sourceId}`; if (seenKey.has(k)) { dup++; f.duplicate_in_run++; continue; } seenKey.add(k);
      let m = matchKeywords({ title: c.title, description: c.description, other: c.other }, compiled, threshold);
      if (m.tier === 'qualifying' && strongOnly && !isStrong(m)) { m = { ...m, tier: 'review', rationale: `${m.rationale}; a single description-only mention is weak evidence — kept for review` }; f.review++; keep.push({ c, m }); continue; }
      if (m.tier === 'none' && profile.relevance.reviewNaicsForecasts && c.stage === 'forecast' && c.naics && naicsSet.has(c.naics) && !otherAgency) { m = { ...m, tier: 'review', score: 0, rationale: `forecast in configured NAICS ${c.naics} but no keyword in its title or description — kept for review, not in the report body` }; f.review++; keep.push({ c, m }); continue; }
      if (m.tier === 'none') {
        noMatch++; f.no_keyword_match++; const exId = stored.get(k);
        if (exId) { db.run(`update opp set lifecycle='no_longer_matched', updated_at=? where id=? and lifecycle='active'`, [new Date().toISOString(), exId]); db.run(`insert into change(run_id, opp_id, kind, evidence) values (?,?,?,?)`, [runId, exId, 'no_longer_matched', 'record is still returned by its source but no longer matches any enabled keyword']); }
        continue;
      }
      if (profile.filters.naicsMode === 'require' && profile.filters.naics.length && c.naics && !profile.filters.naics.some((n) => c.naics!.startsWith(n))) { outOfScope++; f.out_of_scope++; continue; }
      if (/^\d{2,4}$/.test(String(c.psc ?? '')) && m.score < 60) { m.tier = 'review'; f.review++; } else if (m.tier === 'review') f.review++; else f.qualifying++;
      keep.push({ c, m });
    }
    const minV = profile.filters.minValueUsd;
    const filtered = minV ? keep.filter((x) => { const ok = x.c.valueUsd == null || x.c.valueUsd >= minV; if (!ok) audit.f(x.c.source).below_min_value++; return ok; }) : keep;
    for (const { c, m } of filtered) { const a = audit.a(`${c.department ?? 'unclassified'} — ${c.agency}`); if (m.tier === 'qualifying') a.qualifying++; else a.review++; for (const t of m.matched) audit.byKeyword[t] = (audit.byKeyword[t] ?? 0) + 1; }
    counts.out_of_scope = outOfScope; counts.no_keyword_match = noMatch; counts.matched = filtered.length;
    L(`${all.length} discovered → ${outOfScope} out of scope, ${noMatch} without keyword evidence, ${filtered.length} candidates`);

    // ── reconcile + store ──
    let created = 0, changed = 0; const touched = new Set<number>();
    db.tx(() => {
      for (const { c, m } of filtered) {
        const already = !!db.get(`select 1 x from opp where id=(select opp_id from source_record where source=? and source_id=?) and last_seen_run=?`, [c.source, c.sourceId, runId]);
        const r = upsert(db, c, runId, th); const f = audit.f(c.source);
        if (r.created) f.new_opportunities++; else f.merged_into_existing++;
        const mergedInRun = touched.has(r.id); touched.add(r.id); if (r.created) created++;
        for (const ch of mergedInRun || already ? [] : r.changes) {
          if (ch.field !== 'record' && ch.material) changed++;
          db.run(`insert into change(run_id, opp_id, kind, field, old_value, new_value, evidence, material) values (?,?,?,?,?,?,?,?)`, [runId, r.id, ch.field === 'record' ? 'new' : 'changed', ch.field === 'record' ? null : ch.field, ch.old, ch.new, `${c.source} record ${c.sourceId}${c.updated ? ' updated ' + String(c.updated).slice(0, 10) : ''}`, ch.material ? 1 : 0]);
        }
        db.run(`update opp set review_state = case when ? = 'review' and review_state <> 'dismissed' then 'review' when ? = 'qualifying' and review_state = 'review' then 'none' else review_state end where id=?`, [m.tier, m.tier, r.id]);
      }
    });
    counts.new = created; counts.changed_fields = changed; counts.touched = touched.size;

    // ── incumbent enrichment (USAspending) ──
    if (!demo && profile.sources.usaspending.enabled) {
      let det = 0, capDet = 25;
      for (const r of db.all(`select id, incumbent from opp where lifecycle='active' and sources like '%usaspending_award%'`)) {
        const inc = parseJ<any>(r.incumbent, {}); if (!inc.genId || inc.value != null || det >= capDet) continue;
        try { det++; const d = await getAward(inc.genId, db); const ni = toIncumbent({ generatedId: inc.genId, piid: inc.piid, recipient: inc.name, agency: '', subAgency: '', amount: inc.obligations ?? null, description: '', start: inc.awardDate ?? null, end: inc.endDate ?? null, awardType: null, naics: null, psc: null }, d); db.run(`update opp set incumbent=? where id=?`, [J({ ...inc, ...ni }), r.id]); } catch { /* keep the summary-level incumbent */ }
      }
      counts.incumbent_details = det;
      try { const pl = await linkPredecessors(db, today, 40); counts.predecessor_checked = pl.checked; counts.predecessor_linked = pl.linked; counts.predecessor_confirmed = pl.confirmed; if (pl.checked) L(`Contract numbers cited in notices: ${pl.checked} looked up in USAspending, ${pl.linked} found, ${pl.confirmed} confirmed as incumbent/current`); }
      catch (e) { L(`predecessor lookup skipped: ${(e as Error).message}`); }
    }

    // ── score every active opportunity, then lifecycle and snapshots ──
    counts.rescored = rescoreAll(db, today, compiled, profile);
    Object.assign(counts, updateLifecycle(db, runId, win.to, coverage, demo ? { sam_notice: 'Synthetic demo data', gsa_forecast: 'Synthetic demo data', usaspending_award: 'Synthetic demo data' } : Object.fromEntries(connectors.map((c) => [c.id, c.name]))));
    counts.snapshots = snapshots(db, runId);

    const bad = coverage.filter((c) => c.status !== 'ok' && !/disabled in profile|no CSV files|no SAM_API_KEY/.test(c.detail) && c.status !== 'skipped');
    const active = coverage.filter((c) => c.status !== 'skipped');
    const status: RunSummary['status'] = !active.length || active.every((c) => c.status === 'failed') ? 'failed' : bad.length ? 'partial' : 'complete';
    const meta: ReportMeta = { runId, asOf: now, status, coverage, windowFrom: win.from, windowTo: win.to, mode, baselineRunId: baseline?.id ?? null, baselineStatus: baseline?.status ?? null, dry, demo, counts, thresholds: th, audit: { funnel: audit.funnel, byKeyword: audit.byKeyword, byAgency: audit.byAgency }, profile };
    const rep = await buildWorkbook(db, meta, o.reportDir);
    counts.report_rows = rep.rows;
    L(`Report ${rep.file} (${rep.rows} opportunities, ${(rep.bytes / 1024).toFixed(0)} KB); validation ${rep.validation.ok ? 'passed' : 'FAILED: ' + rep.validation.problems.join('; ')}`);
    db.run(`update run set finished_at=?, status=?, coverage=?, counts=?, report_file=?, report_bytes=?, log=?, audit=? where id=?`, [new Date().toISOString(), status, J(coverage), J(counts), rep.file, rep.bytes, J(log), J(meta.audit), runId]);
    const summary: RunSummary = { runId, status, dryRun: dry, file: rep.file, counts, coverage, log, validation: rep.validation };
    if (began) { db.raw.exec('rollback'); began = false; }
    return summary;
  } catch (e) {
    if (began) { try { db.raw.exec('rollback'); } catch { /* */ } began = false; }
    if (runId && !dry) { try { db.run(`update run set finished_at=?, status='failed', error=?, log=?, coverage=? where id=?`, [new Date().toISOString(), redactText((e as Error).message).slice(0, 500), J(log), J(coverage), runId]); } catch { /* */ } }
    throw e;
  } finally {
    release(); if (!o.db) db.close();
  }
}

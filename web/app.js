// Dependency-free UI. All dynamic text goes through textContent / createTextNode (never innerHTML).
'use strict';
const csrf = document.querySelector('meta[name=csrf]').content; const mode = document.querySelector('meta[name=mode]').content;
const $ = (s, r = document) => r.querySelector(s);
function h(tag, attrs, ...kids) { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs || {})) { if (k === 'class') e.className = v; else if (k === 'style') e.style.cssText = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (v !== false && v != null) e.setAttribute(k, v); } for (const k of kids.flat()) if (k != null && k !== false) e.append(k.nodeType ? k : document.createTextNode(String(k))); return e; }
const api = async (p, o) => { const r = await fetch(p, o && o.body ? { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify(o.body) } : o && o.method ? { method: o.method, headers: { 'x-csrf-token': csrf } } : undefined); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || r.status); return j; };
const usd = (n) => n == null ? '—' : n >= 1e9 ? '$' + (n / 1e9).toFixed(1) + 'B' : n >= 1e6 ? '$' + (n / 1e6).toFixed(1) + 'M' : '$' + Math.round(n / 1e3) + 'K';
const safeUrl = (u) => /^https?:\/\//i.test(u || '') ? u : null;
const cls = (c) => String(c || '').replace(/_/g, ' ');
const basis = { government: 'posted', government_estimate: 'agency estimate', imported: 'imported', derived: 'DERIVED estimate', unknown: 'unknown' };

$('#mode').textContent = mode === 'demo' ? 'SYNTHETIC DEMO DATA' : 'live'; $('#mode').className = 'pill ' + (mode === 'demo' ? 'demo' : '');
document.querySelectorAll('#tabs button').forEach((b) => b.addEventListener('click', () => { document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('on', x === b)); for (const s of ['overview', 'opps', 'ask', 'reports']) $('#' + s).hidden = s !== b.dataset.tab; load(b.dataset.tab); }));

async function overview() {
  const st = await api('/api/status'); const el = $('#overview'); el.replaceChildren();
  const last = st.runs[0]; const pill = $('#runpill'); pill.textContent = st.running ? 'run in progress…' : last ? `last run: ${last.status}` : 'no runs yet'; pill.className = 'pill ' + (st.running ? 'warn' : !last ? '' : last.status === 'complete' ? 'ok' : last.status === 'partial' ? 'warn' : 'bad');
  el.append(h('div', { class: 'grid' },
    h('div', { class: 'card' }, h('h3', {}, 'Active opportunities'), h('div', { class: 'big' }, st.counts?.n ?? 0)),
    h('div', { class: 'card' }, h('h3', {}, 'High priority'), h('div', { class: 'big' }, st.counts?.hi ?? 0)),
    h('div', { class: 'card' }, h('h3', {}, 'Medium priority'), h('div', { class: 'big' }, st.counts?.med ?? 0)),
    h('div', { class: 'card' }, h('h3', {}, 'Schedule'), h('div', {}, st.schedule ? `${st.schedule.cron} (${st.schedule.timezone})` : 'not configured'), h('div', { class: 'mute' }, 'Runs only while the daemon or an OS scheduler is active'))));
  if (mode !== 'demo') el.append(h('p', {}, h('button', { class: 'btn', id: 'runbtn', disabled: st.running, onclick: async (e) => { e.target.disabled = true; try { await api('/api/run', { method: 'POST' }); } catch (x) { alert(x.message); } setTimeout(overview, 1500); } }, st.running ? 'Run in progress…' : 'Run discovery now'), ' ', h('span', { class: 'mute' }, st.lastRunMsg || '')));
  if (last) {
    el.append(h('h3', {}, `Source health — run ${last.id} (${last.status})`));
    el.append(h('div', { class: 'tablewrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['Source', 'Status', 'Detail'].map((x) => h('th', {}, x)))), h('tbody', {}, last.coverage.map((c) => h('tr', {}, h('td', {}, c.source), h('td', {}, h('span', { class: 'tag ' + (c.status === 'ok' ? 'High' : '') }, c.status)), h('td', { class: 'mute' }, c.detail)))))));
    el.append(h('h3', {}, 'Recent runs'), h('div', { class: 'tablewrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['Run', 'Started', 'Status', 'New', 'Changed', 'Report'].map((x) => h('th', {}, x)))), h('tbody', {}, st.runs.map((r) => h('tr', {}, h('td', {}, r.id), h('td', {}, String(r.started_at).slice(0, 16).replace('T', ' ')), h('td', {}, r.status), h('td', {}, r.counts.new ?? 0), h('td', {}, r.counts.changed_fields ?? 0), h('td', {}, r.report_file ? h('a', { href: '/api/reports/' + encodeURIComponent(r.report_file) }, r.report_file) : '—')))))));
  } else el.append(h('p', {}, 'No run has completed yet. In a terminal: ', h('code', {}, 'npm run demo'), ' (sample data) or ', h('code', {}, 'npm run run'), '.'));
}
let oppState = { department: '', priority: '', classification: '', q: '' };
async function opps() {
  const el = $('#opps'); const qs = new URLSearchParams(Object.entries(oppState).filter(([, v]) => v)); const d = await api('/api/opportunities?' + qs);
  el.replaceChildren();
  const sel = (key, label, opts) => h('select', { onchange: (e) => { oppState[key] = e.target.value; opps(); } }, h('option', { value: '' }, label), opts.map((o) => h('option', { value: o, selected: oppState[key] === o }, o)));
  el.append(h('div', { class: 'bar' }, sel('department', 'All departments', d.departments), sel('priority', 'Any priority', ['High', 'Medium', 'Low', 'Watch']), sel('classification', 'Any type', ['confirmed_recompete', 'likely_recompete', 'possible_followon', 'expiring_no_followon', 'new_requirement', 'unknown']),
    h('input', { type: 'search', placeholder: 'Search title or description', value: oppState.q, onkeydown: (e) => { if (e.key === 'Enter') { oppState.q = e.target.value; opps(); } } }), h('span', { class: 'mute' }, d.rows.length + ' shown')));
  el.append(h('div', { class: 'tablewrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['Priority', 'Opportunity', 'Agency', 'Release', 'Value', 'Type', 'Confidence'].map((x) => h('th', {}, x)))),
    h('tbody', {}, d.rows.map((r) => h('tr', { class: 'row', onclick: () => detail(r.id) }, h('td', {}, h('span', { class: 'tag ' + r.priority }, `${r.priority} ${r.score ?? ''}`)), h('td', {}, r.title), h('td', {}, `${r.department} — ${r.agency}`),
      h('td', { class: r.releaseBasis === 'government' ? '' : 'est' }, r.release || '—', h('div', { class: 'mute' }, basis[r.releaseBasis] || r.releaseBasis)), h('td', {}, usd(r.value)), h('td', {}, cls(r.classification)), h('td', {}, r.confidence || '')))))));
}
async function detail(id) {
  const o = await api('/api/opportunity/' + id); const dr = $('#drawer'); dr.replaceChildren(); dr.hidden = false;
  const kv = (k, v) => [h('dt', {}, k), h('dd', {}, v ?? '—')];
  const link = safeUrl(o.primary_url);
  dr.append(h('button', { class: 'btn close', onclick: () => { dr.hidden = true; } }, 'Close'), h('h2', {}, o.title), h('p', { class: 'mute' }, `${o.department} — ${o.agency}${o.subagency ? ' / ' + o.subagency : ''}`),
    h('dl', { class: 'kv' }, kv('Priority', `${o.priority} (${o.priority_score}) — score confidence ${o.priority_detail?.confidence ?? 'n/a'}`), kv('Release', `${o.sol_date || o.fields?.derived_release || 'unknown'} (${basis[o.sol_date ? o.sol_date_basis : o.fields?.derived_release ? 'derived' : 'unknown']})`), kv('Award (approx.)', o.award_date), kv('Value', o.value_usd != null ? `${usd(o.value_usd)} — ${o.value_type || 'estimate'}` : null),
      kv('Classification', cls(o.classification)), kv('Evidence', o.fields?.classEvidence), kv('Incumbent', o.incumbent?.name ? `${o.incumbent.name} • ${o.incumbent.piid || ''} • ends ${o.incumbent.endDate || '?'}` : null), kv('Keywords', (o.matched_keywords || []).join(', ')), kv('Sources', (o.sources || []).join(', ')), kv('Confidence', o.confidence),
      kv('Link', link ? [h('a', { href: link, target: '_blank', rel: 'noopener noreferrer' }, link), h('div', { class: 'mute' }, o.url_kind === 'listing' ? 'Listing page — search it for the title' : 'Direct record link from the source')] : null)),
    h('p', {}, o.description || ''));
  dr.append(h('h3', {}, 'Why this score'));
  for (const c of o.priority_detail?.components || []) dr.append(h('div', { class: 'comp' }, h('span', {}, c.label), h('div', { class: 'meter' }, h('i', { style: 'width:' + Math.max(2, c.score) + '%' })), h('span', {}, c.score)), h('div', { class: 'mute' }, c.note + (c.known ? '' : ' (unknown input)')));
  if ((o.gaps || []).length) dr.append(h('h3', {}, 'Gaps and caveats'), h('ul', {}, o.gaps.map((g) => h('li', {}, g))));
  if ((o.indicators || []).length) dr.append(h('h3', {}, 'Incumbent indicators'), h('ul', {}, o.indicators.map((g) => h('li', {}, `[${g.label}] ${g.text}`))));
  if ((o.changes || []).length) dr.append(h('h3', {}, 'Recent changes'), h('ul', {}, o.changes.map((c) => h('li', {}, `${cls(c.kind)}${c.field ? ` — ${c.field}: ${c.old_value ?? '—'} → ${c.new_value ?? '—'}` : ''}`))));
}
function askTab() {
  const el = $('#ask'); if (el.childElementCount) return; const out = h('pre', { class: 'answer' }, 'Ask about your stored opportunities. Examples: “Which DHS opportunities release in the next 6 months?”, “high priority recompetes”, “what changed since yesterday?”.');
  const box = h('textarea', { rows: 2, placeholder: 'Type a question and press Ask', style: 'width:100%' });
  const go = async () => { out.textContent = 'Thinking…'; try { const a = await api('/api/ask', { body: { question: box.value } }); out.textContent = a.text; } catch (e) { out.textContent = 'Error: ' + e.message; } };
  box.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); go(); } });
  el.append(box, h('p', {}, h('button', { class: 'btn', onclick: go }, 'Ask')), out);
}
async function reports() {
  const el = $('#reports'); const d = await api('/api/reports'); el.replaceChildren(h('h3', {}, 'Excel reports'), d.files.length ? h('div', { class: 'tablewrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['File', 'Size', 'Modified'].map((x) => h('th', {}, x)))), h('tbody', {}, d.files.map((f) => h('tr', {}, h('td', {}, h('a', { href: '/api/reports/' + encodeURIComponent(f.name) }, f.name)), h('td', {}, Math.round(f.bytes / 1024) + ' KB'), h('td', {}, f.modified.slice(0, 16).replace('T', ' '))))))) : h('p', {}, 'No reports yet.'));
}
function load(tab) { ({ overview, opps, ask: askTab, reports })[tab]().catch((e) => { $('#' + tab).replaceChildren(h('p', { class: 'err' }, 'Error: ' + e.message)); }); }
load('overview'); setInterval(() => { if (!$('#overview').hidden) overview().catch(() => {}); }, 15000);

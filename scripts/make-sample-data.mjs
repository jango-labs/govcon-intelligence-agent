// Generates the SYNTHETIC demo data (data/sample/*.json). Deterministic: running it twice yields identical files.
// Nothing here is real: agencies are real department names (public), but every opportunity, company, contract number and link is invented.
import { writeFileSync, mkdirSync } from 'node:fs';
let seed = 20260101; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const ORGS = [
  ['Department of Defense', 'Department of the Army', 'Army Contracting Command'], ['Department of Defense', 'Department of the Navy', 'Naval Information Warfare Systems Command'],
  ['Department of Defense', 'Department of the Air Force', 'Air Force Life Cycle Management Center'], ['Department of Defense', 'Defense Information Systems Agency', 'DISA Procurement Services'],
  ['Department of Defense', 'Defense Health Agency', 'DHA Contracting'], ['Department of Homeland Security', 'U.S. Customs and Border Protection', 'CBP Office of Acquisition'],
  ['Department of Homeland Security', 'Transportation Security Administration', 'TSA Contracting'], ['Department of Homeland Security', 'U.S. Citizenship and Immigration Services', 'USCIS Office of Contracting'],
  ['Department of Homeland Security', 'Federal Emergency Management Agency', 'FEMA Procurement'], ['Department of Veterans Affairs', 'Veterans Health Administration', 'Technology Acquisition Center'],
  ['Department of Veterans Affairs', 'Veterans Benefits Administration', 'Network Contracting Office'], ['Department of Health and Human Services', 'Centers for Medicare and Medicaid Services', 'CMS Office of Acquisition'],
  ['Department of Health and Human Services', 'National Institutes of Health', 'NIH Office of Acquisitions'], ['Department of Justice', 'Federal Bureau of Investigation', 'FBI Procurement Section'],
  ['Department of Justice', 'Drug Enforcement Administration', 'DEA Acquisition'],
];
const TOPICS = [
  ['Cloud Migration and Hosting Services', 'cloud migration of legacy mission applications to a FedRAMP-authorized commercial cloud environment, including hosting and sustainment', 'a1'],
  ['Zero Trust Architecture Implementation Support', 'cybersecurity engineering for zero trust architecture, identity management and continuous monitoring across enterprise networks', 'a2'],
  ['Enterprise Data Platform and Analytics', 'data platform, data management and data analytics services including dashboards and business intelligence for program offices', 'a3'],
  ['AI-Enabled Case Management Modernization', 'artificial intelligence and machine learning to modernize the case management system and automate document triage workflows', 'a4'],
  ['DevSecOps Software Factory', 'DevSecOps pipeline, agile software development and platform engineering support for multiple mission applications', 'a5'],
  ['IT Operations and Service Desk Support', 'IT operations, help desk and end-user support for enterprise IT across headquarters and field offices', 'a6'],
  ['Electronic Health Record Interoperability', 'health IT and electronic health record interoperability engineering, data exchange and testing', 'a7'],
  ['Robotic Process Automation Center of Excellence', 'robotic process automation and intelligent automation of back-office workflows with measurable savings', 'a8'],
  ['Application Modernization and Systems Integration', 'application modernization and systems integration for legacy systems, including API gateways and migration', 'a9'],
  ['Identity and Access Management Services', 'identity and access management, cybersecurity operations and credentialing services', 'b1'],
  ['Mission Workflow and Case Tracking System', 'workflow automation and case management for field operations with reporting and analytics', 'b2'],
  ['Enterprise Network Operations Center', 'network operations, IT operations, monitoring and cyber incident response', 'b3'],
  ['Janitorial and Grounds Maintenance (synthetic non-IT example)', 'janitorial services and grounds maintenance for administrative buildings', 'b4'],
  ['Uniform Supply and Distribution (synthetic non-IT example)', 'uniforms, boots and distribution of apparel items', 'b5'],
];
const COMPANIES = ['Acme Federal Systems (synthetic)', 'Orion Test Corp (synthetic)', 'Blue Harbor Technologies (synthetic)', 'Cedar Ridge Solutions (synthetic)', 'Northgate Example Services (synthetic)', 'Summit Placeholder LLC (synthetic)'];
const TYPES = ['Presolicitation', 'Sources Sought', 'Combined Synopsis/Solicitation', 'Forecast', 'Forecast', 'Forecast'];
const VEH = [null, null, 'GSA MAS (synthetic)', 'Agency IDIQ (synthetic)', 'GWAC (synthetic)'];
const items = [];
for (let i = 0; i < 44; i++) {
  const t = TOPICS[i % TOPICS.length]; const org = ORGS[(i * 7 + 3) % ORGS.length]; const type = TYPES[i % TYPES.length]; const n = String(i + 1).padStart(3, '0');
  const cls = ['new_requirement', 'likely_recompete', 'confirmed_recompete', 'possible_followon', 'unknown'][Math.floor(rnd() * 5)];
  const hasInc = cls === 'confirmed_recompete' || cls === 'likely_recompete';
  const sol = Math.floor(30 + rnd() * 600); const value = [null, 750e3, 2.4e6, 8e6, 18e6, 45e6, 120e6, 340e6][Math.floor(rnd() * 8)];
  items.push({
    id: `DEMO-${n}`, title: `${t[0]} ${['Phase II', 'Follow-on', 'Enterprise', 'Regional', 'Program Office'][i % 5]} (synthetic ${n})`, description: `SYNTHETIC EXAMPLE. ${t[1]}. This record is invented for demonstration; it does not describe a real procurement.${hasInc ? ' This requirement is a follow-on to the current contract.' : ''}`,
    department: org[0], agency: org[1], subagency: org[2], solicitationNumber: `DEMO${n}-${2026 + (i % 2)}-R-${1000 + i}`,
    solOffsetDays: type === 'Combined Synopsis/Solicitation' ? -Math.floor(rnd() * 20) : sol, awardOffsetDays: sol + 90 + Math.floor(rnd() * 120),
    solBasis: type === 'Forecast' ? 'government_estimate' : 'government', valueUsd: value, valueType: value ? (type === 'Forecast' ? 'agency dollar range, lower bound (synthetic)' : 'estimated (synthetic)') : null,
    setAside: pick([null, 'Total Small Business', '8(a)', 'Service-Disabled Veteran-Owned', 'Full and Open']), instrument: pick(['Task Order', 'IDIQ', 'BPA', 'Standalone contract']), vehicle: pick(VEH), duration: pick(['3 years', '5 years', '12 months + 4 option years']),
    naics: pick(['541512', '541511', '541519', '518210', '541330', '541690']), psc: pick(['D302', 'D307', 'D310', 'DA01', 'R499']), status: type === 'Forecast' ? 'Forecast (synthetic)' : type, stage: type === 'Forecast' ? 'forecast' : type,
    classHint: cls, classEvidence: hasInc ? 'synthetic: agency states follow-on to existing contract' : undefined, fiscalYear: 2027 + (i % 2),
    incumbent: hasInc ? { name: pick(COMPANIES), piid: `DEMO${n}D${String(2000 + i)}`, endOffsetDays: sol + 60 + Math.floor(rnd() * 90), valueUsd: value ? value * 1.1 : 15e6, obligationsPct: [0.35, 0.6, 0.93, 0.97][Math.floor(rnd() * 4)] } : undefined,
    sourceKind: type === 'Forecast' ? 'gsa_forecast' : 'sam_notice', url: `https://example.com/synthetic/opportunity/DEMO-${n}`, urlKind: type === 'Forecast' ? 'listing' : 'record',
  });
}
// a few expiring-contract records (the "USAspending" kind): no follow-on identified
for (let i = 0; i < 6; i++) { const t = TOPICS[i * 2 % TOPICS.length]; const org = ORGS[(i * 5 + 1) % ORGS.length]; const n = String(100 + i);
  items.push({ id: `DEMO-X${n}`, title: `Expiring contract: ${t[0]} (synthetic ${n})`, description: `SYNTHETIC EXAMPLE. ${t[1]}. Invented expiring award.`, department: org[0], agency: org[1], subagency: org[2], piid: `DEMOX${n}F0${n}`,
    awardOffsetDays: 120 + i * 90, solBasis: 'unknown', valueUsd: null, naics: '541512', status: 'Contract period ends (synthetic)', stage: 'expiring_award', classHint: 'expiring_no_followon', classEvidence: 'synthetic: contract period ends inside the window',
    incumbent: { name: pick(COMPANIES), piid: `DEMOX${n}F0${n}`, endOffsetDays: 120 + i * 90, valueUsd: 9e6 + i * 4e6, obligationsPct: 0.8 }, sourceKind: 'usaspending_award', url: `https://example.com/synthetic/award/DEMO-X${n}`, urlKind: 'record' }); }
// Day 2: some dates move, a value changes, a few new records appear, one is cancelled, one disappears.
const day2 = JSON.parse(JSON.stringify(items));
day2[0].solOffsetDays += 45; day2[2].solOffsetDays += 20; day2[3].valueUsd = (day2[3].valueUsd ?? 5e6) * 1.6; day2[5].status = 'Cancelled - no longer required (synthetic)';
day2[7].setAside = 'Total Small Business'; day2.splice(9, 1);
for (let i = 0; i < 3; i++) { const t = TOPICS[(i + 3) % TOPICS.length]; const org = ORGS[(i * 4 + 2) % ORGS.length]; day2.push({ id: `DEMO-N${i + 1}`, title: `${t[0]} Rapid Award (synthetic new ${i + 1})`, description: `SYNTHETIC EXAMPLE NEW RECORD. ${t[1]}. New requirement, no incumbent.`, department: org[0], agency: org[1], subagency: org[2], solicitationNumber: `DEMON${i + 1}-2027-R-${3000 + i}`, solOffsetDays: 20 + i * 40, awardOffsetDays: 150 + i * 40, solBasis: 'government', valueUsd: 6e6 * (i + 1), naics: '541512', status: 'Presolicitation', stage: 'Presolicitation', classHint: 'new_requirement', sourceKind: 'sam_notice', url: `https://example.com/synthetic/opportunity/DEMO-N${i + 1}`, urlKind: 'record' }); }
mkdirSync('data/sample', { recursive: true });
writeFileSync('data/sample/opportunities-day1.json', JSON.stringify({ synthetic: true, note: 'SYNTHETIC DEMO DATA. All records are invented. Offsets are days relative to the run date so the demo always looks current.', items }, null, 1) + '\n');
writeFileSync('data/sample/opportunities-day2.json', JSON.stringify({ synthetic: true, note: 'SYNTHETIC DEMO DATA, second day: shows new, changed, cancelled and vanished records.', items: day2 }, null, 1) + '\n');
console.log(`wrote ${items.length} + ${day2.length} synthetic records`);

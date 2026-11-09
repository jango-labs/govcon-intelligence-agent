// Department/agency normalisation. Maps any department / agency / office string (SAM.gov paths, forecast feeds, CSV imports) to ONE department
// and a component, so the same buying organisation is never counted twice. Five departments have component-level rules; other federal
// departments and agencies are recognised by name (department-level only). Pure functions, no I/O.
export type Dept = string;
export const COMPONENT_DEPTS: Dept[] = ['DoD', 'DHS', 'DOJ', 'HHS', 'VA'];
export interface Org { department: Dept | null; agency: string; subagency: string }

const DOD_AGENCIES: [string, RegExp][] = [
  ['Army', /\b(u\.?s\.? )?army\b|\busaisec\b|\binscom\b|\bacc[- ]\w+|\bpeo\b|\busace\b|corps of engineers|\bcecom\b|\bamcom\b|\bt2com\b/i],
  ['Navy', /\b(u\.?s\.? )?navy\b|\bnaval\b|\bniwc\b|\bnavwar\b|\bnavsea\b|\bnavair\b|\bnavfac\b|\bnsw[cd]\b|\bspawar\b|\bsupship\b/i],
  ['Marine Corps', /\bmarine corps\b|\busmc\b|\bmarcorsyscom\b/i],
  ['Air Force', /\bair force\b|\busaf\b|\bafrl\b|\bafmc\b|\bafmsa\b|\bdaf\b|department of the air force/i],
  ['Space Force', /\bspace force\b|\bussf\b|space systems command|\bssc\b/i],
  ['DISA', /\bdisa\b|defense information systems agency/i],
  ['DLA', /\bdla\b|defense logistics agency/i],
  ['DHA', /\bdha\b|defense health agency/i],
  ['MDA', /\bmda\b|missile defense agency/i],
  ['NGA', /\bnga\b|geospatial-intelligence/i],
  ['DIA', /\bdia\b|defense intelligence agency/i],
  ['NSA', /\bnsa\b|national security agency/i],
  ['SOCOM', /\bsocom\b|special operations command/i],
  ['Cyber Command', /\bcybercom\b|cyber command/i],
  ['OSD/Joint Staff', /office of the secretary of defense|\bosd\b|joint chiefs|joint staff/i],
  ['DTRA/DARPA/Other DoD', /\bdtra\b|\bdarpa\b|defense advanced research|\bwhs\b|washington headquarters|\bdcma\b|\bdcaa\b|\bdodea\b|\bdfas\b|\bdeca\b|\bdoded\b|defense (finance|contract|threat|technical|counterintelligence)|\bdtic\b|\btransportcom\b|\btranscom\b|\bcentcom\b|\bsouthcom\b|\bindopacom\b|\beucom\b|\bafricom\b|\bnorthcom\b|\bstratcom\b/i],
];
const DHS_COMPONENTS: [string, RegExp][] = [
  ['CBP', /\bcbp\b|customs and border/i], ['ICE', /\bice\b|immigration and customs enforcement/i], ['TSA', /\btsa\b|transportation security administration/i],
  ['USCIS', /\buscis\b|citizenship and immigration/i], ['USCG', /\buscg\b|coast guard/i], ['FEMA', /\bfema\b|federal emergency management/i],
  ['CISA', /\bcisa\b|cybersecurity and infrastructure/i], ['USSS', /\busss\b|secret service/i], ['FLETC', /\bfletc\b|federal law enforcement training/i],
  ['DHS S&T', /\bs&t\b|science and technology directorate|\bst\b directorate/i], ['MGMT/OCPO/OCIO', /\bocpo\b|\bocio\b|\bmgmt\b|management directorate|office of procurement|chief information officer|\bhq\b|headquarters/i],
  ['CWMD', /\bcwmd\b|countering weapons of mass destruction/i], ['I&A/OPS', /intelligence and analysis|office of operations coordination|\boig\b|inspector general/i],
];
const DOJ_COMPONENTS: [string, RegExp][] = [
  ['FBI', /\bfbi\b|federal bureau of investigation|criminal justice information services|\bcjis\b/i], ['DEA', /\bdea\b|drug enforcement/i], ['ATF', /\batf\b|alcohol,? tobacco,? firearms/i], ['USMS', /\busms\b|marshals service|u\.?s\.? marshals/i],
  ['BOP', /\bbop\b|bureau of prisons|federal prison industries|unicor|community corrections|correctional programs/i], ['EOIR', /\beoir\b|immigration review/i], ['EOUSA/USAO', /\beousa\b|\busao\b|attorneys?\b.*\b(us|u\.s\.)|executive office for (us|u\.s\.) attorneys/i],
  ['OJP', /\bojp\b|office of justice programs|\bovw\b|\bcops\b|violence against women|bureau of justice|national institute of justice/i], ['JMD', /\bjmd\b|justice management division/i], ['NSD', /\bnsd\b|national security division/i],
  ['Civil/Criminal/Other Divisions', /criminal division|civil division|civil rights|antitrust|environment and natural resources|tax division|\bnsd\b/i], ['OIG', /inspector general|\boig\b/i], ['Federal Detention Trustee', /detention trustee|\bofdt\b/i], ['USTP', /trustee program/i],
];
const DOJ_ROOT = /\b(department of justice|dept\.? of justice)\b|\bdoj\b|justice,? department of|^justice$/i;
const HHS_COMPONENTS: [string, RegExp][] = [
  ['NIH', /\bnih\b|national institutes? of health|national (cancer|heart|eye|human genome|library of medicine)|national institute of|\b(niaid|nhlbi|nimh|nida|niaaa|niddk|ninds|nigms|nlm)\b|nih clinical center/i],
  ['CMS', /\bcms\b|centers? for medicare|medicare and medicaid|\bmedicaid\b/i], ['CDC', /\bcdc\b|centers? for disease control|\batsdr\b|\bniosh\b/i], ['FDA', /\bfda\b|food and drug administration/i],
  ['HRSA', /\bhrsa\b|health resources and services/i], ['SAMHSA', /\bsamhsa\b|substance abuse and mental health/i], ['IHS', /\bihs\b|indian health service/i], ['ASPR', /\baspr\b|preparedness and response|\bbarda\b/i],
  ['ACF', /\bacf\b|administration for children and families/i], ['ACL', /\bacl\b|administration for community living/i], ['AHRQ', /\bahrq\b|healthcare research and quality/i], ['ARPA-H', /arpa[- ]h|advanced research projects agency for health/i],
  ['OS/ASA/OAMP', /office of (the )?secretary|assistant secretary|acquisition management and policy|\boamp\b|\basa\b|\bocio\b|\basfr\b/i], ['OIG', /inspector general|\boig\b/i],
];
const VA_COMPONENTS: [string, RegExp][] = [
  ['VHA', /\bvha\b|veterans health administration|\bvamc\b|\bvisn\b|medical center/i], ['VBA', /\bvba\b|veterans benefits administration/i], ['NCA', /national cemetery/i],
  ['OIT', /office of information and technology|\boit\b/i], ['OALC/NAC', /acquisition, logistics|\boalc\b|\bnac\b|network contracting office|technology acquisition center|\btac\b|strategic acquisition center/i],
  ['BVA', /board of veterans appeals/i], ['OEI/OM/OS', /enterprise integration|office of management|office of the secretary|human resources and administration/i], ['OIG', /inspector general|\boig\b/i],
];
const HHS_ROOT = /\b(department of health and human services|dept\.? of health and human services)\b|\bhhs\b|health and human services,? department of|^health and human services$/i;
const VA_ROOT = /\b(department of veterans affairs|dept\.? of veterans affairs)\b|veterans affairs,? department of|^veterans affairs$|^va$|\bdva\b/i;
const DOD_ROOT = /\b(department|dept\.?) of (defense|war)\b|\bdod\b|\bdow\b|\bdefense,? department of\b|\bwar,? department of\b|^defense$|\bdefense agencies\b/i;
const DHS_ROOT = /\bdepartment of homeland security\b|\bdhs\b|homeland security,? department of|\bhomeland security\b/i;

/** Normalise any combination of department / agency / office strings (SAM.gov paths, USAspending names, CSV columns) to one department and component. */
export function normalizeOrg(...parts: (string | null | undefined)[]): Org {
  const text = parts.filter(Boolean).join(' | ');
  if (!text) return { department: null, agency: '', subagency: '' };
  const partExec = (re: RegExp) => { for (const p of parts) { const m = p ? re.exec(p) : null; if (m) return m; } return re.exec(text); };     // anchored patterns such as ^defense$ must be tried on each part
  const REG: { dept: Dept; root: RegExp; comps: [string, RegExp][] }[] = [{ dept: 'DoD', root: DOD_ROOT, comps: DOD_AGENCIES }, { dept: 'DHS', root: DHS_ROOT, comps: DHS_COMPONENTS }, { dept: 'DOJ', root: DOJ_ROOT, comps: DOJ_COMPONENTS }, { dept: 'HHS', root: HHS_ROOT, comps: HHS_COMPONENTS }, { dept: 'VA', root: VA_ROOT, comps: VA_COMPONENTS }];
  const roots = REG.map((r) => ({ r, m: partExec(r.root) })).filter((x) => x.m).sort((a, b) => a.m!.index - b.m!.index);
  let hit: (typeof REG)[number] | undefined = roots[0]?.r;
  if (!hit) hit = REG.find((r) => r.comps.some(([, re]) => re.test(text)) && !(r.dept === 'DOJ' && /\bice\b/i.test(text)));       // no department named: the first department with a recognisable component
  if (!hit) {
    for (const [code, re] of OTHER_DEPTS) if (partExec(re)) return { department: code, agency: `${code} (department level)`, subagency: officeOf(parts) };
    return { department: null, agency: parts.find(Boolean) ?? '', subagency: '' };
  }
  const comp = hit.comps.find(([, re]) => re.test(text))?.[0];
  return { department: hit.dept, agency: comp ?? `${hit.dept} (unspecified component)`, subagency: officeOf(parts, comp) };
}
const GENERIC = /^((u\.?s\.?|united states) )?(department of (the )?)?(justice|health and human services|veterans affairs|army|navy|air force|marine corps|space force|coast guard|customs and border protection|immigration and customs enforcement|transportation security administration|citizenship and immigration services|federal emergency management agency|secret service|defense|war|homeland security)( \(.*\))?$/i;
function officeOf(parts: (string | null | undefined)[], _agency?: string): string {
  const cands = parts.filter((p): p is string => !!p).flatMap((p) => p.split(/\s*(?:\||>|\s\/\s)\s*/)).map((s) => s.trim())
    .filter((s) => s && !DOD_ROOT.test(s) && !DHS_ROOT.test(s) && !DOJ_ROOT.test(s) && !HHS_ROOT.test(s) && !VA_ROOT.test(s) && !GENERIC.test(s));
  return cands.slice(-1)[0] ?? '';
}

/** Other federal departments / agencies recognised by name only (no component rules). Add yours here or open a PR. */
export const OTHER_DEPTS: [Dept, RegExp][] = [
  ['DOE', /\bdepartment of energy\b|\bdoe\b/i], ['DOT', /\bdepartment of transportation\b|\bdot\b|\bfaa\b|federal aviation/i], ['State', /\bdepartment of state\b|\busaid\b/i],
  ['Treasury', /\b(department of the )?treasury\b|\birs\b|internal revenue/i], ['USDA', /\bdepartment of agriculture\b|\busda\b/i], ['DOI', /\bdepartment of the interior\b|\bdoi\b/i],
  ['Commerce', /\bdepartment of commerce\b|\bnoaa\b|\bnist\b|census bureau|\buspto\b|patent and trademark/i], ['Education', /\bdepartment of education\b/i], ['Labor', /\bdepartment of labor\b/i],
  ['HUD', /housing and urban development|\bhud\b/i], ['EPA', /environmental protection agency|\bepa\b/i], ['NASA', /national aeronautics|\bnasa\b/i], ['GSA', /general services administration|\bgsa\b/i],
  ['SSA', /social security administration|\bssa\b/i], ['OPM', /office of personnel management|\bopm\b/i], ['SBA', /small business administration|\bsba\b/i], ['NSF', /national science foundation|\bnsf\b/i],
  ['NRC', /nuclear regulatory commission|\bnrc\b/i], ['FCC', /federal communications commission|\bfcc\b/i], ['SEC', /securities and exchange commission/i],
];
/** Is the organisation inside the configured departments? "*" or "ALL" admits every recognised department. */
export function inScope(o: Org, departments: string[]): boolean {
  if (!o.department) return false;
  if (departments.some((d) => d === '*' || d.toUpperCase() === 'ALL')) return true;
  const want = departments.map((d) => d.toLowerCase().replace(/^dod\/dow$/, 'dod'));
  return want.includes(o.department.toLowerCase());
}
export const DEPT_FULL: Record<string, string> = { DoD: 'Department of Defense', DHS: 'Department of Homeland Security', DOJ: 'Department of Justice', HHS: 'Department of Health and Human Services', VA: 'Department of Veterans Affairs' };

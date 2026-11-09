export type SrcName = 'sam_notice' | 'usaspending_award' | 'gsa_forecast' | 'csv_import' | 'sample' | (string & {});
export interface Incumbent {
  name?: string; uei?: string; piid?: string; parentVehicle?: string;
  value?: number | null; valueType?: string; awardDate?: string; endDate?: string; obligations?: number | null; obligationsAsOf?: string; obligationsSource?: string;
  optionsRemaining?: string; source?: string; genId?: string; url?: string;
}
export type Classification = 'confirmed_recompete' | 'likely_recompete' | 'possible_followon' | 'expiring_no_followon' | 'new_requirement' | 'unknown';
/** URL kinds: "record" = deep link to this specific record on the source (verified: it came from the source's own response);
 *  "listing" = the source's search/listing page (no per-record deep link exists); "none" = no link. */
export type UrlKind = 'record' | 'listing' | 'none';
export interface Candidate {
  source: SrcName; sourceId: string; url?: string; urlKind?: UrlKind; updated?: string | null;
  solicitationNumber?: string; piid?: string;
  title: string; description?: string; department: string | null; agency: string; subagency: string;
  solDate?: string | null; solBasis?: string; awardDate?: string | null; awardBasis?: string; fiscalYear?: number;
  valueUsd?: number | null; valueType?: string; valueNote?: string;
  setAside?: string; instrument?: string; vehicle?: string; duration?: string; naics?: string; psc?: string; status?: string; stage?: string;
  incumbent?: Incumbent; classHint?: Classification; classEvidence?: string;
  other?: string; raw?: unknown;
}
export interface SourceCoverage { source: string; status: 'ok' | 'partial' | 'failed' | 'skipped'; detail: string; fetched?: number; expected?: number; calls?: number }
export interface DiscoverResult { candidates: Candidate[]; coverage: SourceCoverage }
export interface DiscoverContext {
  profile: import('./config.ts').Profile; keywords: string[]; window: { from: string; to: string }; today: string; db: import('./db.ts').Db;
  getSecret: (n: import('./secrets.ts').SecretName) => Promise<string | null>; log: (m: string) => void;
}
/** Contract for a data source. Built-in connectors and user plugins implement this. */
export interface Connector {
  id: string; name: string;
  /** "public" sources need no account; "key" needs the user's own free key; "licensed" needs a paid subscription held by the user. */
  access: 'public' | 'key' | 'licensed' | 'file' | 'demo';
  discover(ctx: DiscoverContext): Promise<DiscoverResult>;
}
export class SetupRequired extends Error { constructor(msg: string) { super(msg); this.name = 'SetupRequired'; } }

// The SecLang configuration that loads the OWASP Core Rule Set. Derived from @coraza/coreruleset's `recommended()` (Apache-2.0, see
// THIRD_PARTY_NOTICES.md). The rule files are inside the WASM module (the `coraza-coreruleset` Go module); these are only the `Include`
// lines and tuning that choose among them.
//
// Only the request rules are loaded. The engine inspects requests, not responses, so the RESPONSE-* files could never fire, and loading them
// costs memory and start-up time in every WAF instance.

export interface RulesOptions {
  /** CRS paranoia level: 1 (fewest false positives) to 4 (strictest). */
  paranoia: number;
  /** Rule ids to remove, to stop a rule that blocks something legitimate in this app. */
  disabledRules?: readonly number[];
}

// CRS 4.x, in the order its phases rely on: initialization and exceptions first, the blocking decision last.
// The PHP and Java files are left out, since forge apps are neither.
const CRS_FILES = [
  "REQUEST-901-INITIALIZATION.conf",
  "REQUEST-905-COMMON-EXCEPTIONS.conf",
  "REQUEST-911-METHOD-ENFORCEMENT.conf",
  "REQUEST-913-SCANNER-DETECTION.conf",
  "REQUEST-920-PROTOCOL-ENFORCEMENT.conf",
  "REQUEST-921-PROTOCOL-ATTACK.conf",
  "REQUEST-922-MULTIPART-ATTACK.conf",
  "REQUEST-930-APPLICATION-ATTACK-LFI.conf",
  "REQUEST-931-APPLICATION-ATTACK-RFI.conf",
  "REQUEST-932-APPLICATION-ATTACK-RCE.conf",
  "REQUEST-934-APPLICATION-ATTACK-GENERIC.conf",
  "REQUEST-941-APPLICATION-ATTACK-XSS.conf",
  "REQUEST-942-APPLICATION-ATTACK-SQLI.conf",
  "REQUEST-943-APPLICATION-ATTACK-SESSION-FIXATION.conf",
  "REQUEST-949-BLOCKING-EVALUATION.conf",
];

/** Anomaly score a request reaches before it is stopped: one critical match (5) is enough. */
export const INBOUND_THRESHOLD = 5;

/**
 * Left as CRS has it, so what the engine does is what CRS's documentation says: a body is let through only as a form, multipart, XML or JSON
 * (rule 920420 refuses other types). A route that takes other bodies (binary, text/plain, which rule 921150 reads for header injection)
 * belongs in WAF_IGNORE_PATHS.
 */
export function buildRules({ paranoia, disabledRules = [] }: RulesOptions): string {
  if (!Number.isInteger(paranoia) || paranoia < 1 || paranoia > 4) throw new Error(`paranoia must be 1 to 4, got ${paranoia}`);
  return [
    "Include @coraza.conf-recommended",
    // The module ships this file with the `.example` suffix, as upstream CRS distributes it; the actions below take the place of editing it.
    "Include @crs-setup.conf.example",
    `SecAction "id:900000,phase:1,nolog,pass,t:none,setvar:tx.blocking_paranoia_level=${paranoia}"`,
    `SecAction "id:900001,phase:1,nolog,pass,t:none,setvar:tx.inbound_anomaly_score_threshold=${INBOUND_THRESHOLD}"`,
    ...CRS_FILES.map((file) => `Include @owasp_crs/${file}`),
    ...disabledRules.map((id) => `SecRuleRemoveById ${id}`),
    "",
  ].join("\n");
}

// @adjudicate/intent-core — public surface.

export {
  BASIS_CODES,
  basis,
  isKnownBasisCode,
  type BasisCategory,
  type BasisCode,
  type BasisCodesMap,
  type DecisionBasis,
} from "./basis-codes.js";

export {
  refuse,
  type Refusal,
  type RefusalKind,
} from "./refusal.js";

export {
  canPropose,
  canProposeFieldLevel,
  collectFieldTaints,
  isTaintedValue,
  meetAll,
  mergeTaint,
  tainted,
  type Taint,
  type TaintPolicy,
  type TaintedValue,
} from "./taint.js";

export {
  decisionDefer,
  decisionEscalate,
  decisionExecute,
  decisionRefuse,
  decisionRequestConfirmation,
  decisionRewrite,
  type Decision,
  type DecisionKind,
} from "./decision.js";

export {
  buildEnvelope,
  hasUnknownEnvelopeVersion,
  INTENT_ENVELOPE_VERSION,
  isIntentEnvelope,
  type BuildEnvelopeInput,
  type IntentActor,
  type IntentEnvelope,
  type IntentEnvelopeVersion,
} from "./envelope.js";

export {
  AUDIT_RECORD_VERSION,
  buildAuditRecord,
  type AuditRecord,
  type BuildAuditInput,
} from "./audit.js";

export { canonicalJson, sha256Canonical } from "./hash.js";

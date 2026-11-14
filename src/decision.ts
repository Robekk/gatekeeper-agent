/**
 * Deterministic Proof Gatekeeper decision logic.
 *
 * Fail closed: any missing / malformed / uncertain field makes the check
 * that depends on it FAIL (reject), never pass. Checks run in the order
 * below and the first failure wins.
 */

export interface GatekeeperInput {
  registered_vk?: unknown;
  proof_vk?: unknown;
  minimum?: unknown;
  public_balance?: unknown;
  expiry_block?: unknown;
  current_block?: unknown;
  recipient?: unknown;
  condition_recipient?: unknown;
  amount?: unknown;
  max_transfer?: unknown;
  proof_tx?: unknown;
  /** Optional circuit salt passthrough (used by the prover, not the decision). */
  salt?: unknown;
}

export type ReasonCode =
  | "PROOF_REUSED"
  | "VK_SUBSTITUTION"
  | "THRESHOLD_MISMATCH"
  | "EXPIRED_CONDITION"
  | "RECIPIENT_MISMATCH"
  | "AMOUNT_OVERFLOW"
  | "VALID_CONDITION";

export interface Decision {
  decision: "APPROVE" | "REJECT";
  reason_code: ReasonCode;
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** Case-insensitive exact equality; false unless both are non-empty strings. */
function eqField(a: unknown, b: unknown): boolean {
  const sa = asString(a);
  const sb = asString(b);
  if (sa === null || sb === null) return false;
  return sa.toLowerCase() === sb.toLowerCase();
}

/** BigInt parse for decimal integer strings/numbers; null on anything else. */
function asBigInt(v: unknown): bigint | null {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") {
    return Number.isSafeInteger(v) ? BigInt(v) : null;
  }
  if (typeof v === "string") {
    const s = v.trim();
    if (!/^-?\d+$/.test(s)) return null;
    try {
      return BigInt(s);
    } catch {
      return null;
    }
  }
  return null;
}

export function decide(
  input: GatekeeperInput,
  hasSeenProofTx: (proofTx: string) => boolean,
): Decision {
  // 1. Proof reuse — the proof reference was already accepted/seen before.
  const proofTx = asString(input.proof_tx);
  if (proofTx !== null && hasSeenProofTx(proofTx)) {
    return { decision: "REJECT", reason_code: "PROOF_REUSED" };
  }

  // 2. Verification-key substitution — proof verifies under the wrong VK.
  if (!eqField(input.proof_vk, input.registered_vk)) {
    return { decision: "REJECT", reason_code: "VK_SUBSTITUTION" };
  }

  // 3. Threshold — public balance disclosed in the proof must meet minimum.
  const balance = asBigInt(input.public_balance);
  const minimum = asBigInt(input.minimum);
  if (balance === null || minimum === null || balance < minimum) {
    return { decision: "REJECT", reason_code: "THRESHOLD_MISMATCH" };
  }

  // 4. Expiry — condition's block-height expiry must not have passed.
  const currentBlock = asBigInt(input.current_block);
  const expiryBlock = asBigInt(input.expiry_block);
  if (currentBlock === null || expiryBlock === null || currentBlock > expiryBlock) {
    return { decision: "REJECT", reason_code: "EXPIRED_CONDITION" };
  }

  // 5. Recipient — proof recipient must match the payment condition.
  if (!eqField(input.recipient, input.condition_recipient)) {
    return { decision: "REJECT", reason_code: "RECIPIENT_MISMATCH" };
  }

  // 6. Amount — single-transfer cap.
  const amount = asBigInt(input.amount);
  const maxTransfer = asBigInt(input.max_transfer);
  if (amount === null || maxTransfer === null || amount > maxTransfer) {
    return { decision: "REJECT", reason_code: "AMOUNT_OVERFLOW" };
  }

  // 7. Everything checks out.
  return { decision: "APPROVE", reason_code: "VALID_CONDITION" };
}

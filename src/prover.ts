import { groth16 } from "snarkjs";
import type { Config } from "./config.js";
import type { GatekeeperInput, Decision } from "./decision.js";

/**
 * Groth16 proving for the gatekeeper circuit.
 *
 * Circuit inputs (13, all size 1 — names confirmed by probing the
 * official wasm):
 *   registeredVkHash, proofVkHash, minimum, publicBalance, expiryBlock,
 *   currentBlock, recipient, conditionRecipient, amount, maxTransfer,
 *   decision, taskId, salt
 *
 * Public signals (13) come back as:
 *   [computedOutputHash, registeredVkHash, proofVkHash, minimum,
 *    publicBalance, expiryBlock, currentBlock, recipient,
 *    conditionRecipient, amount, maxTransfer, decision, taskId]
 * i.e. `salt` is the single PRIVATE input and the first public signal is
 * a circuit-computed output hash.
 *
 * ============================================================================
 *  FIELD ENCODINGS — SINGLE FIX POINT
 * ============================================================================
 *  The helpers below (fieldFromHex / fieldFromAddress / decimalField /
 *  taskIdToField) are the ONLY places where envelope values are converted
 *  into circuit field elements. The exact encodings for hashes, addresses
 *  and task ids will be finalized once real practice payloads are seen —
 *  fix them here and nowhere else.
 * ============================================================================
 */

export interface ProvingTask {
  input: GatekeeperInput;
  taskId: string;
}

export interface GeneratedProof {
  proof: unknown;
  publicSignals: string[];
}

/** Hex ("0x…") or decimal value -> decimal field-element string. */
export function fieldFromHex(v: unknown): string {
  if (typeof v === "number" && Number.isSafeInteger(v)) return String(v);
  if (typeof v === "bigint") return v.toString(10);
  if (typeof v === "string") {
    const s = v.trim();
    if (/^0x[0-9a-fA-F]+$/.test(s)) return BigInt(s).toString(10);
    if (/^-?\d+$/.test(s)) return s;
  }
  // TODO(encoding): unrecognized shape — placeholder until real payloads
  // confirm the encoding. generateProof will fail on bad inputs and the
  // service falls back to proof=null rather than emitting a bad proof.
  return "0";
}

/** Ethereum-style address -> field element (addresses fit in the field). */
export function fieldFromAddress(v: unknown): string {
  // Same conversion as fieldFromHex today; kept as a separate helper so
  // the address encoding can diverge later without touching call sites.
  return fieldFromHex(v);
}

/** Decimal integer (string or number in the envelope) -> field string. */
export function decimalField(v: unknown): string {
  if (typeof v === "number" && Number.isSafeInteger(v)) return String(v);
  if (typeof v === "bigint") return v.toString(10);
  if (typeof v === "string") {
    const s = v.trim();
    if (/^-?\d+$/.test(s)) return s;
    if (/^0x[0-9a-fA-F]+$/.test(s)) return BigInt(s).toString(10);
  }
  return "0"; // TODO(encoding): see fieldFromHex note.
}

/**
 * task_id -> field element.
 * All-digit ids pass through unchanged. Anything else (e.g. "gk_24_9d1")
 * returns the placeholder "0" for now — TODO(encoding): the real taskId
 * encoding is finalized after the first real practice payloads.
 */
export function taskIdToField(taskId: string): string {
  if (/^\d+$/.test(taskId)) return taskId;
  return "0";
}

export function buildCircuitInputs(
  task: ProvingTask,
  decision: Decision,
): Record<string, unknown> {
  const input = task.input;
  return {
    registeredVkHash: fieldFromHex(input.registered_vk),
    proofVkHash: fieldFromHex(input.proof_vk),
    minimum: decimalField(input.minimum),
    publicBalance: decimalField(input.public_balance),
    expiryBlock: decimalField(input.expiry_block),
    currentBlock: decimalField(input.current_block),
    recipient: fieldFromAddress(input.recipient),
    conditionRecipient: fieldFromAddress(input.condition_recipient),
    amount: decimalField(input.amount),
    maxTransfer: decimalField(input.max_transfer),
    // APPROVE -> "1", REJECT -> "0" (assumption, to be validated in practice).
    decision: decision.decision === "APPROVE" ? "1" : "0",
    taskId: taskIdToField(task.taskId),
    // Envelope-provided salt wins; otherwise "0".
    salt:
      input.salt !== undefined && input.salt !== null
        ? decimalField(input.salt)
        : "0",
  };
}

/**
 * Generates the Groth16 proof for a decided task.
 * Returns null on ANY error (logged) — the service then responds with the
 * signed decision and proof=null, per spec.
 * Never called for PROOF_REUSED decisions (the server skips those).
 */
export async function generateProof(
  task: ProvingTask,
  decision: Decision,
  cfg: Config,
): Promise<GeneratedProof | null> {
  try {
    const inputs = buildCircuitInputs(task, decision);
    const { proof, publicSignals } = await groth16.fullProve(
      inputs,
      cfg.wasmPath,
      cfg.zkeyPath,
    );
    return { proof, publicSignals };
  } catch (err) {
    console.error(
      `[prover] proof generation failed for task ${task.taskId || "?"}:`,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

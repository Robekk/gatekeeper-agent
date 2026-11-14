/**
 * Local test harness — `npm run test:local`.
 *
 * Boots the REAL server (src/server.ts) on an ephemeral port with a test
 * HMAC secret and a throwaway store file, then replays:
 *   - GET /healthz
 *   - a valid preflight
 *   - one VALID_CONDITION task
 *   - one task per trap: VK_SUBSTITUTION, THRESHOLD_MISMATCH,
 *     EXPIRED_CONDITION, RECIPIENT_MISMATCH, AMOUNT_OVERFLOW
 *   - PROOF_REUSED (valid task's proof_tx again under a new task_id)
 *   - an idempotent replay (same task_id twice -> same response)
 *   - a bad-signature request (expect 401)
 *
 * Every request is HMAC-signed exactly like the platform would; every
 * response's x-agent-games-signature is verified. Decision, reason_code
 * and signature are asserted per case. Real Groth16 proving runs on the
 * non-reused tasks (~1–2s each), so the whole run takes a few seconds.
 */
import { createHmac } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildServer } from "../src/server.js";
import { GATEKEEPER_VK_HASH, type Config } from "../src/config.js";

const TEST_SECRET = "test-secret-for-local-harness-only";
const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    passed++;
    console.log(`PASS  ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed++;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function sign(raw: string): string {
  return createHmac("sha256", TEST_SECRET).update(raw, "utf8").digest("hex");
}

interface HttpResult {
  status: number;
  json: Record<string, unknown>;
  rawText: string;
  signature: string | null;
}

async function postSigned(
  base: string,
  payload: unknown,
  signatureOverride?: string,
): Promise<HttpResult> {
  const raw = JSON.stringify(payload);
  const res = await fetch(`${base}/agent`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-agent-games-signature": signatureOverride ?? sign(raw),
    },
    body: raw,
  });
  const rawText = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(rawText) as Record<string, unknown>;
  } catch {
    /* keep {} */
  }
  return {
    status: res.status,
    json,
    rawText,
    signature: res.headers.get("x-agent-games-signature"),
  };
}

function signatureVerifies(r: HttpResult): boolean {
  return r.signature !== null && r.signature === sign(r.rawText);
}

const BASE_INPUT = {
  registered_vk: "0x1a2b3c4d5e6f7788",
  proof_vk: "0x1a2b3c4d5e6f7788",
  minimum: "1000",
  public_balance: "1460",
  expiry_block: 8430000,
  current_block: 8420000,
  recipient: "0x1234567890abcdef1234567890abcdef12345678",
  condition_recipient: "0x1234567890abcdef1234567890abcdef12345678",
  amount: "500",
  max_transfer: "1000",
  proof_tx: "0xtx_valid_0001",
};

function taskEnvelope(taskId: string, input: Record<string, unknown>) {
  return {
    type: "agent-games.proof-gatekeeper.v1",
    task_id: taskId,
    mode: "practice",
    issued_at: new Date().toISOString(),
    deadline_at: new Date(Date.now() + 60_000).toISOString(),
    input,
  };
}

async function main(): Promise<void> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gk-harness-"));
  const cfg: Config = {
    port: 0,
    hmacSecret: TEST_SECRET,
    sigFormat: "hex",
    kurierApiKey: null,
    submitKurier: false,
    storePath: path.join(tmpDir, "store.json"),
    wasmPath: path.join(PROJECT_ROOT, "circuits/gatekeeper.wasm"),
    zkeyPath: path.join(PROJECT_ROOT, "circuits/gatekeeper_final.zkey"),
    vkHash: GATEKEEPER_VK_HASH,
  };

  const server = buildServer(cfg);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no server address");
  const base = `http://127.0.0.1:${addr.port}`;
  console.log(`[harness] server on ${base}, store=${cfg.storePath}\n`);

  try {
    // --- healthz -------------------------------------------------------
    {
      const res = await fetch(`${base}/healthz`);
      const json = (await res.json()) as { ok?: boolean };
      check("healthz", res.status === 200 && json.ok === true);
    }

    // --- preflight -----------------------------------------------------
    {
      const r = await postSigned(base, {
        type: "agent-games.preflight.v1",
        agent_id: "agent_test",
        issued_at: new Date().toISOString(),
        nonce: "nonce-1",
      });
      check(
        "preflight",
        r.status === 200 &&
          r.json.ok === true &&
          r.json.protocolVersion === "v1" &&
          signatureVerifies(r),
        `sig=${signatureVerifies(r)}`,
      );
    }

    // --- valid task ----------------------------------------------------
    const valid = await postSigned(
      base,
      taskEnvelope("gk_test_valid", { ...BASE_INPUT }),
    );
    check(
      "VALID_CONDITION",
      valid.status === 200 &&
        valid.json.decision === "APPROVE" &&
        valid.json.reason_code === "VALID_CONDITION" &&
        valid.json.proof_tx === BASE_INPUT.proof_tx &&
        signatureVerifies(valid),
      `proof attached: ${valid.json.proof !== null}, public_signals: ${
        Array.isArray(valid.json.public_signals)
          ? (valid.json.public_signals as unknown[]).length
          : "null"
      }`,
    );

    // --- traps ----------------------------------------------------------
    const traps: Array<{
      name: string;
      taskId: string;
      mutate: Record<string, unknown>;
    }> = [
      {
        name: "VK_SUBSTITUTION",
        taskId: "gk_test_vk",
        mutate: { proof_vk: "0x9999888877776666", proof_tx: "0xtx_vk_0002" },
      },
      {
        name: "THRESHOLD_MISMATCH",
        taskId: "gk_test_threshold",
        mutate: { public_balance: "999", proof_tx: "0xtx_thr_0003" },
      },
      {
        name: "EXPIRED_CONDITION",
        taskId: "gk_test_expired",
        mutate: { current_block: 8430001, proof_tx: "0xtx_exp_0004" },
      },
      {
        name: "RECIPIENT_MISMATCH",
        taskId: "gk_test_recipient",
        mutate: {
          condition_recipient: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
          proof_tx: "0xtx_rec_0005",
        },
      },
      {
        name: "AMOUNT_OVERFLOW",
        taskId: "gk_test_amount",
        mutate: { amount: "1001", proof_tx: "0xtx_amt_0006" },
      },
    ];
    for (const trap of traps) {
      const r = await postSigned(
        base,
        taskEnvelope(trap.taskId, { ...BASE_INPUT, ...trap.mutate }),
      );
      check(
        trap.name,
        r.status === 200 &&
          r.json.decision === "REJECT" &&
          r.json.reason_code === trap.name &&
          signatureVerifies(r),
      );
    }

    // --- proof reuse ----------------------------------------------------
    {
      const r = await postSigned(
        base,
        taskEnvelope("gk_test_reused", { ...BASE_INPUT }),
      );
      check(
        "PROOF_REUSED",
        r.status === 200 &&
          r.json.decision === "REJECT" &&
          r.json.reason_code === "PROOF_REUSED" &&
          r.json.proof === null &&
          r.json.public_signals === null &&
          signatureVerifies(r),
      );
    }

    // --- idempotent replay (same task_id as the valid task) -------------
    {
      const r = await postSigned(
        base,
        taskEnvelope("gk_test_valid", { ...BASE_INPUT }),
      );
      check(
        "IDEMPOTENT_REPLAY",
        r.status === 200 &&
          r.json.decision === valid.json.decision &&
          r.json.reason_code === valid.json.reason_code &&
          r.rawText === valid.rawText &&
          signatureVerifies(r),
      );
    }

    // --- bad signature ---------------------------------------------------
    {
      const r = await postSigned(
        base,
        taskEnvelope("gk_test_badsig", { ...BASE_INPUT, proof_tx: "0xtx_bad_0007" }),
        "deadbeef".repeat(8),
      );
      check("BAD_SIGNATURE_401", r.status === 401);
    }
  } finally {
    server.closeIdleConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log(`\n[harness] ${passed} passed, ${failed} failed`);
  // Explicit exit: snarkjs/ffjavascript worker threads stay alive after
  // fullProve and would otherwise keep this process hanging forever.
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err: unknown) => {
  console.error("[harness] fatal:", err);
  process.exit(1);
});

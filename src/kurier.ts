import type { Config } from "./config.js";
import type { GeneratedProof } from "./prover.js";

/**
 * Optional Kurier (zkVerify REST) proof submission.
 *
 * Called only when a proof was actually generated AND GK_SUBMIT_KURIER=1
 * AND KURIER_API_KEY is set. Failures are the caller's concern only as log
 * lines — submission must never block or fail the agent's response.
 *
 * NOTE: the API key is part of the request URL, so the URL is never logged.
 */
export async function submitProofKurier(
  generated: GeneratedProof,
  cfg: Config,
): Promise<void> {
  if (!cfg.kurierApiKey) {
    throw new Error("KURIER_API_KEY is not set");
  }
  const url = `https://api.kurier.xyz/api/v1/submit-proof/${cfg.kurierApiKey}`;
  const body = {
    proofType: "groth16",
    vkRegistered: true,
    proofOptions: {
      library: "snarkjs",
      curve: "bn128",
    },
    proofData: {
      proof: generated.proof,
      publicSignals: generated.publicSignals,
      vk: cfg.vkHash,
    },
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `Kurier submit-proof failed: HTTP ${res.status} ${text.slice(0, 200)}`,
      );
    }
  } finally {
    clearTimeout(timeout);
  }
}

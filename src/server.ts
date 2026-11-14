import http from "node:http";
import { pathToFileURL } from "node:url";
import { loadConfig, type Config } from "./config.js";
import { signBody, verifyBodySignature } from "./hmac.js";
import { Store, type TaskResponse } from "./store.js";
import { decide, type GatekeeperInput } from "./decision.js";
import { generateProof } from "./prover.js";
import { submitProofKurier } from "./kurier.js";

const MAX_BODY_BYTES = 1_048_576; // 1 MiB — task envelopes are small.

function readRawBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export function buildServer(cfg: Config): http.Server {
  const store = new Store(cfg.storePath);

  /** Serialize `body` and send it with the response signature header. */
  function sendSigned(
    res: http.ServerResponse,
    status: number,
    body: unknown,
  ): void {
    const raw = Buffer.from(JSON.stringify(body), "utf8");
    res.writeHead(status, {
      "content-type": "application/json",
      "x-agent-games-signature": signBody(raw, cfg.hmacSecret, cfg.sigFormat),
    });
    res.end(raw);
  }

  async function handleTask(envelope: Record<string, unknown>): Promise<TaskResponse> {
    const taskId = typeof envelope.task_id === "string" ? envelope.task_id : "";
    const input = (
      envelope.input && typeof envelope.input === "object" ? envelope.input : {}
    ) as GatekeeperInput;

    // Idempotency: a retried task_id returns the original response verbatim.
    if (taskId) {
      const cached = store.getCachedResponse(taskId);
      if (cached) return cached;
    }

    const decision = decide(input, (ptx) => store.hasSeenProofTx(ptx));

    const proofTxEcho =
      typeof input.proof_tx === "string" && input.proof_tx.length > 0
        ? input.proof_tx
        : null;

    // Proof generation — skipped entirely for PROOF_REUSED (those tasks
    // have no proof to submit). Any proving failure returns null from
    // generateProof and leaves proof null; it never blocks the decision.
    let proof: unknown | null = null;
    let publicSignals: string[] | null = null;
    if (decision.reason_code !== "PROOF_REUSED") {
      const generated = await generateProof({ input, taskId }, decision, cfg);
      if (generated !== null) {
        proof = generated.proof;
        publicSignals = generated.publicSignals;

        if (cfg.submitKurier && cfg.kurierApiKey) {
          // Fire-and-forget: Kurier submission must never block the response.
          void submitProofKurier(generated, cfg).catch((err: unknown) => {
            console.error(
              "[kurier] submission failed:",
              err instanceof Error ? err.message : String(err),
            );
          });
        }
      } else {
        console.warn(
          `[prover] no proof attached for task ${taskId || "?"} (decision still returned signed)`,
        );
      }
    }

    const response: TaskResponse = {
      decision: decision.decision,
      reason_code: decision.reason_code,
      proof_tx: proofTxEcho,
      proof,
      public_signals: publicSignals,
    };

    // Record proof_tx AFTER deciding — every processed task marks its
    // proof_tx as seen, regardless of outcome; recordProofTx dedupes.
    if (proofTxEcho !== null) {
      store.recordProofTx(proofTxEcho);
    }
    if (taskId) {
      store.cacheResponse(taskId, response);
    }
    return response;
  }

  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");

      if (req.method === "GET" && (url.pathname === "/healthz" || url.pathname === "/agent" || url.pathname === "/")) {
        const raw = Buffer.from(JSON.stringify({ ok: true }), "utf8");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(raw);
        return;
      }

      if (req.method !== "POST" || url.pathname !== "/agent") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }

      let rawBody: Buffer;
      try {
        rawBody = await readRawBody(req);
      } catch {
        res.writeHead(413, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "request body too large" }));
        return;
      }

      // Verify the inbound signature over the RAW body BEFORE parsing JSON.
      const signatureHeader = req.headers["x-agent-games-signature"];
      const provided = Array.isArray(signatureHeader)
        ? signatureHeader[0]
        : signatureHeader;
      if (!verifyBodySignature(rawBody, provided, cfg.hmacSecret, cfg.sigFormat)) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid signature" }));
        return;
      }

      let envelope: Record<string, unknown>;
      try {
        envelope = JSON.parse(rawBody.toString("utf8")) as Record<string, unknown>;
      } catch {
        sendSigned(res, 400, { error: "invalid json" });
        return;
      }

      try {
        switch (envelope.type) {
          case "agent-games.preflight.v1":
            sendSigned(res, 200, { ok: true, protocolVersion: "v1" });
            return;
          case "agent-games.proof-gatekeeper.v1": {
            const response = await handleTask(envelope);
            sendSigned(res, 200, response);
            return;
          }
          default:
            sendSigned(res, 400, { error: "unknown envelope type" });
            return;
        }
      } catch (err) {
        // Fail closed: never leave a signed task unanswered because of an
        // internal error if we can still emit a signed REJECT.
        console.error(
          "[server] handler error:",
          err instanceof Error ? err.message : String(err),
        );
        if (envelope.type === "agent-games.proof-gatekeeper.v1") {
          const input = (
            envelope.input && typeof envelope.input === "object"
              ? envelope.input
              : {}
          ) as GatekeeperInput;
          sendSigned(res, 200, {
            decision: "REJECT",
            reason_code: "VK_SUBSTITUTION",
            proof_tx:
              typeof input.proof_tx === "string" ? input.proof_tx : null,
            proof: null,
            public_signals: null,
          } satisfies TaskResponse);
          return;
        }
        sendSigned(res, 500, { error: "internal error" });
      }
    })();
  });

  return server;
}

export function main(): void {
  const cfg = loadConfig();
  const server = buildServer(cfg);
  server.listen(cfg.port, () => {
    console.log(`[gatekeeper-agent] listening on :${cfg.port} (POST /agent, GET /healthz)`);
  });
}

const isDirectRun =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main();
}

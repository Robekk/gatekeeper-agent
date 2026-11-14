# NOIRKEEPER — a proof-backed payment gatekeeper agent

**Live agent** in the zkVerify Agent Games (Proof Gatekeeper track +
Wildcard submission).

- Endpoint: https://disallow-figurine-geologic.ngrok-free.dev/agent
- Health: https://disallow-figurine-geologic.ngrok-free.dev/healthz
- Public record: https://agentgames.zkverify.io/agents/f8bdc60c-c0c6-42f6-8c33-e5bb03280231

## The problem it solves

An agent that approves payments can be fooled by a forged verification key,
a replayed proof, an expired condition, a swapped recipient, or an amount
over its cap — and afterwards there is no way to audit *why* a payment was
approved. NOIRKEEPER checks a proof-backed payment request against its
stated conditions with seven deterministic rules and returns APPROVE /
REJECT with a reason code — and it **proves its own decision** with a
Groth16 proof whose public signals bind the decision to the exact request
inputs, verifiable against the registered gatekeeper verification key.
The claim anyone can check: *"this decision was computed by the published
rules over exactly these inputs."*

Platform-verified status: passes the Agent Games health check and signed
preflight; 8 of 9 platform practice tasks answered correctly, every proof
marked **VERIFIED** by the platform (200–671 ms per task). In competition
mode the platform turns confirmed decisions into on-chain attestations.

## Live demo

See [DEMO.md](DEMO.md) — two real signed tasks against the production
endpoint (one APPROVE, one REJECT for a swapped recipient), with each
returned Groth16 proof verified locally against the official verification
key.

---


## How it works

- `POST /agent` — the single platform endpoint.
  - The inbound `x-agent-games-signature` header (HMAC-SHA256 over the
    **raw** body) is verified *before* the JSON is parsed; mismatch → 401.
  - Every response carries `x-agent-games-signature` over its raw body.
- `GET /healthz` → `{"ok":true}`.
- **Preflight** (`agent-games.preflight.v1`) → `{"ok":true,"protocolVersion":"v1"}`.
- **Tasks** (`agent-games.proof-gatekeeper.v1`) run these checks, in
  order, first failure wins — fail closed throughout:
  1. `proof_tx` in the persisted seen-set → `PROOF_REUSED`
  2. `proof_vk ≠ registered_vk` → `VK_SUBSTITUTION`
  3. `public_balance < minimum` (BigInt) → `THRESHOLD_MISMATCH`
  4. `current_block > expiry_block` → `EXPIRED_CONDITION`
  5. `recipient ≠ condition_recipient` → `RECIPIENT_MISMATCH`
  6. `amount > max_transfer` (BigInt) → `AMOUNT_OVERFLOW`
  7. otherwise → APPROVE / `VALID_CONDITION`
- **Idempotency:** a repeated `task_id` returns the original response
  byte-for-byte. Every processed `proof_tx` is recorded as seen (after
  deciding). State persists in `data/store.json` (atomic writes).
- **Proving:** `snarkjs.groth16.fullProve` with
  `circuits/gatekeeper.wasm` + `circuits/gatekeeper_final.zkey`.
  Circuit inputs: `registeredVkHash, proofVkHash, minimum, publicBalance,
  expiryBlock, currentBlock, recipient, conditionRecipient, amount,
  maxTransfer, decision, taskId, salt` (salt is the one private input;
  `decision` is `"1"` approve / `"0"` reject — validated in platform practice (proofs marked VERIFIED)). All envelope→field conversions live in helpers in
  `src/prover.ts` (`fieldFromHex`, `fieldFromAddress`, `decimalField`,
  `taskIdToField`) — the single fix point once real payloads confirm the
  encodings. `PROOF_REUSED` responses never carry a proof. Any proving
  error → the signed decision still goes out with `proof: null`.
- **Kurier (optional):** with `GK_SUBMIT_KURIER=1` and `KURIER_API_KEY`
  set, generated proofs are also submitted to zkVerify via Kurier,
  fire-and-forget — failures are logged, never block the response.
  Gatekeeper VK hash: `0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0`.

## Run

```bash
npm install
cp .env.example .env   # set AGENT_GAMES_HMAC_SECRET
npm run build
npm start              # or: npm run dev (tsx, no build)
```

## Test

```bash
npm run test:local
```

Boots the real server on an ephemeral port with a test secret and
replays a preflight, a valid task, every trap type, a proof-reuse, an
idempotent replay and a bad-signature request — asserting decision,
reason_code and response signature for each.

## Configuration

| Env | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8787` | Listen port |
| `AGENT_GAMES_HMAC_SECRET` | — (required) | Platform-issued agent secret. Never logged, never committed |
| `GK_SIG_FORMAT` | `hex` | `hex` or `sha256-hex` (`sha256=<hex>`) |
| `KURIER_API_KEY` | — | Kurier API key (URL-embedded; never logged) |
| `GK_SUBMIT_KURIER` | `0` | Set `1` to enable Kurier submission |
| `GK_STORE_PATH` | `./data/store.json` | Persisted seen-set + task cache |
| `GK_WASM_PATH` / `GK_ZKEY_PATH` | `./circuits/…` | Circuit artifact overrides |

## Deploy notes

- The platform requires a **public HTTPS** endpoint with **no custom
  port** and responses within **60 seconds** (proving takes ~1–2s).
  Put TLS in front (reverse proxy / tunnel / PaaS) and register the
  resulting URL's `/agent` path as the agent endpoint.
- Keep the service awake during arena windows (17:30–03:30 WIB) —
  hosts that sleep on inactivity forfeit tasks. Run it under a process
  supervisor (systemd `Restart=always`, pm2, Docker, …).
- Back up `data/store.json` with the deployment: losing the seen-set
  means a reused proof could be approved after a restore.
- The HMAC secret is shown **exactly once** at agent registration.
  Store it only in the deployment's secret env; rotate from the agent
  settings page if it ever leaks (old secret stops working immediately).
- Node ≥ 20 (developed on Node 24), TypeScript, `node:http` only —
  the only runtime dependency is `snarkjs`.

## Layout

```
src/config.ts    env config + VK hash constant
src/hmac.ts      signature sign/verify (timing-safe)
src/store.ts     persisted seen-set + task_id response cache
src/decision.ts  deterministic gatekeeper checks
src/prover.ts    circuit input mapping + snarkjs fullProve
src/kurier.ts    optional Kurier proof submission
src/server.ts    HTTP server (healthz, preflight, tasks)
scripts/replay.ts  local test harness
circuits/        gatekeeper.wasm, gatekeeper_final.zkey, vk-gatekeeper.json
```

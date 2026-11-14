import path from "node:path";
import { fileURLToPath } from "node:url";

export type SigFormat = "hex" | "sha256-hex";

export interface Config {
  port: number;
  hmacSecret: string;
  sigFormat: SigFormat;
  kurierApiKey: string | null;
  submitKurier: boolean;
  storePath: string;
  wasmPath: string;
  zkeyPath: string;
  /** Gatekeeper circuit verification-key hash registered on zkVerify mainnet. */
  vkHash: string;
}

export const GATEKEEPER_VK_HASH =
  "0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0";

/**
 * Project root: parent of src/ when running via tsx (src/config.ts),
 * package dir when running the build (dist/src/config.js -> two levels up).
 */
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT =
  path.basename(MODULE_DIR) === "src" &&
  path.basename(path.resolve(MODULE_DIR, "..")) === "dist"
    ? path.resolve(MODULE_DIR, "..", "..")
    : path.resolve(MODULE_DIR, "..");

function parseSigFormat(raw: string | undefined): SigFormat {
  if (raw === undefined || raw === "" || raw === "hex") return "hex";
  if (raw === "sha256-hex") return "sha256-hex";
  throw new Error(
    `Invalid GK_SIG_FORMAT "${raw}" — expected "hex" or "sha256-hex".`,
  );
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const secret = env.AGENT_GAMES_HMAC_SECRET ?? "";
  if (!secret) {
    throw new Error(
      "AGENT_GAMES_HMAC_SECRET is required. Copy .env.example to .env and set it " +
        "to the secret shown once when the agent was registered on the platform.",
    );
  }
  const resolveFromRoot = (p: string | undefined, fallback: string) =>
    path.isAbsolute(p ?? fallback)
      ? (p ?? fallback)
      : path.resolve(PROJECT_ROOT, p ?? fallback);

  return {
    port: Number(env.PORT ?? "8787"),
    hmacSecret: secret,
    sigFormat: parseSigFormat(env.GK_SIG_FORMAT),
    kurierApiKey: env.KURIER_API_KEY ? env.KURIER_API_KEY : null,
    submitKurier: env.GK_SUBMIT_KURIER === "1",
    storePath: resolveFromRoot(env.GK_STORE_PATH, "data/store.json"),
    wasmPath: resolveFromRoot(env.GK_WASM_PATH, "circuits/gatekeeper.wasm"),
    zkeyPath: resolveFromRoot(env.GK_ZKEY_PATH, "circuits/gatekeeper_final.zkey"),
    vkHash: GATEKEEPER_VK_HASH,
  };
}

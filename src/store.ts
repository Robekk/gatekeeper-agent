import fs from "node:fs";
import path from "node:path";

/**
 * Persisted agent state:
 *  - seenProofTx: every proof_tx we have ever processed ("seen before" set).
 *    Keys are stored lowercased; proof_tx comparisons are case-insensitive.
 *  - taskCache: task_id -> the exact response body object we returned,
 *    for idempotent replays (platform may retry after network failures).
 *
 * Stored as one JSON file, written atomically (tmp file + rename) after
 * every mutation so state survives restarts and crashes.
 */
export interface TaskResponse {
  decision: "APPROVE" | "REJECT";
  reason_code: string;
  proof_tx: string | null;
  proof: unknown | null;
  public_signals: string[] | null;
}

interface StoreData {
  seenProofTx: string[];
  taskCache: Record<string, TaskResponse>;
}

export class Store {
  private data: StoreData;
  private readonly seen: Set<string>;

  constructor(private readonly filePath: string) {
    this.data = { seenProofTx: [], taskCache: {} };
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<StoreData>;
      if (Array.isArray(parsed.seenProofTx)) {
        this.data.seenProofTx = parsed.seenProofTx.filter(
          (x): x is string => typeof x === "string",
        );
      }
      if (parsed.taskCache && typeof parsed.taskCache === "object") {
        this.data.taskCache = parsed.taskCache as Record<string, TaskResponse>;
      }
    } catch {
      // Missing or unreadable store file -> start fresh.
    }
    this.seen = new Set(this.data.seenProofTx.map((x) => x.toLowerCase()));
  }

  hasSeenProofTx(proofTx: string): boolean {
    return this.seen.has(proofTx.toLowerCase());
  }

  /** Records a proof_tx as seen. No-op if already present (no duplicates). */
  recordProofTx(proofTx: string): void {
    const key = proofTx.toLowerCase();
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.data.seenProofTx.push(key);
    this.persist();
  }

  getCachedResponse(taskId: string): TaskResponse | undefined {
    return this.data.taskCache[taskId];
  }

  cacheResponse(taskId: string, response: TaskResponse): void {
    this.data.taskCache[taskId] = response;
    this.persist();
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), "utf8");
    fs.renameSync(tmp, this.filePath);
  }
}

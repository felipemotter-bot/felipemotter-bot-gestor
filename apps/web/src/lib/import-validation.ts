/**
 * Strict payload validation for POST /api/imports/confirm.
 * Pure functions — no I/O, fully unit-testable.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Hard cap on transactions per import request */
export const MAX_TRANSACTIONS = 5000;

/** Max length for free-text string fields inside a transaction */
export const MAX_STRING_LEN = 1000;

/** Max length for source / rawHash top-level fields */
export const MAX_SHORT_STRING_LEN = 256;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ValidatedTransaction = {
  fitId: string;
  type: string;
  postedAt: string;
  amount: number;
  memo: string;
  hash: string;
  category_id?: string | null;
  override_description?: string;
};

export type ValidatedImportRequest = {
  accountId: string;
  familyId: string;
  transactions: ValidatedTransaction[];
  source: string;
  rawHash: string;
  startDate: string | null;
  endDate: string | null;
  ledgerBalance: number | null;
};

type ValidationOk = { valid: true; data: ValidatedImportRequest };
type ValidationErr = { valid: false; error: string };
export type ValidationResult = ValidationOk | ValidationErr;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function isValidUUID(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

export function isValidDateString(value: unknown): value is string {
  return typeof value === "string" && DATE_RE.test(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isOptionalString(value: unknown, maxLen: number): boolean {
  return value == null || (typeof value === "string" && value.length <= maxLen);
}

// ---------------------------------------------------------------------------
// Transaction validation
// ---------------------------------------------------------------------------

function validateTransaction(
  tx: unknown,
  index: number,
): string | null {
  if (tx == null || typeof tx !== "object") {
    return `transactions[${index}]: não é um objeto`;
  }

  const t = tx as Record<string, unknown>;

  if (typeof t.fitId !== "string" || t.fitId.length === 0 || t.fitId.length > MAX_STRING_LEN) {
    return `transactions[${index}].fitId: inválido`;
  }

  if (typeof t.postedAt !== "string" || !DATE_RE.test(t.postedAt)) {
    return `transactions[${index}].postedAt: data inválida`;
  }

  if (!isFiniteNumber(t.amount)) {
    return `transactions[${index}].amount: número inválido`;
  }

  if (typeof t.memo !== "string" || t.memo.length > MAX_STRING_LEN) {
    return `transactions[${index}].memo: inválido`;
  }

  if (typeof t.hash !== "string" || t.hash.length === 0 || t.hash.length > MAX_STRING_LEN) {
    return `transactions[${index}].hash: inválido`;
  }

  // Optional type — default is fine
  if (t.type != null && typeof t.type !== "string") {
    return `transactions[${index}].type: deve ser string`;
  }

  // Optional category_id — must be valid UUID if present
  if (t.category_id != null && !isValidUUID(t.category_id)) {
    return `transactions[${index}].category_id: UUID inválido`;
  }

  // Optional override_description
  if (!isOptionalString(t.override_description, MAX_STRING_LEN)) {
    return `transactions[${index}].override_description: inválido`;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Main validation
// ---------------------------------------------------------------------------

export function validateImportPayload(body: unknown): ValidationResult {
  if (body == null || typeof body !== "object") {
    return { valid: false, error: "Payload inválido" };
  }

  const b = body as Record<string, unknown>;

  // Required UUIDs
  if (!isValidUUID(b.accountId)) {
    return { valid: false, error: "accountId: UUID inválido" };
  }
  if (!isValidUUID(b.familyId)) {
    return { valid: false, error: "familyId: UUID inválido" };
  }

  // Required strings
  if (typeof b.source !== "string" || b.source.length === 0 || b.source.length > MAX_SHORT_STRING_LEN) {
    return { valid: false, error: "source: string inválida" };
  }
  if (typeof b.rawHash !== "string" || b.rawHash.length === 0 || b.rawHash.length > MAX_SHORT_STRING_LEN) {
    return { valid: false, error: "rawHash: string inválida" };
  }

  // Transactions array
  if (!Array.isArray(b.transactions) || b.transactions.length === 0) {
    return { valid: false, error: "transactions: array vazio ou ausente" };
  }
  if (b.transactions.length > MAX_TRANSACTIONS) {
    return { valid: false, error: `transactions: máximo de ${MAX_TRANSACTIONS} transações por importação` };
  }

  for (let i = 0; i < b.transactions.length; i++) {
    const err = validateTransaction(b.transactions[i], i);
    if (err) {
      return { valid: false, error: err };
    }
  }

  // Optional date strings
  const startDate = b.startDate ?? null;
  if (startDate != null && !isValidDateString(startDate)) {
    return { valid: false, error: "startDate: data inválida (YYYY-MM-DD)" };
  }

  const endDate = b.endDate ?? null;
  if (endDate != null && !isValidDateString(endDate)) {
    return { valid: false, error: "endDate: data inválida (YYYY-MM-DD)" };
  }

  // Optional ledger balance
  const ledgerBalance = b.ledgerBalance ?? null;
  if (ledgerBalance != null && !isFiniteNumber(ledgerBalance)) {
    return { valid: false, error: "ledgerBalance: número inválido" };
  }

  return {
    valid: true,
    data: {
      accountId: b.accountId as string,
      familyId: b.familyId as string,
      transactions: b.transactions as ValidatedTransaction[],
      source: b.source as string,
      rawHash: b.rawHash as string,
      startDate: startDate as string | null,
      endDate: endDate as string | null,
      ledgerBalance: ledgerBalance as number | null,
    },
  };
}

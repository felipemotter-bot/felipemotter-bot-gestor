import { describe, it, expect } from "vitest";
import {
  validateImportPayload,
  isValidUUID,
  isValidDateString,
  MAX_TRANSACTIONS,
  MAX_STRING_LEN,
  MAX_SHORT_STRING_LEN,
} from "../import-validation";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validTx(overrides?: Record<string, unknown>) {
  return {
    fitId: "FITID001",
    type: "DEBIT",
    postedAt: "2025-06-15",
    amount: -123.45,
    memo: "COMPRA FARMACIA",
    hash: "abc12345",
    ...overrides,
  };
}

function validPayload(overrides?: Record<string, unknown>) {
  return {
    accountId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    familyId: "f1b2c3d4-e5f6-7890-abcd-ef1234567890",
    transactions: [validTx()],
    source: "ofx",
    rawHash: "deadbeef1234",
    startDate: "2025-06-01",
    endDate: "2025-06-30",
    ledgerBalance: 1234.56,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// isValidUUID
// ---------------------------------------------------------------------------

describe("isValidUUID", () => {
  it("accepts valid v4 UUID", () => {
    expect(isValidUUID("a1b2c3d4-e5f6-7890-abcd-ef1234567890")).toBe(true);
  });

  it("accepts uppercase UUID", () => {
    expect(isValidUUID("A1B2C3D4-E5F6-7890-ABCD-EF1234567890")).toBe(true);
  });

  it("rejects empty string", () => {
    expect(isValidUUID("")).toBe(false);
  });

  it("rejects non-string", () => {
    expect(isValidUUID(123)).toBe(false);
    expect(isValidUUID(null)).toBe(false);
    expect(isValidUUID(undefined)).toBe(false);
  });

  it("rejects malformed UUID", () => {
    expect(isValidUUID("not-a-uuid")).toBe(false);
    expect(isValidUUID("a1b2c3d4e5f67890abcdef1234567890")).toBe(false); // no dashes
  });
});

// ---------------------------------------------------------------------------
// isValidDateString
// ---------------------------------------------------------------------------

describe("isValidDateString", () => {
  it("accepts YYYY-MM-DD", () => {
    expect(isValidDateString("2025-06-15")).toBe(true);
  });

  it("rejects other formats", () => {
    expect(isValidDateString("15/06/2025")).toBe(false);
    expect(isValidDateString("2025-6-15")).toBe(false);
    expect(isValidDateString("20250615")).toBe(false);
  });

  it("rejects non-string", () => {
    expect(isValidDateString(20250615)).toBe(false);
    expect(isValidDateString(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateImportPayload — happy path
// ---------------------------------------------------------------------------

describe("validateImportPayload", () => {
  it("accepts a fully valid payload", () => {
    const result = validateImportPayload(validPayload());
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.data.accountId).toBe("a1b2c3d4-e5f6-7890-abcd-ef1234567890");
      expect(result.data.transactions).toHaveLength(1);
    }
  });

  it("accepts payload with optional fields omitted", () => {
    const result = validateImportPayload(
      validPayload({ startDate: null, endDate: null, ledgerBalance: null }),
    );
    expect(result.valid).toBe(true);
  });

  it("accepts payload with optional fields undefined", () => {
    const p = validPayload();
    delete (p as Record<string, unknown>).startDate;
    delete (p as Record<string, unknown>).endDate;
    delete (p as Record<string, unknown>).ledgerBalance;
    const result = validateImportPayload(p);
    expect(result.valid).toBe(true);
  });

  // ── Top-level field validation ──────────────────────────────────────

  it("rejects null body", () => {
    const result = validateImportPayload(null);
    expect(result.valid).toBe(false);
  });

  it("rejects non-object body", () => {
    const result = validateImportPayload("string");
    expect(result.valid).toBe(false);
  });

  it("rejects invalid accountId", () => {
    const result = validateImportPayload(validPayload({ accountId: "bad" }));
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain("accountId");
  });

  it("rejects invalid familyId", () => {
    const result = validateImportPayload(validPayload({ familyId: 42 }));
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain("familyId");
  });

  it("rejects empty source", () => {
    const result = validateImportPayload(validPayload({ source: "" }));
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain("source");
  });

  it("rejects source exceeding max length", () => {
    const result = validateImportPayload(
      validPayload({ source: "x".repeat(MAX_SHORT_STRING_LEN + 1) }),
    );
    expect(result.valid).toBe(false);
  });

  it("rejects empty rawHash", () => {
    const result = validateImportPayload(validPayload({ rawHash: "" }));
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain("rawHash");
  });

  it("rejects empty transactions array", () => {
    const result = validateImportPayload(validPayload({ transactions: [] }));
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain("transactions");
  });

  it("rejects transactions exceeding MAX_TRANSACTIONS", () => {
    const bigArray = Array.from({ length: MAX_TRANSACTIONS + 1 }, (_, i) =>
      validTx({ fitId: `FIT${i}` }),
    );
    const result = validateImportPayload(validPayload({ transactions: bigArray }));
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain("máximo");
  });

  it("rejects invalid startDate format", () => {
    const result = validateImportPayload(validPayload({ startDate: "20250601" }));
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain("startDate");
  });

  it("rejects non-finite ledgerBalance", () => {
    const result = validateImportPayload(validPayload({ ledgerBalance: NaN }));
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain("ledgerBalance");
  });

  it("rejects Infinity ledgerBalance", () => {
    const result = validateImportPayload(validPayload({ ledgerBalance: Infinity }));
    expect(result.valid).toBe(false);
  });

  // ── Transaction field validation ────────────────────────────────────

  it("rejects transaction with missing fitId", () => {
    const result = validateImportPayload(
      validPayload({ transactions: [validTx({ fitId: "" })] }),
    );
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain("fitId");
  });

  it("rejects transaction with invalid postedAt", () => {
    const result = validateImportPayload(
      validPayload({ transactions: [validTx({ postedAt: "bad-date" })] }),
    );
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain("postedAt");
  });

  it("rejects transaction with NaN amount", () => {
    const result = validateImportPayload(
      validPayload({ transactions: [validTx({ amount: NaN })] }),
    );
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain("amount");
  });

  it("rejects transaction with non-number amount", () => {
    const result = validateImportPayload(
      validPayload({ transactions: [validTx({ amount: "123" })] }),
    );
    expect(result.valid).toBe(false);
  });

  it("rejects transaction with invalid category_id", () => {
    const result = validateImportPayload(
      validPayload({
        transactions: [validTx({ category_id: "not-a-uuid" })],
      }),
    );
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain("category_id");
  });

  it("accepts transaction with null category_id", () => {
    const result = validateImportPayload(
      validPayload({
        transactions: [validTx({ category_id: null })],
      }),
    );
    expect(result.valid).toBe(true);
  });

  it("accepts transaction with valid category_id UUID", () => {
    const result = validateImportPayload(
      validPayload({
        transactions: [
          validTx({ category_id: "c1b2c3d4-e5f6-7890-abcd-ef1234567890" }),
        ],
      }),
    );
    expect(result.valid).toBe(true);
  });

  it("rejects transaction with memo exceeding max length", () => {
    const result = validateImportPayload(
      validPayload({
        transactions: [validTx({ memo: "x".repeat(MAX_STRING_LEN + 1) })],
      }),
    );
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain("memo");
  });

  it("rejects transaction with empty hash", () => {
    const result = validateImportPayload(
      validPayload({ transactions: [validTx({ hash: "" })] }),
    );
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain("hash");
  });

  it("rejects non-object transaction", () => {
    const result = validateImportPayload(
      validPayload({ transactions: ["not-an-object"] }),
    );
    expect(result.valid).toBe(false);
  });

  it("rejects override_description exceeding max length", () => {
    const result = validateImportPayload(
      validPayload({
        transactions: [
          validTx({ override_description: "x".repeat(MAX_STRING_LEN + 1) }),
        ],
      }),
    );
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain("override_description");
  });

  // ── Multiple transactions ───────────────────────────────────────────

  it("validates all transactions (fails on second)", () => {
    const result = validateImportPayload(
      validPayload({
        transactions: [validTx(), validTx({ amount: "bad" })],
      }),
    );
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain("transactions[1]");
  });
});

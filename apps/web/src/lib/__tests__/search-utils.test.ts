import { describe, it, expect } from "vitest";
import { escapeIlikePattern, buildTransactionSearchFilter } from "@/lib/search-utils";

describe("escapeIlikePattern", () => {
  it("returns plain text unchanged", () => {
    expect(escapeIlikePattern("mercado")).toBe("mercado");
  });

  it("escapes % wildcard", () => {
    expect(escapeIlikePattern("100%")).toBe("100\\%");
  });

  it("escapes _ wildcard", () => {
    expect(escapeIlikePattern("pix_recebido")).toBe("pix\\_recebido");
  });

  it("escapes backslash", () => {
    expect(escapeIlikePattern("foo\\bar")).toBe("foo\\\\bar");
  });

  it("escapes multiple special characters", () => {
    expect(escapeIlikePattern("10% _off\\")).toBe("10\\% \\_off\\\\");
  });

  it("handles empty string", () => {
    expect(escapeIlikePattern("")).toBe("");
  });
});

describe("buildTransactionSearchFilter", () => {
  it("returns null for empty string", () => {
    expect(buildTransactionSearchFilter("")).toBeNull();
  });

  it("returns null for whitespace-only string", () => {
    expect(buildTransactionSearchFilter("   ")).toBeNull();
  });

  it("builds ilike filter for simple term", () => {
    const filter = buildTransactionSearchFilter("mercado");
    expect(filter).toBe(
      "description.ilike.%mercado%,original_description.ilike.%mercado%",
    );
  });

  it("lowercases the search term", () => {
    const filter = buildTransactionSearchFilter("PIX Recebido");
    expect(filter).toBe(
      "description.ilike.%pix recebido%,original_description.ilike.%pix recebido%",
    );
  });

  it("trims whitespace", () => {
    const filter = buildTransactionSearchFilter("  uber  ");
    expect(filter).toBe(
      "description.ilike.%uber%,original_description.ilike.%uber%",
    );
  });

  it("escapes % in search term", () => {
    const filter = buildTransactionSearchFilter("100%");
    expect(filter).toBe(
      "description.ilike.%100\\%%,original_description.ilike.%100\\%%",
    );
  });

  it("escapes _ in search term", () => {
    const filter = buildTransactionSearchFilter("pix_rec");
    expect(filter).toBe(
      "description.ilike.%pix\\_rec%,original_description.ilike.%pix\\_rec%",
    );
  });

  it("escapes backslash in search term", () => {
    const filter = buildTransactionSearchFilter("foo\\bar");
    expect(filter).toBe(
      "description.ilike.%foo\\\\bar%,original_description.ilike.%foo\\\\bar%",
    );
  });
});

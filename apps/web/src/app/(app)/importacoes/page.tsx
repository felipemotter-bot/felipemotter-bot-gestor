"use client";

import { useCallback, useEffect, useState } from "react";
import { Header } from "@/components/layout/Header";
import { useApp, type Category } from "@/contexts/AppContext";
import type { ParsedOFX, ParsedTransaction } from "@/lib/ofx-parser";
import { applyRulesToBatch, type RuleMatchResult } from "@/lib/rule-matcher";
import { getSupabaseClient } from "@/lib/supabase/client";
import { primaryButton, secondaryButton } from "@/constants/styles";
import type { Rule } from "@/types";

const supabase = getSupabaseClient();

const currencyFormatter = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
});

const dateFormatter = new Intl.DateTimeFormat("pt-BR", {
  day: "2-digit",
  month: "short",
  year: "numeric",
});

function formatDate(dateStr: string) {
  const date = new Date(dateStr + "T12:00:00");
  return dateFormatter.format(date);
}

type ImportStep = "upload" | "preview" | "importing" | "done";

export default function ImportacoesPage() {
  const { session, activeFamilyId, accounts, categories, triggerRefresh } = useApp();

  // Step state
  const [step, setStep] = useState<ImportStep>("upload");

  // Upload state
  const [isDragging, setIsDragging] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Parsed data
  const [parsedData, setParsedData] = useState<ParsedOFX | null>(null);
  const [selectedAccountId, setSelectedAccountId] = useState("");

  // Rules and auto-categorization
  const [rules, setRules] = useState<Rule[]>([]);
  const [ruleMatches, setRuleMatches] = useState<Map<number, RuleMatchResult>>(new Map());
  const [categoryOverrides, setCategoryOverrides] = useState<Map<number, string | null>>(new Map());

  // Import result
  const [importResult, setImportResult] = useState<{
    imported: number;
    duplicates: number;
    autoCategorized: number;
  } | null>(null);

  // Category lookup
  const categoriesById = categories.reduce<Record<string, Category>>((acc, cat) => {
    acc[cat.id] = cat;
    return acc;
  }, {});

  const getCategoryLabel = (id: string) => {
    const cat = categoriesById[id];
    if (!cat) return "?";
    if (cat.parent_id) {
      const parent = categoriesById[cat.parent_id];
      return parent ? `${parent.name} / ${cat.name}` : cat.name;
    }
    return cat.name;
  };

  // Load rules on mount
  useEffect(() => {
    if (!activeFamilyId || !session?.access_token) return;
    supabase
      .from("rules")
      .select("*")
      .eq("family_id", activeFamilyId)
      .eq("is_active", true)
      .order("priority", { ascending: true })
      .order("created_at", { ascending: true })
      .then(({ data }) => {
        setRules(data ?? []);
      });
  }, [activeFamilyId, session?.access_token]);

  // Auto-match account by OFX bank/account IDs
  useEffect(() => {
    if (!parsedData) return;
    const autoAccount = accounts.find(
      (a) =>
        a.is_reconcilable &&
        a.ofx_bank_id != null &&
        a.ofx_account_id != null &&
        a.ofx_bank_id === parsedData.bankId &&
        a.ofx_account_id === parsedData.accountId,
    );
    if (autoAccount) {
      setSelectedAccountId(autoAccount.id);
    }
  }, [parsedData, accounts]);

  // Apply rules when parsedData or rules change
  useEffect(() => {
    if (!parsedData || rules.length === 0) {
      setRuleMatches(new Map());
      return;
    }
    const txs = parsedData.transactions.map((tx) => ({
      memo: tx.memo,
      amount: tx.amount,
      postedAt: tx.postedAt,
    }));
    const matches = applyRulesToBatch(rules, txs);
    setRuleMatches(matches);
  }, [parsedData, rules]);

  // Generate hash for the entire file (for idempotency)
  const generateFileHash = (transactions: ParsedTransaction[]) => {
    const data = transactions.map((t) => t.hash).join("|");
    let hash = 0;
    for (let i = 0; i < data.length; i++) {
      const char = data.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return Math.abs(hash).toString(16).padStart(8, "0");
  };

  // Handle file upload
  const handleFile = useCallback(async (file: File) => {
    if (!file.name.toLowerCase().endsWith(".ofx")) {
      setError("Formato inválido. Envie um arquivo .ofx");
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const formData = new FormData();
      formData.append("file", file);

      const response = await fetch("/api/imports/parse", {
        method: "POST",
        body: formData,
      });

      const result = await response.json();

      if (!response.ok) {
        setError(result.error || "Erro ao processar arquivo");
        setIsLoading(false);
        return;
      }

      setParsedData(result.data);
      setCategoryOverrides(new Map());
      setStep("preview");
    } catch {
      setError("Erro ao enviar arquivo");
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Drag and drop handlers
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      const file = e.dataTransfer.files[0];
      if (file) {
        handleFile(file);
      }
    },
    [handleFile]
  );

  const handleFileInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) {
        handleFile(file);
      }
    },
    [handleFile]
  );

  // Get effective category for a transaction
  const getEffectiveCategory = (index: number): { id: string | null; isAuto: boolean } => {
    if (categoryOverrides.has(index)) {
      return { id: categoryOverrides.get(index) ?? null, isAuto: false };
    }
    const match = ruleMatches.get(index);
    if (match) {
      return { id: match.categoryId, isAuto: true };
    }
    return { id: null, isAuto: false };
  };

  // Handle category override
  const handleCategoryOverride = (index: number, categoryId: string) => {
    setCategoryOverrides((prev) => {
      const next = new Map(prev);
      if (categoryId === "") {
        next.delete(index);
      } else if (categoryId === "__none__") {
        next.set(index, null);
      } else {
        next.set(index, categoryId);
      }
      return next;
    });
  };

  // Confirm import
  const handleConfirmImport = async () => {
    if (!parsedData || !selectedAccountId || !activeFamilyId || !session?.access_token) {
      setError("Selecione uma conta para importar");
      return;
    }

    setStep("importing");
    setError(null);

    try {
      // Build per-transaction data
      const transactionsWithCategories = parsedData.transactions.map((tx, index) => {
        const effective = getEffectiveCategory(index);
        const match = ruleMatches.get(index);
        const overrideDesc = effective.isAuto && match?.setDescription ? match.setDescription : undefined;

        return {
          ...tx,
          category_id: effective.id,
          override_description: overrideDesc,
        };
      });

      const response = await fetch("/api/imports/confirm", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          accountId: selectedAccountId,
          familyId: activeFamilyId,
          transactions: transactionsWithCategories,
          source: `ofx:${parsedData.bankName || "unknown"}`,
          rawHash: generateFileHash(parsedData.transactions),
          startDate: parsedData.startDate || null,
          endDate: parsedData.endDate || null,
          ledgerBalance: parsedData.ledgerBalance,
        }),
      });

      const result = await response.json();

      if (!response.ok) {
        setError(result.error || "Erro ao importar transações");
        setStep("preview");
        return;
      }

      setImportResult({
        imported: result.imported,
        duplicates: result.duplicates,
        autoCategorized: result.autoCategorized ?? 0,
      });
      setStep("done");
      triggerRefresh();
    } catch {
      setError("Erro ao confirmar importação");
      setStep("preview");
    }
  };

  // Reset to upload new file
  const handleReset = () => {
    setStep("upload");
    setParsedData(null);
    setSelectedAccountId("");
    setError(null);
    setImportResult(null);
    setCategoryOverrides(new Map());
    setRuleMatches(new Map());
  };

  // Calculate totals
  const totals = parsedData?.transactions.reduce(
    (acc, tx) => {
      if (tx.amount < 0) {
        acc.debits += Math.abs(tx.amount);
        acc.debitCount++;
      } else {
        acc.credits += tx.amount;
        acc.creditCount++;
      }
      return acc;
    },
    { debits: 0, credits: 0, debitCount: 0, creditCount: 0 }
  ) ?? { debits: 0, credits: 0, debitCount: 0, creditCount: 0 };

  // Auto-categorized count
  const autoCategorizedCount = parsedData
    ? parsedData.transactions.filter((_, i) => {
        const eff = getEffectiveCategory(i);
        return eff.id != null;
      }).length
    : 0;

  // Category select options
  const expenseCategories = categories.filter((c) => c.category_type === "expense");
  const incomeCategories = categories.filter((c) => c.category_type === "income");

  const renderCategoryOptions = (cats: Category[], label: string) => {
    const roots = cats.filter((c) => !c.parent_id);
    const children = cats.filter((c) => c.parent_id);
    const childrenByParent = children.reduce<Record<string, Category[]>>((acc, c) => {
      if (!c.parent_id) return acc;
      if (!acc[c.parent_id]) acc[c.parent_id] = [];
      acc[c.parent_id].push(c);
      return acc;
    }, {});

    const options: { id: string; label: string }[] = [];
    for (const root of roots.sort((a, b) => a.name.localeCompare(b.name, "pt-BR"))) {
      options.push({ id: root.id, label: root.name });
      const subs = (childrenByParent[root.id] ?? []).sort((a, b) =>
        a.name.localeCompare(b.name, "pt-BR"),
      );
      for (const sub of subs) {
        options.push({ id: sub.id, label: getCategoryLabel(sub.id) });
      }
    }

    if (options.length === 0) return null;

    return (
      <optgroup label={label}>
        {options.map((opt) => (
          <option key={opt.id} value={opt.id}>
            {opt.label}
          </option>
        ))}
      </optgroup>
    );
  };

  return (
    <>
      <Header />
      <main className="flex flex-col gap-4 sm:gap-6">
        <section className="rounded-3xl border border-[var(--border)] bg-white/80 p-4 shadow-sm sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h3 className="text-base font-semibold uppercase tracking-[0.2em] text-[var(--ink)] sm:text-lg sm:tracking-[0.24em]">
                Importar Extrato
              </h3>
              <p className="mt-1 text-sm text-[var(--muted)]">
                Importe transações de um arquivo OFX
              </p>
            </div>
            {step !== "upload" && step !== "importing" && (
              <button
                type="button"
                onClick={handleReset}
                className={secondaryButton}
              >
                Nova importação
              </button>
            )}
          </div>

          <div className="mt-6">
            {/* Upload Step */}
            {step === "upload" && (
              <div
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                className={`relative rounded-2xl border-2 border-dashed p-8 text-center transition ${
                  isDragging
                    ? "border-[var(--accent)] bg-[var(--accent-soft)]"
                    : "border-[var(--border)] bg-white hover:border-[var(--accent)]"
                }`}
              >
                {isLoading ? (
                  <div className="flex flex-col items-center gap-3">
                    <div className="h-10 w-10 animate-spin rounded-full border-4 border-[var(--accent)] border-t-transparent" />
                    <p className="text-sm text-[var(--muted)]">
                      Processando arquivo...
                    </p>
                  </div>
                ) : (
                  <>
                    <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-[var(--accent-soft)]">
                      <svg
                        aria-hidden="true"
                        viewBox="0 0 24 24"
                        className="h-8 w-8 text-[var(--accent)]"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                        <polyline points="17 8 12 3 7 8" />
                        <line x1="12" y1="3" x2="12" y2="15" />
                      </svg>
                    </div>
                    <p className="text-sm font-semibold text-[var(--ink)]">
                      Arraste um arquivo OFX aqui
                    </p>
                    <p className="mt-1 text-xs text-[var(--muted)]">
                      ou clique para selecionar
                    </p>
                    <input
                      type="file"
                      accept=".ofx"
                      onChange={handleFileInput}
                      className="absolute inset-0 cursor-pointer opacity-0"
                    />
                  </>
                )}
              </div>
            )}

            {/* Preview Step */}
            {step === "preview" && parsedData && (
              <div className="space-y-6">
                {/* File info */}
                <div className="rounded-2xl border border-[var(--border)] bg-white p-4">
                  <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">
                        Banco
                      </p>
                      <p className="mt-1 text-sm font-semibold text-[var(--ink)]">
                        {parsedData.bankName || "Não identificado"}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">
                        Período
                      </p>
                      <p className="mt-1 text-sm font-semibold text-[var(--ink)]">
                        {parsedData.startDate && parsedData.endDate
                          ? `${formatDate(parsedData.startDate)} - ${formatDate(parsedData.endDate)}`
                          : "Não identificado"}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">
                        Transações
                      </p>
                      <p className="mt-1 text-sm font-semibold text-[var(--ink)]">
                        {parsedData.transactions.length}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">
                        Saldo Final
                      </p>
                      <p className={`mt-1 text-sm font-semibold ${
                        parsedData.ledgerBalance !== null && parsedData.ledgerBalance < 0
                          ? "text-rose-600"
                          : "text-emerald-600"
                      }`}>
                        {parsedData.ledgerBalance !== null
                          ? currencyFormatter.format(parsedData.ledgerBalance)
                          : "N/A"}
                      </p>
                    </div>
                  </div>
                </div>

                {/* Summary */}
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4">
                    <p className="text-xs font-semibold uppercase tracking-[0.2em] text-rose-600">
                      Débitos ({totals.debitCount})
                    </p>
                    <p className="mt-1 text-lg font-semibold text-rose-700">
                      - {currencyFormatter.format(totals.debits)}
                    </p>
                  </div>
                  <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
                    <p className="text-xs font-semibold uppercase tracking-[0.2em] text-emerald-600">
                      Créditos ({totals.creditCount})
                    </p>
                    <p className="mt-1 text-lg font-semibold text-emerald-700">
                      + {currencyFormatter.format(totals.credits)}
                    </p>
                  </div>
                </div>

                {/* Auto-categorization summary */}
                {autoCategorizedCount > 0 && (
                  <div className="rounded-2xl border border-blue-200 bg-blue-50 p-4">
                    <p className="text-sm font-semibold text-blue-700">
                      {autoCategorizedCount} de {parsedData.transactions.length} transações categorizadas automaticamente
                    </p>
                  </div>
                )}

                {/* Account selector */}
                <div className="rounded-2xl border border-[var(--border)] bg-white p-4">
                  <label className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">
                    Importar para qual conta?
                  </label>
                  <select
                    value={selectedAccountId}
                    onChange={(e) => setSelectedAccountId(e.target.value)}
                    className="mt-2 w-full rounded-xl border border-[var(--border)] bg-white px-4 py-3 text-sm text-[var(--ink)] shadow-sm outline-none transition focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--ring)]"
                  >
                    <option value="">Selecione uma conta...</option>
                    {accounts.filter((a) => a.is_reconcilable).map((account) => (
                      <option key={account.id} value={account.id}>
                        {account.name}
                      </option>
                    ))}
                  </select>
                  {accounts.length > 0 && accounts.filter((a) => a.is_reconcilable).length === 0 && (
                    <p className="mt-2 text-xs text-amber-600">
                      Nenhuma conta reconciliável. Habilite a opção &quot;Conta reconciliável&quot; no cadastro da conta para permitir importações.
                    </p>
                  )}
                  {/* Gap warning */}
                  {(() => {
                    const selectedAccount = accounts.find((a) => a.id === selectedAccountId);
                    if (!selectedAccount?.reconciled_until || !parsedData?.startDate) return null;
                    if (parsedData.startDate <= selectedAccount.reconciled_until) return null;
                    const gapDays = Math.ceil(
                      (new Date(parsedData.startDate).getTime() - new Date(selectedAccount.reconciled_until).getTime()) / 86400000
                    );
                    return (
                      <div className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
                        <p className="font-semibold">Gap de {gapDays} dia(s) detectado</p>
                        <p className="mt-1 text-xs">
                          O último extrato vai até <strong>{selectedAccount.reconciled_until}</strong>, mas este começa em <strong>{parsedData.startDate}</strong>.
                          {" "}Importe um extrato que comece em {selectedAccount.reconciled_until} ou antes para garantir continuidade.
                        </p>
                      </div>
                    );
                  })()}
                </div>

                {/* Transaction list */}
                <div className="rounded-2xl border border-[var(--border)] bg-white">
                  <div className="border-b border-[var(--border)] px-4 py-3">
                    <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">
                      Transações a importar
                    </p>
                  </div>
                  <div className="max-h-[400px] overflow-y-auto">
                    <table className="w-full text-sm">
                      <thead className="sticky top-0 bg-white text-xs uppercase tracking-[0.2em] text-[var(--muted)]">
                        <tr className="border-b border-[var(--border)]">
                          <th className="px-4 py-2 text-left font-semibold">
                            Data
                          </th>
                          <th className="px-4 py-2 text-left font-semibold">
                            Descrição
                          </th>
                          <th className="hidden px-4 py-2 text-left font-semibold sm:table-cell">
                            Categoria
                          </th>
                          <th className="px-4 py-2 text-right font-semibold">
                            Valor
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {parsedData.transactions.map((tx, index) => {
                          const effective = getEffectiveCategory(index);
                          return (
                            <tr
                              key={tx.fitId + index}
                              className="border-b border-[var(--border)] last:border-b-0"
                            >
                              <td className="px-4 py-3 text-[var(--muted)]">
                                {formatDate(tx.postedAt)}
                              </td>
                              <td className="px-4 py-3 text-[var(--ink)]">
                                {tx.memo || "Sem descrição"}
                              </td>
                              <td className="hidden px-4 py-3 sm:table-cell">
                                <select
                                  value={
                                    categoryOverrides.has(index)
                                      ? (categoryOverrides.get(index) ?? "__none__")
                                      : ""
                                  }
                                  onChange={(e) => handleCategoryOverride(index, e.target.value)}
                                  className="w-full max-w-[200px] rounded-lg border border-[var(--border)] bg-white px-2 py-1 text-xs text-[var(--ink)] outline-none transition focus:border-[var(--accent)] focus:ring-1 focus:ring-[var(--ring)]"
                                >
                                  {effective.isAuto && !categoryOverrides.has(index) ? (
                                    <option value="">
                                      {getCategoryLabel(effective.id!)} (Auto)
                                    </option>
                                  ) : !categoryOverrides.has(index) ? (
                                    <option value="">Sem categoria</option>
                                  ) : null}
                                  {categoryOverrides.has(index) && (
                                    <>
                                      <option value="">
                                        {ruleMatches.has(index) ? `${getCategoryLabel(ruleMatches.get(index)!.categoryId)} (Auto)` : "Sem categoria"}
                                      </option>
                                    </>
                                  )}
                                  <option value="__none__">Sem categoria</option>
                                  {renderCategoryOptions(expenseCategories, "Despesas")}
                                  {renderCategoryOptions(incomeCategories, "Receitas")}
                                </select>
                                {effective.isAuto && !categoryOverrides.has(index) && (
                                  <span className="ml-1 inline-block rounded-full bg-blue-100 px-1.5 py-0.5 text-[10px] font-semibold text-blue-700">
                                    Auto
                                  </span>
                                )}
                              </td>
                              <td
                                className={`px-4 py-3 text-right font-semibold ${
                                  tx.amount < 0 ? "text-rose-600" : "text-emerald-600"
                                }`}
                              >
                                {tx.amount < 0 ? "- " : "+ "}
                                {currencyFormatter.format(Math.abs(tx.amount))}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Actions */}
                <div className="flex flex-wrap items-center justify-end gap-3">
                  <button
                    type="button"
                    onClick={handleReset}
                    className={secondaryButton}
                  >
                    Cancelar
                  </button>
                  {(() => {
                    const selectedAccount = accounts.find((a) => a.id === selectedAccountId);
                    const hasGap = Boolean(
                      selectedAccount?.reconciled_until &&
                      parsedData?.startDate &&
                      parsedData.startDate > selectedAccount.reconciled_until
                    );
                    return (
                      <button
                        type="button"
                        onClick={handleConfirmImport}
                        disabled={!selectedAccountId || hasGap}
                        className={`${primaryButton} disabled:cursor-not-allowed disabled:opacity-60`}
                      >
                        Importar {parsedData.transactions.length} transações
                      </button>
                    );
                  })()}
                </div>
              </div>
            )}

            {/* Importing Step */}
            {step === "importing" && (
              <div className="flex flex-col items-center gap-4 py-12">
                <div className="h-12 w-12 animate-spin rounded-full border-4 border-[var(--accent)] border-t-transparent" />
                <p className="text-sm font-semibold text-[var(--ink)]">
                  Importando transações...
                </p>
                <p className="text-xs text-[var(--muted)]">
                  Isso pode levar alguns segundos
                </p>
              </div>
            )}

            {/* Done Step */}
            {step === "done" && importResult && (
              <div className="flex flex-col items-center gap-4 py-12">
                <div className="flex h-16 w-16 items-center justify-center rounded-full bg-emerald-100">
                  <svg
                    aria-hidden="true"
                    viewBox="0 0 24 24"
                    className="h-8 w-8 text-emerald-600"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M20 6L9 17l-5-5" />
                  </svg>
                </div>
                <p className="text-lg font-semibold text-[var(--ink)]">
                  Importação concluída!
                </p>
                <div className="text-center text-sm text-[var(--muted)]">
                  <p>
                    <span className="font-semibold text-emerald-600">
                      {importResult.imported}
                    </span>{" "}
                    transações importadas
                  </p>
                  {importResult.duplicates > 0 && (
                    <p className="mt-1">
                      <span className="font-semibold text-amber-600">
                        {importResult.duplicates}
                      </span>{" "}
                      duplicatas ignoradas
                    </p>
                  )}
                  {importResult.autoCategorized > 0 && (
                    <p className="mt-1">
                      <span className="font-semibold text-blue-600">
                        {importResult.autoCategorized}
                      </span>{" "}
                      transações categorizadas automaticamente
                    </p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={handleReset}
                  className={primaryButton}
                >
                  Importar outro arquivo
                </button>
              </div>
            )}

            {/* Error message */}
            {error && (
              <div className="mt-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
                {error}
              </div>
            )}
          </div>
        </section>
      </main>
    </>
  );
}

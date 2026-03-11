"use client";

import { useCallback, useEffect, useState } from "react";
import { Header } from "@/components/layout/Header";
import { useApp, type Account, type Category } from "@/contexts/AppContext";
import { getSupabaseClient } from "@/lib/supabase/client";
import { autoMatchExact, rankCandidates } from "@/lib/reconciliation-matcher";
import {
  checkAccountDiscrepancy,
  type BalanceDiscrepancy,
} from "@/lib/balance-checker";
import { currencyFormatter, shortDateFormatter } from "@/lib/formatters";
import { primaryButton, secondaryButton } from "@/constants/styles";
import type {
  ReconciliationTransaction,
  ReconciliationMatch,
  ReconciliationCandidate,
  ReconciliationSettings,
} from "@/types";

const supabase = getSupabaseClient();

function formatDate(dateStr: string) {
  return shortDateFormatter.format(new Date(dateStr + "T12:00:00Z"));
}

function formatSignedAmount(amount: number) {
  const sign = amount < 0 ? "−" : "+";
  const tone = amount < 0 ? "text-rose-600" : "text-emerald-600";
  return (
    <span className={`font-semibold ${tone}`}>
      {sign}&nbsp;{currencyFormatter.format(Math.abs(amount))}
    </span>
  );
}

type AccountReconciliationData = {
  account: Account;
  exactMatches: ReconciliationMatch[];
  unmatchedManuals: ReconciliationTransaction[];
  unmatchedOfx: ReconciliationTransaction[];
  discrepancy: BalanceDiscrepancy | null;
};

export default function ReconciliacaoPage() {
  const {
    activeFamilyId,
    accounts,
    categories,
    triggerRefresh,
  } = useApp();

  const reconcilableAccounts = accounts.filter((a) => a.is_reconcilable);

  // State
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Multi-account results
  const [accountsData, setAccountsData] = useState<AccountReconciliationData[]>([]);
  const [expandedAccountIds, setExpandedAccountIds] = useState<Set<string>>(new Set());
  const [hasResults, setHasResults] = useState(false);

  // Match selection (composite keys: "accountIdx-matchIdx")
  const [selectedMatchIds, setSelectedMatchIds] = useState<Set<string>>(new Set());
  const [isProcessing, setIsProcessing] = useState(false);

  // Candidates for unmatched manuals (on-demand)
  const [candidatesMap, setCandidatesMap] = useState<
    Record<string, ReconciliationCandidate[]>
  >({});
  const [expandedManualId, setExpandedManualId] = useState<string | null>(null);

  // Settings
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState<ReconciliationSettings>({
    amount_tolerance_abs: 1.0,
    amount_tolerance_pct: null,
    date_tolerance_days: 2,
    description_matching: false,
  });
  const [isSavingSettings, setIsSavingSettings] = useState(false);

  // Category lookup
  const categoriesById = categories.reduce<Record<string, Category>>(
    (acc, cat) => {
      acc[cat.id] = cat;
      return acc;
    },
    {},
  );

  const getCategoryLabel = (id: string | null) => {
    if (!id) return "Sem categoria";
    const cat = categoriesById[id];
    if (!cat) return "?";
    if (cat.parent_id) {
      const parent = categoriesById[cat.parent_id];
      return parent ? `${parent.name} / ${cat.name}` : cat.name;
    }
    return cat.name;
  };

  // Load family settings
  useEffect(() => {
    if (!activeFamilyId) return;
    const loadSettings = async () => {
      const { data } = await supabase
        .from("families")
        .select("reconciliation_settings")
        .eq("id", activeFamilyId)
        .single();
      if (data?.reconciliation_settings) {
        setSettings((prev) => ({ ...prev, ...data.reconciliation_settings }));
      }
    };
    loadSettings();
  }, [activeFamilyId]);

  // Fetch and match ALL reconcilable accounts
  const handleReconcile = useCallback(async () => {
    if (!activeFamilyId || reconcilableAccounts.length === 0) return;
    setIsLoading(true);
    setError(null);
    setSuccessMessage(null);
    setHasResults(false);
    setSelectedMatchIds(new Set());
    setCandidatesMap({});
    setExpandedManualId(null);

    try {
      // Fetch unreconciled manual transactions via RPC (all accounts)
      const { data: manualData, error: manualError } = await supabase.rpc(
        "unreconciled_manual_transactions",
        { family_uuid: activeFamilyId },
      );

      if (manualError) {
        setError(manualError.message);
        setIsLoading(false);
        return;
      }

      const allManuals: ReconciliationTransaction[] = (manualData ?? []).map(
        (row: {
          id: string;
          account_id: string;
          account_name: string;
          amount: number;
          description: string | null;
          original_description: string | null;
          posted_at: string;
          source: string | null;
          external_id: string | null;
          category_id: string | null;
          category_name: string | null;
          category_type: string | null;
          reconciliation_hint: Record<string, unknown> | null;
          transfer_linked_id: string | null;
        }) => ({
          id: row.id,
          amount: Number(row.amount),
          description: row.description,
          original_description: row.original_description,
          posted_at: row.posted_at,
          source: row.source,
          external_id: row.external_id,
          category_id: row.category_id,
          category_name: row.category_name,
          category_type: row.category_type,
          account_id: row.account_id,
          account_name: row.account_name,
          reconciliation_hint: row.reconciliation_hint as ReconciliationTransaction["reconciliation_hint"],
          transfer_linked_id: row.transfer_linked_id,
        }),
      );

      // Fetch OFX for ALL reconcilable accounts
      const accountIds = reconcilableAccounts
        .filter((a) => a.reconciled_until)
        .map((a) => a.id);

      if (accountIds.length === 0) {
        setError("Nenhuma conta reconciliavel com data de reconciliacao.");
        setIsLoading(false);
        return;
      }

      const { data: ofxData, error: ofxError } = await supabase
        .from("transactions")
        .select(
          "id, amount, description, original_description, posted_at, source, external_id, category_id, account_id, transfer_linked_id, accounts(name), categories(name, category_type)",
        )
        .in("account_id", accountIds)
        .eq("source", "ofx")
        .order("posted_at", { ascending: true });

      if (ofxError) {
        setError(ofxError.message);
        setIsLoading(false);
        return;
      }

      // Filter OFX by each account's reconciled_until
      const accountById = new Map(reconcilableAccounts.map((a) => [a.id, a]));
      const allOfxs: ReconciliationTransaction[] = (ofxData ?? [])
        .filter((row) => {
          const acct = accountById.get(row.account_id);
          return acct?.reconciled_until && row.posted_at <= acct.reconciled_until;
        })
        .map((row) => {
          const cat = row.categories as unknown as {
            name: string;
            category_type: string;
          } | null;
          const acct = row.accounts as unknown as { name: string } | null;
          return {
            id: row.id,
            amount: Number(row.amount),
            description: row.description,
            original_description: row.original_description,
            posted_at: row.posted_at,
            source: row.source,
            external_id: row.external_id,
            category_id: row.category_id,
            category_name: cat?.name ?? null,
            category_type: cat?.category_type ?? null,
            account_id: row.account_id,
            account_name: acct?.name ?? undefined,
            transfer_linked_id: row.transfer_linked_id,
          };
        });

      // Process per account
      const results: AccountReconciliationData[] = [];
      const expandIds = new Set<string>();
      const allMatchKeys: string[] = [];

      for (let ai = 0; ai < reconcilableAccounts.length; ai++) {
        const account = reconcilableAccounts[ai];
        if (!account.reconciled_until) continue;

        const accountManuals = allManuals.filter((m) => m.account_id === account.id);
        const accountOfx = allOfxs.filter((o) => o.account_id === account.id);

        const result = autoMatchExact(accountManuals, accountOfx);

        // Check discrepancy
        let discrepancy: BalanceDiscrepancy | null = null;
        if (account.reconciled_balance != null && account.reconciled_until) {
          discrepancy = await checkAccountDiscrepancy(account);
        }

        const hasPendencies =
          result.exactMatches.length > 0 ||
          result.unmatchedManuals.length > 0 ||
          discrepancy != null;

        if (hasPendencies) {
          expandIds.add(account.id);
        }

        // Track match keys for pre-selection
        for (let mi = 0; mi < result.exactMatches.length; mi++) {
          allMatchKeys.push(`${ai}-${mi}`);
        }

        results.push({
          account,
          exactMatches: result.exactMatches,
          unmatchedManuals: result.unmatchedManuals,
          unmatchedOfx: result.unmatchedOfx,
          discrepancy,
        });
      }

      setAccountsData(results);
      setExpandedAccountIds(expandIds);
      setSelectedMatchIds(new Set(allMatchKeys));
      setHasResults(true);
    } catch {
      setError("Erro ao buscar transacoes.");
    } finally {
      setIsLoading(false);
    }
  }, [activeFamilyId, reconcilableAccounts]);

  // Auto-load on mount when accounts are available
  const [didAutoLoad, setDidAutoLoad] = useState(false);
  useEffect(() => {
    if (!didAutoLoad && activeFamilyId && reconcilableAccounts.length > 0) {
      setDidAutoLoad(true);
      handleReconcile();
    }
  }, [didAutoLoad, activeFamilyId, reconcilableAccounts.length, handleReconcile]);

  // Find candidates for a manual transaction (cross-account pool)
  const handleFindCandidates = (manual: ReconciliationTransaction) => {
    if (expandedManualId === manual.id) {
      setExpandedManualId(null);
      return;
    }
    const allUnmatchedOfx = accountsData.flatMap((ad) => ad.unmatchedOfx);
    const candidates = rankCandidates(manual, allUnmatchedOfx, settings, true);
    setCandidatesMap((prev) => ({ ...prev, [manual.id]: candidates }));
    setExpandedManualId(manual.id);
  };

  // Toggle match selection
  const toggleMatchSelection = (key: string) => {
    setSelectedMatchIds((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  // Confirm exact matches: bulk delete manuals across all accounts
  const handleConfirmMatches = async () => {
    if (selectedMatchIds.size === 0) return;

    // Map each deleted manual to its OFX replacement
    const manualIdsToDelete: string[] = [];
    const manualToOfxMap = new Map<string, string>();

    for (const key of selectedMatchIds) {
      const [aiStr, miStr] = key.split("-");
      const ai = Number(aiStr);
      const mi = Number(miStr);
      const ad = accountsData[ai];
      if (ad?.exactMatches[mi]) {
        const match = ad.exactMatches[mi];
        manualIdsToDelete.push(match.manual.id);
        manualToOfxMap.set(match.manual.id, match.ofx.id);
      }
    }

    if (manualIdsToDelete.length === 0) return;

    if (
      !window.confirm(
        `Excluir ${manualIdsToDelete.length} lancamento(s) manual(is) que foram pareados com OFX?`,
      )
    ) {
      return;
    }

    // Classify transfer migrations:
    // - Both sides deleted in same batch → link OFX replacements directly
    // - Only one side deleted → migrate partner to OFX replacement
    const directLinks = new Set<string>();
    const migrateLinks: { oldPartnerId: string; replacingOfxId: string }[] = [];

    for (const key of selectedMatchIds) {
      const [aiStr, miStr] = key.split("-");
      const ai = Number(aiStr);
      const mi = Number(miStr);
      const ad = accountsData[ai];
      if (!ad?.exactMatches[mi]) continue;
      const match = ad.exactMatches[mi];
      const partnerId = match.manual.transfer_linked_id;
      if (!partnerId) continue;

      if (manualToOfxMap.has(partnerId)) {
        // Both sides being deleted → link their OFX replacements directly
        const ofxA = match.ofx.id;
        const ofxB = manualToOfxMap.get(partnerId)!;
        const linkKey = [ofxA, ofxB].sort().join("|");
        directLinks.add(linkKey);
      } else {
        // Only this side being deleted → migrate partner to this OFX
        migrateLinks.push({
          oldPartnerId: partnerId,
          replacingOfxId: match.ofx.id,
        });
      }
    }

    setIsProcessing(true);
    setError(null);

    // Delete manuals (ON DELETE SET NULL clears partner's transfer_linked_id)
    const { error: deleteError } = await supabase
      .from("transactions")
      .delete()
      .in("id", manualIdsToDelete);

    if (deleteError) {
      setError(deleteError.message);
      setIsProcessing(false);
      return;
    }

    // Re-link transfers
    const transferCategory = categories.find((c) => c.category_type === "transfer");
    if (transferCategory) {
      // Direct links: both sides were deleted, link OFX↔OFX
      for (const linkKey of directLinks) {
        const [ofxA, ofxB] = linkKey.split("|");
        await supabase.rpc("link_transfer", {
          tx_a: ofxA,
          tx_b: ofxB,
          transfer_category: transferCategory.id,
        });
      }
      // Migrate links: only one side was deleted, re-link partner to OFX
      for (const migration of migrateLinks) {
        await supabase.rpc("migrate_transfer_link", {
          old_partner_id: migration.oldPartnerId,
          new_ofx_id: migration.replacingOfxId,
          transfer_category: transferCategory.id,
        });
      }
    }

    setSuccessMessage(
      `${manualIdsToDelete.length} lancamento(s) manual(is) excluido(s) com sucesso.`,
    );
    triggerRefresh();
    setIsProcessing(false);
    handleReconcile();
  };

  // Link a single manual to an OFX candidate (delete manual, migrate transfer link if needed)
  const handleLinkManual = async (manualId: string, replacingOfxId: string) => {
    if (
      !window.confirm(
        "Excluir o lancamento manual? A transacao OFX sera mantida.",
      )
    ) {
      return;
    }

    // Check if manual has a transfer link that needs migration
    const manual = accountsData
      .flatMap((ad) => ad.unmatchedManuals)
      .find((m) => m.id === manualId);
    const oldPartnerId = manual?.transfer_linked_id;

    setError(null);
    // Delete manual (ON DELETE SET NULL clears partner's transfer_linked_id)
    const { error: deleteError } = await supabase
      .from("transactions")
      .delete()
      .eq("id", manualId);

    if (deleteError) {
      setError(deleteError.message);
      return;
    }

    // Migrate transfer link if the manual was linked
    if (oldPartnerId) {
      const transferCategory = categories.find((c) => c.category_type === "transfer");
      if (transferCategory) {
        await supabase.rpc("migrate_transfer_link", {
          old_partner_id: oldPartnerId,
          new_ofx_id: replacingOfxId,
          transfer_category: transferCategory.id,
        });
      }
    }

    setSuccessMessage("Lancamento manual excluido com sucesso.");
    triggerRefresh();
    handleReconcile();
  };

  // Delete a manual transaction
  const handleDeleteManual = async (manualId: string) => {
    if (!window.confirm("Excluir este lancamento manual?")) return;

    setError(null);
    const { error: deleteError } = await supabase
      .from("transactions")
      .delete()
      .eq("id", manualId);

    if (deleteError) {
      setError(deleteError.message);
      return;
    }

    setSuccessMessage("Lancamento manual excluido.");
    triggerRefresh();
    handleReconcile();
  };

  // Move manual transaction forward (past reconciled_until)
  const handleMoveForward = async (manual: ReconciliationTransaction) => {
    const account = reconcilableAccounts.find((a) => a.id === manual.account_id);
    if (!account?.reconciled_until) return;

    const reconciledDate = new Date(
      account.reconciled_until + "T12:00:00Z",
    );
    reconciledDate.setUTCDate(reconciledDate.getUTCDate() + 1);
    const newDate = reconciledDate.toISOString().split("T")[0];

    if (
      !window.confirm(
        `Mover este lancamento para ${formatDate(newDate)}? Ele saira do periodo reconciliado.`,
      )
    )
      return;

    setError(null);
    const { error: updateError } = await supabase
      .from("transactions")
      .update({ posted_at: newDate })
      .eq("id", manual.id);

    if (updateError) {
      setError(updateError.message);
      return;
    }

    setSuccessMessage("Lancamento movido para apos o periodo reconciliado.");
    triggerRefresh();
    handleReconcile();
  };

  // Save settings
  const handleSaveSettings = async () => {
    if (!activeFamilyId) return;
    setIsSavingSettings(true);
    const { error: updateError } = await supabase
      .from("families")
      .update({ reconciliation_settings: settings })
      .eq("id", activeFamilyId);

    if (updateError) {
      setError(updateError.message);
    } else {
      setSuccessMessage("Configuracoes salvas.");
    }
    setIsSavingSettings(false);
  };

  // Toggle account expand/collapse
  const toggleAccount = (accountId: string) => {
    setExpandedAccountIds((prev) => {
      const next = new Set(prev);
      if (next.has(accountId)) {
        next.delete(accountId);
      } else {
        next.add(accountId);
      }
      return next;
    });
  };

  // Global totals
  const totalExactMatches = accountsData.reduce((sum, ad) => sum + ad.exactMatches.length, 0);
  const totalUnmatchedManuals = accountsData.reduce((sum, ad) => sum + ad.unmatchedManuals.length, 0);
  const accountsWithDiscrepancy = accountsData.filter((ad) => ad.discrepancy != null).length;

  return (
    <>
      <Header />
      <main className="flex flex-col gap-4 sm:gap-6">
        <section className="rounded-3xl border border-[var(--border)] bg-white/80 px-3 py-4 shadow-sm sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold uppercase tracking-[0.3em] text-[var(--muted)]">
                Reconciliacao
              </h3>
              <p className="mt-2 text-sm text-[var(--muted)]">
                Compare lancamentos manuais com transacoes OFX de todas as contas reconciliaveis.
              </p>
            </div>
          </div>

          {/* Refresh button */}
          {hasResults ? (
            <div className="mt-5">
              <button
                type="button"
                onClick={handleReconcile}
                disabled={isLoading}
                className={secondaryButton + " disabled:opacity-50"}
              >
                {isLoading ? "Atualizando..." : "Atualizar"}
              </button>
            </div>
          ) : null}

          {error ? (
            <div className="mt-4 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
              {error}
            </div>
          ) : null}

          {successMessage ? (
            <div className="mt-4 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
              {successMessage}
            </div>
          ) : null}

          {/* Settings (collapsible) */}
          <div className="mt-4">
            <button
              type="button"
              onClick={() => setShowSettings((prev) => !prev)}
              className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.3em] text-[var(--muted)] transition hover:text-[var(--ink)]"
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                className={`h-4 w-4 transition ${showSettings ? "rotate-90" : ""}`}
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M9 18l6-6-6-6" />
              </svg>
              Configuracoes de tolerancia
            </button>
            {showSettings ? (
              <div className="mt-3 grid gap-3 rounded-2xl border border-[var(--border)] bg-white p-4 sm:grid-cols-4">
                <div className="flex flex-col gap-1">
                  <label className="text-xs font-semibold text-[var(--muted)]">
                    Tolerancia de valor (R$)
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={settings.amount_tolerance_abs ?? ""}
                    onChange={(e) =>
                      setSettings((prev) => ({
                        ...prev,
                        amount_tolerance_abs: e.target.value
                          ? Number(e.target.value)
                          : null,
                      }))
                    }
                    className="rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm text-[var(--ink)]"
                    placeholder="1.00"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-xs font-semibold text-[var(--muted)]">
                    Tolerancia de data (dias)
                  </label>
                  <input
                    type="number"
                    step="1"
                    min="0"
                    max="30"
                    value={settings.date_tolerance_days ?? ""}
                    onChange={(e) =>
                      setSettings((prev) => ({
                        ...prev,
                        date_tolerance_days: e.target.value
                          ? Number(e.target.value)
                          : null,
                      }))
                    }
                    className="rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm text-[var(--ink)]"
                    placeholder="2"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-xs font-semibold text-[var(--muted)]">
                    Comparar descricao
                  </label>
                  <button
                    type="button"
                    onClick={() =>
                      setSettings((prev) => ({
                        ...prev,
                        description_matching: !prev.description_matching,
                      }))
                    }
                    className={`rounded-xl border px-3 py-2 text-sm font-semibold transition ${
                      settings.description_matching
                        ? "border-emerald-300 bg-emerald-50 text-emerald-700"
                        : "border-[var(--border)] bg-white text-[var(--muted)]"
                    }`}
                  >
                    {settings.description_matching ? "Ativo" : "Inativo"}
                  </button>
                </div>
                <div className="flex items-end">
                  <button
                    type="button"
                    onClick={handleSaveSettings}
                    disabled={isSavingSettings}
                    className={secondaryButton + " !py-2 disabled:opacity-50"}
                  >
                    {isSavingSettings ? "Salvando..." : "Salvar"}
                  </button>
                </div>
              </div>
            ) : null}
          </div>

          {/* Loading state */}
          {isLoading && !hasResults ? (
            <div className="mt-6 py-12 text-center text-sm text-[var(--muted)]">
              Buscando transacoes de {reconcilableAccounts.length} conta(s)...
            </div>
          ) : null}

          {/* Results */}
          {hasResults ? (
            <div className="mt-6 space-y-6">
              {/* Global summary cards */}
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="rounded-2xl border border-[var(--border)] bg-white p-4 text-center">
                  <div className="text-2xl font-bold text-[var(--accent)]">
                    {totalExactMatches}
                  </div>
                  <div className="mt-1 text-xs font-semibold text-[var(--muted)]">
                    Matches exatos
                  </div>
                </div>
                <div className="rounded-2xl border border-[var(--border)] bg-white p-4 text-center">
                  <div className="text-2xl font-bold text-amber-600">
                    {totalUnmatchedManuals}
                  </div>
                  <div className="mt-1 text-xs font-semibold text-[var(--muted)]">
                    Manuais sem par
                  </div>
                </div>
                <div className="rounded-2xl border border-[var(--border)] bg-white p-4 text-center">
                  <div className={`text-2xl font-bold ${accountsWithDiscrepancy > 0 ? "text-amber-600" : "text-emerald-600"}`}>
                    {accountsWithDiscrepancy}
                  </div>
                  <div className="mt-1 text-xs font-semibold text-[var(--muted)]">
                    Contas com divergencia
                  </div>
                </div>
              </div>

              {/* Global confirm button (sticky) */}
              {selectedMatchIds.size > 0 ? (
                <div className="sticky top-0 z-10 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <span className="text-sm font-semibold text-emerald-800">
                      {selectedMatchIds.size} match(es) selecionado(s)
                    </span>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setSelectedMatchIds(new Set())}
                        className={secondaryButton + " !py-1.5 !text-xs"}
                      >
                        Desmarcar todos
                      </button>
                      <button
                        type="button"
                        onClick={handleConfirmMatches}
                        disabled={isProcessing}
                        className={
                          primaryButton +
                          " !py-1.5 !text-xs disabled:opacity-50"
                        }
                      >
                        {isProcessing
                          ? "Processando..."
                          : `Confirmar ${selectedMatchIds.size} match(es)`}
                      </button>
                    </div>
                  </div>
                </div>
              ) : null}

              {/* Per-account sections (only those with pendencies) */}
              {accountsData.filter((ad) => {
                return ad.exactMatches.length > 0 || ad.unmatchedManuals.length > 0 || ad.discrepancy != null;
              }).map((ad, accountIdx) => {
                const isExpanded = expandedAccountIds.has(ad.account.id);
                const pendingCount = ad.exactMatches.length + ad.unmatchedManuals.length;

                return (
                  <div
                    key={ad.account.id}
                    className="rounded-2xl border border-[var(--border)] bg-white overflow-hidden"
                  >
                    {/* Account header */}
                    <button
                      type="button"
                      onClick={() => toggleAccount(ad.account.id)}
                      className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition hover:bg-slate-50"
                    >
                      <div className="flex min-w-0 items-center gap-3">
                        <svg
                          aria-hidden="true"
                          viewBox="0 0 24 24"
                          className={`h-4 w-4 shrink-0 text-[var(--muted)] transition ${isExpanded ? "rotate-90" : ""}`}
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d="M9 18l6-6-6-6" />
                        </svg>
                        <span className="truncate text-sm font-semibold text-[var(--ink)]">
                          {ad.account.name}
                        </span>
                        {ad.account.reconciled_until ? (
                          <span className="shrink-0 text-xs text-[var(--muted)]">
                            ate {formatDate(ad.account.reconciled_until)}
                          </span>
                        ) : null}
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        {pendingCount > 0 ? (
                          <span className="whitespace-nowrap rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-700">
                            {pendingCount} pendente{pendingCount !== 1 ? "s" : ""}
                          </span>
                        ) : null}
                        {ad.discrepancy ? (
                          <span className="whitespace-nowrap rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-700">
                            Divergencia
                          </span>
                        ) : null}
                      </div>
                    </button>

                    {/* Expanded content */}
                    {isExpanded ? (
                      <div className="border-t border-[var(--border)] px-4 py-4 space-y-4">
                        {/* Account info banner */}
                        {ad.account.reconciled_until ? (
                          <div className="rounded-2xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-800">
                            Reconciliado ate{" "}
                            <span className="font-semibold">
                              {formatDate(ad.account.reconciled_until)}
                            </span>
                            {ad.account.reconciled_balance != null ? (
                              <>
                                {" "}
                                — Saldo banco:{" "}
                                <span className="font-semibold">
                                  {currencyFormatter.format(ad.account.reconciled_balance)}
                                </span>
                              </>
                            ) : null}
                          </div>
                        ) : null}

                        {/* Discrepancy alert */}
                        {ad.discrepancy ? (
                          <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                            <div>
                              <span className="font-semibold">
                                Divergencia de saldo
                              </span>
                              <span className="ml-2">
                                Sistema:{" "}
                                {currencyFormatter.format(ad.discrepancy.calculatedBalance)} |
                                Banco:{" "}
                                {currencyFormatter.format(ad.discrepancy.reconciledBalance)} |
                                Diferenca:{" "}
                                <span className="font-semibold">
                                  {currencyFormatter.format(ad.discrepancy.difference)}
                                </span>
                              </span>
                            </div>
                            {ad.exactMatches.length === 0 && ad.unmatchedManuals.length === 0 ? (
                              <p className="mt-1 text-xs text-amber-700">
                                Nao ha manuais pendentes no periodo OFX. Verifique lancamentos anteriores ao primeiro extrato ou o saldo inicial da conta.
                              </p>
                            ) : null}
                          </div>
                        ) : null}

                        {/* Exact matches for this account */}
                        {ad.exactMatches.length > 0 ? (
                          <div>
                            <h4 className="text-xs font-semibold uppercase tracking-[0.3em] text-[var(--muted)]">
                              Matches exatos ({ad.exactMatches.length})
                            </h4>
                            <div className="mt-3 space-y-3">
                              {ad.exactMatches.map((match, matchIdx) => {
                                const key = `${accountIdx}-${matchIdx}`;
                                const isSelected = selectedMatchIds.has(key);
                                return (
                                  <div
                                    key={`${match.manual.id}-${match.ofx.id}`}
                                    className={`rounded-2xl border p-4 transition ${
                                      isSelected
                                        ? "border-emerald-300 bg-emerald-50/50"
                                        : "border-[var(--border)] bg-white"
                                    }`}
                                  >
                                    <div className="flex flex-wrap items-center justify-between gap-2">
                                      <div className="flex items-center gap-2">
                                        <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">
                                          100%
                                        </span>
                                        <span className="text-xs text-[var(--muted)]">
                                          {match.matchReason}
                                        </span>
                                      </div>
                                      <button
                                        type="button"
                                        onClick={() => toggleMatchSelection(key)}
                                        className={`rounded-xl border px-3 py-1.5 text-xs font-semibold transition ${
                                          isSelected
                                            ? "border-emerald-300 bg-emerald-100 text-emerald-700"
                                            : "border-[var(--border)] bg-white text-[var(--ink)] hover:border-emerald-300"
                                        }`}
                                      >
                                        {isSelected ? "Selecionado" : "Selecionar"}
                                      </button>
                                    </div>

                                    <div className="mt-3 grid gap-3 sm:grid-cols-2">
                                      {/* Manual side */}
                                      <div className="rounded-xl border border-[var(--border)] bg-white/80 p-3">
                                        <div className="flex items-center gap-2">
                                          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-600">
                                            Manual
                                          </span>
                                          <span className="text-xs text-[var(--muted)]">
                                            {formatDate(match.manual.posted_at)}
                                          </span>
                                        </div>
                                        <p className="mt-1 truncate text-sm font-semibold text-[var(--ink)]">
                                          {match.manual.description || "—"}
                                        </p>
                                        <div className="mt-1 flex items-center justify-between">
                                          <span className="text-xs text-[var(--muted)]">
                                            {getCategoryLabel(match.manual.category_id)}
                                          </span>
                                          <span className="text-sm">
                                            {formatSignedAmount(match.manual.amount)}
                                          </span>
                                        </div>
                                      </div>

                                      {/* OFX side */}
                                      <div className="rounded-xl border border-sky-200 bg-sky-50/50 p-3">
                                        <div className="flex items-center gap-2">
                                          <span className="rounded-full bg-sky-100 px-2 py-0.5 text-[10px] font-semibold text-sky-600">
                                            OFX
                                          </span>
                                          <span className="text-xs text-[var(--muted)]">
                                            {formatDate(match.ofx.posted_at)}
                                          </span>
                                        </div>
                                        <p className="mt-1 truncate text-sm font-semibold text-[var(--ink)]">
                                          {match.ofx.description ||
                                            match.ofx.original_description ||
                                            "—"}
                                        </p>
                                        <div className="mt-1 flex items-center justify-between">
                                          <span className="text-xs text-[var(--muted)]">
                                            {getCategoryLabel(match.ofx.category_id)}
                                          </span>
                                          <span className="text-sm">
                                            {formatSignedAmount(match.ofx.amount)}
                                          </span>
                                        </div>
                                      </div>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        ) : null}

                        {/* Unmatched manuals for this account */}
                        {ad.unmatchedManuals.length > 0 ? (
                          <div>
                            <h4 className="text-xs font-semibold uppercase tracking-[0.3em] text-[var(--muted)]">
                              Manuais sem reconciliar ({ad.unmatchedManuals.length})
                            </h4>
                            <div className="mt-3 space-y-3">
                              {ad.unmatchedManuals.map((manual) => {
                                const isManualExpanded = expandedManualId === manual.id;
                                const candidates = candidatesMap[manual.id];

                                return (
                                  <div
                                    key={manual.id}
                                    className="rounded-2xl border border-[var(--border)] bg-white"
                                  >
                                    <div className="p-4">
                                      <div className="flex items-center justify-between gap-3">
                                        <div className="flex min-w-0 items-center gap-3">
                                          <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-600">
                                            Manual
                                          </span>
                                          <div className="min-w-0">
                                            <p className="truncate text-sm font-semibold text-[var(--ink)]">
                                              {manual.description || "—"}
                                            </p>
                                            <div className="flex items-center gap-2 text-xs text-[var(--muted)]">
                                              <span>
                                                {formatDate(manual.posted_at)}
                                              </span>
                                              <span>
                                                {getCategoryLabel(manual.category_id)}
                                              </span>
                                            </div>
                                          </div>
                                        </div>
                                        <span className="shrink-0 text-sm">
                                          {formatSignedAmount(manual.amount)}
                                        </span>
                                      </div>
                                      <div className="mt-3 flex flex-wrap items-center gap-2">
                                        <button
                                          type="button"
                                          onClick={() => handleDeleteManual(manual.id)}
                                          className="rounded-xl border border-rose-300 bg-rose-50 px-3 py-1.5 text-xs font-semibold text-rose-700 transition hover:bg-rose-100"
                                        >
                                          Excluir
                                        </button>
                                        <button
                                          type="button"
                                          onClick={() => handleFindCandidates(manual)}
                                          className={`rounded-xl border px-3 py-1.5 text-xs font-semibold transition ${
                                            isManualExpanded
                                              ? "border-sky-300 bg-sky-50 text-sky-700"
                                              : "border-[var(--border)] bg-white text-[var(--ink)] hover:border-sky-300"
                                          }`}
                                        >
                                          {isManualExpanded ? "Fechar" : "Encontrar OFX"}
                                        </button>
                                        <button
                                          type="button"
                                          onClick={() => handleMoveForward(manual)}
                                          className="rounded-xl border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-semibold text-amber-700 transition hover:bg-amber-100"
                                        >
                                          Mover p/ frente
                                        </button>
                                      </div>
                                    </div>

                                    {/* Candidates panel */}
                                    {isManualExpanded ? (
                                      <div className="border-t border-[var(--border)] px-4 py-3">
                                        {candidates && candidates.length > 0 ? (
                                          <div className="space-y-2">
                                            <p className="text-xs font-semibold text-[var(--muted)]">
                                              {candidates.length} candidata(s)
                                              encontrada(s)
                                            </p>
                                            {candidates.map((candidate) => {
                                              const isCrossAccount =
                                                manual.account_id &&
                                                candidate.ofx.account_id &&
                                                manual.account_id !== candidate.ofx.account_id;

                                              const dateDiff = Math.abs(
                                                Math.round(
                                                  (new Date(manual.posted_at + "T12:00:00Z").getTime() -
                                                    new Date(candidate.ofx.posted_at + "T12:00:00Z").getTime()) /
                                                    86_400_000,
                                                ),
                                              );
                                              const amountDiff =
                                                Math.abs(manual.amount) - Math.abs(candidate.ofx.amount);

                                              return (
                                                <div
                                                  key={candidate.ofx.id}
                                                  className={`rounded-xl border p-3 ${
                                                    isCrossAccount
                                                      ? "border-purple-200 bg-purple-50/50"
                                                      : "border-sky-200 bg-sky-50/50"
                                                  }`}
                                                >
                                                  <div className="flex items-start justify-between gap-3">
                                                    <div className="flex min-w-0 items-start gap-3">
                                                      <span
                                                        className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                                                          candidate.score >= 80
                                                            ? "bg-emerald-100 text-emerald-700"
                                                            : candidate.score >= 60
                                                              ? "bg-sky-100 text-sky-700"
                                                              : "bg-amber-100 text-amber-700"
                                                        }`}
                                                      >
                                                        {candidate.score}
                                                      </span>
                                                      <div className="min-w-0 space-y-1">
                                                        {/* Cross-account badge */}
                                                        {isCrossAccount ? (
                                                          <span className="inline-block rounded-full bg-purple-100 px-2 py-0.5 text-[10px] font-semibold text-purple-700">
                                                            {candidate.ofx.account_name || "Outra conta"}
                                                          </span>
                                                        ) : null}

                                                        {/* Description comparison */}
                                                        <div className="text-xs text-[var(--muted)]">
                                                          <span>Manual: {manual.description || "—"}</span>
                                                        </div>
                                                        <p className="truncate text-sm font-semibold text-[var(--ink)]">
                                                          OFX: {candidate.ofx.description ||
                                                            candidate.ofx.original_description ||
                                                            "—"}
                                                        </p>

                                                        {/* Date + amount diffs */}
                                                        <div className="flex flex-wrap items-center gap-3 text-xs text-[var(--muted)]">
                                                          <span>
                                                            {formatDate(candidate.ofx.posted_at)}
                                                            {dateDiff > 0 ? (
                                                              <span className="ml-1 font-semibold text-amber-600">
                                                                ({dateDiff > 0 ? "+" : ""}{dateDiff}d)
                                                              </span>
                                                            ) : null}
                                                          </span>
                                                          <span>
                                                            {formatSignedAmount(candidate.ofx.amount)}
                                                            {Math.abs(amountDiff) > 0.01 ? (
                                                              <span className="ml-1 font-semibold text-amber-600">
                                                                ({amountDiff > 0 ? "+" : ""}{currencyFormatter.format(amountDiff)})
                                                              </span>
                                                            ) : null}
                                                          </span>
                                                          <span>{candidate.reason}</span>
                                                        </div>
                                                      </div>
                                                    </div>
                                                    <button
                                                      type="button"
                                                      onClick={() =>
                                                        handleLinkManual(manual.id, candidate.ofx.id)
                                                      }
                                                      className="shrink-0 rounded-xl border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-700 transition hover:bg-emerald-100"
                                                    >
                                                      Vincular
                                                    </button>
                                                  </div>
                                                </div>
                                              );
                                            })}
                                          </div>
                                        ) : candidates ? (
                                          <div className="text-sm text-[var(--muted)]">
                                            <p>Nenhuma OFX compativel encontrada.</p>
                                            <p className="mt-1 text-xs">
                                              Voce pode excluir este lancamento (se a OFX
                                              ja cobre) ou mover para o proximo periodo.
                                            </p>
                                          </div>
                                        ) : null}
                                      </div>
                                    ) : null}
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        ) : null}

                      </div>
                    ) : null}
                  </div>
                );
              })}

              {/* Global empty state */}
              {accountsData.length === 0 ? (
                <div className="py-8 text-center text-sm text-[var(--muted)]">
                  Nenhuma conta reconciliavel com data de reconciliacao.
                </div>
              ) : totalExactMatches === 0 && totalUnmatchedManuals === 0 && accountsWithDiscrepancy === 0 ? (
                <div className="py-8 text-center text-sm text-emerald-600 font-semibold">
                  Todas as contas estao reconciliadas.
                </div>
              ) : null}
            </div>
          ) : null}
        </section>
      </main>
    </>
  );
}

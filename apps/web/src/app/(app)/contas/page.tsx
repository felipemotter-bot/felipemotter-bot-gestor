"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Header } from "@/components/layout/Header";
import { AccountModal } from "@/components/modals/AccountModal";
import { useApp, type Account } from "@/contexts/AppContext";
import { getSupabaseClient } from "@/lib/supabase/client";
import { currencyFormatter, shortDateFormatter } from "@/lib/formatters";
import { checkAccountDiscrepancy, type BalanceDiscrepancy } from "@/lib/balance-checker";
import { accountIconLookup } from "@/constants/icons";

const supabase = getSupabaseClient();

export default function ContasPage() {
  const router = useRouter();
  const {
    session,
    activeFamilyId,
    accounts,
    archivedAccounts,
    accountBalances,
    totalBalance,
    activeMonth,
    categories,
    isLoadingArchivedAccounts,
    loadAccounts,
    loadArchivedAccounts,
    openTransactionModal,
    triggerRefresh,
  } = useApp();

  // UI state
  const [showArchivedAccounts, setShowArchivedAccounts] = useState(false);
  const [openAccountMenuId, setOpenAccountMenuId] = useState<string | null>(null);
  const [accountTxnCounts, setAccountTxnCounts] = useState<Record<string, number | undefined>>({});
  const [accountActionError, setAccountActionError] = useState<string | null>(null);
  const [accountActionLoadingId, setAccountActionLoadingId] = useState<string | null>(null);

  // Discrepancy state
  const [discrepancies, setDiscrepancies] = useState<Record<string, BalanceDiscrepancy>>({});
  const [adjustingAccountId, setAdjustingAccountId] = useState<string | null>(null);

  // Modal state
  const [isAccountModalOpen, setIsAccountModalOpen] = useState(false);
  const [editingAccount, setEditingAccount] = useState<Account | null>(null);

  // Derived values
  const { startDate: monthStart } = getMonthRange(activeMonth);
  const monthLabel = monthStart
    ? new Date(monthStart + "T12:00:00Z").toLocaleDateString("pt-BR", {
        month: "short",
        year: "numeric",
      })
    : "";

  // Load archived when toggle is on
  useEffect(() => {
    if (showArchivedAccounts && activeFamilyId) {
      loadArchivedAccounts(activeFamilyId);
    }
  }, [showArchivedAccounts, activeFamilyId, loadArchivedAccounts]);

  // Close menu on outside click
  useEffect(() => {
    if (!openAccountMenuId) return;

    const handleClick = (event: MouseEvent | TouchEvent) => {
      const menuElem = document.querySelector(`[data-account-menu-id="${openAccountMenuId}"]`);
      if (menuElem && !menuElem.contains(event.target as Node)) {
        setOpenAccountMenuId(null);
      }
    };

    document.addEventListener("mousedown", handleClick);
    document.addEventListener("touchstart", handleClick);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("touchstart", handleClick);
    };
  }, [openAccountMenuId]);

  // Check discrepancies for reconcilable accounts
  useEffect(() => {
    const reconcilable = accounts.filter(
      (a) => a.is_reconcilable && a.reconciled_balance != null && a.reconciled_until,
    );
    let cancelled = false;
    const work =
      reconcilable.length > 0
        ? Promise.all(reconcilable.map((a) => checkAccountDiscrepancy(a)))
        : Promise.resolve([] as (BalanceDiscrepancy | null)[]);
    work.then((results) => {
      if (cancelled) return;
      const next: Record<string, BalanceDiscrepancy> = {};
      for (const disc of results) {
        if (disc) next[disc.accountId] = disc;
      }
      setDiscrepancies(next);
    });
    return () => {
      cancelled = true;
    };
  }, [accounts]);

  // Quick balance adjust handler
  const handleQuickAdjust = async (account: Account) => {
    const disc = discrepancies[account.id];
    if (!disc || !activeFamilyId) return;

    const adjustCategory = categories.find((c) => c.name === "Ajuste de saldo");
    if (!adjustCategory) {
      setAccountActionError('Categoria "Ajuste de saldo" nao encontrada.');
      return;
    }

    const adjustAmount = -disc.difference;
    if (
      !window.confirm(
        `Criar ajuste de ${currencyFormatter.format(adjustAmount)} em ${shortDateFormatter.format(new Date(disc.reconciledUntil + "T12:00:00Z"))} para corrigir a divergencia?`,
      )
    ) {
      return;
    }

    setAdjustingAccountId(account.id);
    setAccountActionError(null);

    const { error } = await supabase.from("transactions").insert({
      account_id: account.id,
      family_id: activeFamilyId,
      amount: adjustAmount,
      description: "Ajuste de saldo (reconciliacao)",
      posted_at: disc.reconciledUntil,
      source: "adjustment",
      category_id: adjustCategory.id,
    });

    if (error) {
      setAccountActionError(error.message);
      setAdjustingAccountId(null);
      return;
    }

    triggerRefresh();
    await loadAccounts(activeFamilyId);
    setAdjustingAccountId(null);
  };

  // Helpers
  const getAccountTransactionCount = useCallback(async (accountId: string) => {
    const { count, error } = await supabase
      .from("transactions")
      .select("id", { count: "exact", head: true })
      .eq("account_id", accountId);
    if (error) return null;
    return count ?? 0;
  }, []);

  const getAccountBalanceForArchive = useCallback(async (account: Account) => {
    const opening = account.opening_balance ?? 0;
    const { data, error } = await supabase
      .from("transactions")
      .select("amount")
      .eq("account_id", account.id);
    if (error) return null;

    let balance = opening;
    (data ?? []).forEach((item) => {
      const amountValue = Number(item.amount);
      if (!Number.isFinite(amountValue)) return;
      balance += amountValue;
    });
    return balance;
  }, []);

  // Handlers
  const openAccountModal = () => {
    setEditingAccount(null);
    setIsAccountModalOpen(true);
  };

  const openAccountEditor = (account: Account) => {
    setEditingAccount(account);
    setIsAccountModalOpen(true);
  };

  const closeAccountModal = () => {
    setIsAccountModalOpen(false);
    setEditingAccount(null);
  };

  const openAccountTransactions = (accountId: string) => {
    router.push(`/lancamentos?account=${accountId}`);
  };

  const openAccountStatement = (accountId: string) => {
    router.push(`/extrato?account=${accountId}`);
  };

  const handleDeleteAccount = async (account: Account) => {
    setAccountActionError(null);
    if (!session?.access_token || !activeFamilyId) {
      setAccountActionError("Selecione uma familia ativa.");
      return;
    }
    setAccountActionLoadingId(account.id);
    const transactionCount = await getAccountTransactionCount(account.id);
    if (transactionCount === null) {
      setAccountActionError("Nao foi possivel verificar os lancamentos.");
      setAccountActionLoadingId(null);
      return;
    }
    if (transactionCount > 0) {
      setAccountActionError(
        "Conta possui lancamentos. Para manter o historico, arquive com saldo zerado.",
      );
      setAccountActionLoadingId(null);
      return;
    }
    if (!window.confirm(`Excluir a conta "${account.name}"?`)) {
      setAccountActionLoadingId(null);
      return;
    }
    const { error } = await supabase.from("accounts").delete().eq("id", account.id);
    if (error) {
      setAccountActionError(error.message);
      setAccountActionLoadingId(null);
      return;
    }
    await loadAccounts(activeFamilyId);
    setOpenAccountMenuId(null);
    setAccountActionLoadingId(null);
  };

  const handleArchiveAccount = async (account: Account) => {
    setAccountActionError(null);
    if (!session?.access_token || !activeFamilyId) {
      setAccountActionError("Selecione uma familia ativa.");
      return;
    }
    setAccountActionLoadingId(account.id);
    const currentBalance = await getAccountBalanceForArchive(account);
    if (currentBalance === null) {
      setAccountActionError("Nao foi possivel verificar o saldo da conta.");
      setAccountActionLoadingId(null);
      return;
    }
    if (Math.abs(currentBalance) > 0.009) {
      setAccountActionError(
        `Para arquivar, o saldo precisa estar zerado. Saldo atual: ${currencyFormatter.format(currentBalance)}`,
      );
      setAccountActionLoadingId(null);
      return;
    }
    if (!window.confirm(`Arquivar a conta "${account.name}"?`)) {
      setAccountActionLoadingId(null);
      return;
    }
    const { error } = await supabase
      .from("accounts")
      .update({ is_archived: true })
      .eq("id", account.id);
    if (error) {
      setAccountActionError(error.message);
      setAccountActionLoadingId(null);
      return;
    }
    await loadAccounts(activeFamilyId);
    if (showArchivedAccounts) {
      await loadArchivedAccounts(activeFamilyId);
    }
    setOpenAccountMenuId(null);
    setAccountActionLoadingId(null);
  };

  const handleUnarchiveAccount = async (account: Account) => {
    setAccountActionError(null);
    if (!session?.access_token || !activeFamilyId) {
      setAccountActionError("Selecione uma familia ativa.");
      return;
    }
    setAccountActionLoadingId(account.id);
    const { error } = await supabase
      .from("accounts")
      .update({ is_archived: false })
      .eq("id", account.id);
    if (error) {
      setAccountActionError(error.message);
      setAccountActionLoadingId(null);
      return;
    }
    await loadAccounts(activeFamilyId);
    await loadArchivedAccounts(activeFamilyId);
    setAccountActionLoadingId(null);
  };

  const handleOpenAccountMenu = async (accountId: string) => {
    setAccountActionError(null);
    if (openAccountMenuId === accountId) {
      setOpenAccountMenuId(null);
      return;
    }
    setOpenAccountMenuId(accountId);

    if (accountTxnCounts[accountId] === undefined) {
      const count = await getAccountTransactionCount(accountId);
      if (count !== null) {
        setAccountTxnCounts((prev) => ({ ...prev, [accountId]: count }));
      }
    }
  };

  return (
    <>
      <Header />
      <main className="flex flex-col gap-4 sm:gap-6">
        <section className="rounded-3xl border border-[var(--border)] bg-white/80 px-3 py-4 shadow-sm sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold uppercase tracking-[0.3em] text-[var(--muted)]">
                Contas
              </h3>
              <p className="mt-2 text-sm text-[var(--muted)]">
                Gerencie suas contas e crie lancamentos diretos.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex items-center gap-2 rounded-full border border-[var(--border)] bg-white px-3 py-2 text-xs font-semibold text-[var(--muted)]">
                <span>Saldo total</span>
                <span
                  className={`text-sm ${
                    totalBalance < 0
                      ? "text-rose-600"
                      : totalBalance > 0
                        ? "text-emerald-600"
                        : "text-slate-600"
                  }`}
                >
                  {currencyFormatter.format(totalBalance)}
                </span>
              </div>
              <button
                type="button"
                onClick={() => setShowArchivedAccounts((prev) => !prev)}
                className={`inline-flex items-center justify-center rounded-full border px-4 py-2 text-xs font-semibold transition ${
                  showArchivedAccounts
                    ? "border-[var(--accent)] text-[var(--accent)]"
                    : "border-[var(--border)] text-[var(--ink)] hover:border-[var(--accent)]"
                }`}
              >
                {showArchivedAccounts ? "Ocultar arquivadas" : "Ver arquivadas"}
              </button>
              <button
                type="button"
                onClick={openAccountModal}
                className="inline-flex items-center justify-center rounded-full border border-[var(--border)] bg-white px-4 py-2 text-xs font-semibold text-[var(--ink)] transition hover:border-[var(--accent)]"
              >
                Nova conta
              </button>
            </div>
          </div>

          {accountActionError ? (
            <div className="mt-3 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
              {accountActionError}
            </div>
          ) : null}

          <div className="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {accounts.map((account) => {
              const balance = accountBalances[account.id] ?? 0;
              const transactionCount = accountTxnCounts[account.id];
              const hasTransactions = typeof transactionCount === "number" ? transactionCount > 0 : null;
              const isCountLoading = openAccountMenuId === account.id && transactionCount === undefined;
              const isActionLoading = accountActionLoadingId === account.id;
              const valueTone = balance < 0 ? "text-rose-600" : "text-emerald-600";
              const iconKey = account.icon_key ?? "initials";
              const iconOption = accountIconLookup[iconKey];
              const iconBg = account.icon_bg ?? "var(--accent-soft)";
              const iconColor = account.icon_color ?? "var(--accent-strong)";
              const shouldShowInitials = iconKey === "initials" || (!iconOption?.icon && !iconOption?.imageSrc);
              const isLogo = Boolean(iconOption?.imageSrc);

              return (
                <div
                  key={account.id}
                  className="rounded-3xl border border-[var(--border)] bg-white p-5 shadow-sm"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-3">
                      <span
                        className="flex h-10 w-10 items-center justify-center rounded-full text-sm font-semibold"
                        style={{ backgroundColor: iconBg, color: iconColor }}
                      >
                        {isLogo ? (
                          <img
                            src={iconOption?.imageSrc}
                            alt={iconOption?.label ?? account.name}
                            className="h-5 w-5 object-contain"
                            loading="lazy"
                          />
                        ) : shouldShowInitials ? (
                          account.name.slice(0, 2).toUpperCase()
                        ) : (
                          iconOption?.icon?.({ className: "h-5 w-5" })
                        )}
                      </span>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-[var(--ink)]">
                          {account.name}
                        </p>
                        <p className="text-xs text-[var(--muted)]">
                          {account.account_type.replace("_", " ")}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => openAccountTransactions(account.id)}
                        className="flex h-8 w-8 items-center justify-center rounded-full border border-[var(--border)] text-[var(--muted)] transition hover:border-[var(--accent)] hover:text-[var(--ink)]"
                        aria-label="Ver lancamentos da conta"
                      >
                        <svg
                          aria-hidden="true"
                          viewBox="0 0 24 24"
                          className="h-4 w-4"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d="M8 6h13" />
                          <path d="M8 12h13" />
                          <path d="M8 18h13" />
                          <circle cx="3" cy="6" r="1" />
                          <circle cx="3" cy="12" r="1" />
                          <circle cx="3" cy="18" r="1" />
                        </svg>
                      </button>
                      <div className="relative" data-account-menu-id={account.id}>
                        <button
                          type="button"
                          onClick={() => handleOpenAccountMenu(account.id)}
                          className="flex h-8 w-8 items-center justify-center rounded-full border border-[var(--border)] text-[var(--muted)] transition hover:border-[var(--accent)] hover:text-[var(--ink)]"
                          aria-label="Opcoes da conta"
                          aria-expanded={openAccountMenuId === account.id}
                        >
                          <svg
                            aria-hidden="true"
                            viewBox="0 0 24 24"
                            className="h-4 w-4"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <circle cx="12" cy="12" r="1.5" />
                            <circle cx="19" cy="12" r="1.5" />
                            <circle cx="5" cy="12" r="1.5" />
                          </svg>
                        </button>
                        {openAccountMenuId === account.id ? (
                          <div className="absolute right-0 z-20 mt-2 w-44 rounded-2xl border border-[var(--border)] bg-white p-2 text-sm text-[var(--ink)] shadow-lg">
                            <button
                              type="button"
                              onClick={() => {
                                setOpenAccountMenuId(null);
                                openAccountStatement(account.id);
                              }}
                              disabled={isActionLoading}
                              className="flex w-full items-center justify-between rounded-xl px-3 py-2 text-left text-sm font-semibold text-[var(--ink)] transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
                            >
                              Ver extrato
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setOpenAccountMenuId(null);
                                openAccountEditor(account);
                              }}
                              disabled={isActionLoading}
                              className="flex w-full items-center justify-between rounded-xl px-3 py-2 text-left text-sm font-semibold text-[var(--ink)] transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
                            >
                              Editar conta
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setOpenAccountMenuId(null);
                                handleArchiveAccount(account);
                              }}
                              disabled={isActionLoading}
                              className="flex w-full items-center justify-between rounded-xl px-3 py-2 text-left text-sm font-semibold text-[var(--ink)] transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
                            >
                              {isActionLoading ? "Arquivando..." : "Arquivar conta"}
                            </button>
                            {isCountLoading ? (
                              <div className="px-3 py-2 text-xs font-semibold text-[var(--muted)]">
                                Verificando lancamentos...
                              </div>
                            ) : hasTransactions === false ? (
                              <button
                                type="button"
                                onClick={() => {
                                  setOpenAccountMenuId(null);
                                  handleDeleteAccount(account);
                                }}
                                disabled={isActionLoading}
                                className="flex w-full items-center justify-between rounded-xl px-3 py-2 text-left text-sm font-semibold text-rose-600 transition hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-60"
                              >
                                {isActionLoading ? "Excluindo..." : "Excluir conta"}
                              </button>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </div>

                  <div className="mt-4 space-y-2 text-sm">
                    <div className="flex items-center justify-between text-[var(--muted)]">
                      <span>Saldo atual</span>
                      <span className={`font-semibold ${valueTone}`}>
                        {currencyFormatter.format(balance)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between text-xs text-[var(--muted)]">
                      <span>Ate {monthLabel}</span>
                      <span className="flex items-center gap-1.5">
                        <span
                          className={
                            account.visibility === "private"
                              ? "text-amber-600"
                              : "text-emerald-600"
                          }
                        >
                          {account.visibility === "private" ? "Privada" : "Compartilhada"}
                        </span>
                        {account.is_reconcilable ? (
                          <span className="rounded-full bg-sky-100 px-1.5 py-0.5 text-[10px] font-semibold text-sky-700">
                            Reconciliável
                          </span>
                        ) : null}
                      </span>
                    </div>
                    {account.is_reconcilable && account.reconciled_until ? (
                      <div className="flex items-center justify-between text-xs text-[var(--muted)]">
                        <span>Ultimo extrato</span>
                        <span className="font-semibold text-[var(--ink)]">
                          {shortDateFormatter.format(new Date(account.reconciled_until + "T12:00:00Z"))}
                        </span>
                      </div>
                    ) : null}
                    {account.is_reconcilable && account.reconciled_balance != null ? (
                      <div className="flex items-center justify-between text-xs text-[var(--muted)]">
                        <span>Saldo banco</span>
                        <span className="font-semibold text-[var(--ink)]">
                          {currencyFormatter.format(account.reconciled_balance)}
                        </span>
                      </div>
                    ) : null}
                    {discrepancies[account.id] ? (
                      <div className="flex items-center justify-between gap-2 rounded-xl border border-amber-200 bg-amber-50 px-2.5 py-1.5">
                        <span className="text-xs font-semibold text-amber-700">
                          Divergencia: {currencyFormatter.format(discrepancies[account.id].difference)}
                        </span>
                        <button
                          type="button"
                          onClick={() => handleQuickAdjust(account)}
                          disabled={adjustingAccountId === account.id}
                          className="rounded-lg border border-amber-300 bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-800 transition hover:bg-amber-200 disabled:opacity-50"
                        >
                          {adjustingAccountId === account.id ? "Ajustando..." : "Ajustar"}
                        </button>
                      </div>
                    ) : null}
                  </div>

                  <div className="mt-4 flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => openTransactionModal("expense")}
                      className="flex h-10 flex-1 items-center justify-center gap-2 rounded-xl border border-rose-200 bg-rose-50 text-xs font-semibold text-rose-600 transition hover:border-rose-300"
                    >
                      <svg
                        aria-hidden="true"
                        viewBox="0 0 24 24"
                        className="h-4 w-4"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M12 19V5" />
                        <path d="M18 13l-6 6-6-6" />
                      </svg>
                      Despesa
                    </button>
                    <button
                      type="button"
                      onClick={() => openTransactionModal("income")}
                      className="flex h-10 flex-1 items-center justify-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 text-xs font-semibold text-emerald-600 transition hover:border-emerald-300"
                    >
                      <svg
                        aria-hidden="true"
                        viewBox="0 0 24 24"
                        className="h-4 w-4"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M12 5v14" />
                        <path d="M18 11l-6-6-6 6" />
                      </svg>
                      Receita
                    </button>
                    <button
                      type="button"
                      onClick={() => openTransactionModal("transfer")}
                      className="flex h-10 flex-1 items-center justify-center gap-2 rounded-xl border border-sky-200 bg-sky-50 text-xs font-semibold text-sky-600 transition hover:border-sky-300"
                    >
                      <svg
                        aria-hidden="true"
                        viewBox="0 0 24 24"
                        className="h-4 w-4"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M16 3h5v5" />
                        <path d="M4 20l5-5" />
                        <path d="M21 3l-7 7" />
                        <path d="M9 15l-5 5" />
                      </svg>
                      Transferir
                    </button>
                  </div>
                </div>
              );
            })}

            <button
              type="button"
              onClick={openAccountModal}
              className="flex min-h-[190px] flex-col items-center justify-center gap-3 rounded-3xl border border-dashed border-[var(--border)] bg-white/70 p-6 text-[var(--muted)] transition hover:border-[var(--accent)] hover:text-[var(--accent-strong)]"
            >
              <span className="flex h-12 w-12 items-center justify-center rounded-full border border-current">
                <svg
                  aria-hidden="true"
                  viewBox="0 0 24 24"
                  className="h-5 w-5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M12 5v14" />
                  <path d="M5 12h14" />
                </svg>
              </span>
              <span className="text-sm font-semibold uppercase tracking-[0.2em]">
                Nova conta
              </span>
            </button>
          </div>

          {showArchivedAccounts ? (
            <div className="mt-8">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h4 className="text-xs font-semibold uppercase tracking-[0.3em] text-[var(--muted)]">
                  Arquivadas
                </h4>
                <span className="text-xs font-semibold text-[var(--muted)]">
                  {isLoadingArchivedAccounts
                    ? "Carregando..."
                    : `${archivedAccounts.length} conta(s)`}
                </span>
              </div>
              {archivedAccounts.length === 0 && !isLoadingArchivedAccounts ? (
                <p className="mt-3 text-sm text-[var(--muted)]">
                  Nenhuma conta arquivada.
                </p>
              ) : null}
              <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {archivedAccounts.map((account) => (
                  <div
                    key={account.id}
                    className="rounded-3xl border border-dashed border-[var(--border)] bg-white/60 p-5 text-[var(--muted)]"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-[var(--ink)]">
                          {account.name}
                        </p>
                        <p className="text-xs text-[var(--muted)]">
                          {account.account_type.replace("_", " ")}
                        </p>
                      </div>
                      <span className="rounded-full border border-[var(--border)] bg-white px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">
                        Arquivada
                      </span>
                    </div>
                    <div className="mt-4 flex items-center justify-between text-xs text-[var(--muted)]">
                      <span>Saldo final</span>
                      <span className="font-semibold text-[var(--ink)]">
                        {currencyFormatter.format(0)}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleUnarchiveAccount(account)}
                      disabled={accountActionLoadingId === account.id}
                      className="mt-4 inline-flex w-full items-center justify-center rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-xs font-semibold text-[var(--ink)] transition hover:border-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {accountActionLoadingId === account.id
                        ? "Reativando..."
                        : "Reativar conta"}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </section>
      </main>

      <AccountModal
        isOpen={isAccountModalOpen}
        onClose={closeAccountModal}
        editingAccount={editingAccount}
      />
    </>
  );
}

function getMonthRange(monthValue: string) {
  const [year, month] = monthValue.split("-").map(Number);
  if (!year || !month) {
    return { startDate: "", endDate: "" };
  }

  const paddedMonth = String(month).padStart(2, "0");
  const endDay = new Date(year, month, 0).getDate();

  return {
    startDate: `${year}-${paddedMonth}-01`,
    endDate: `${year}-${paddedMonth}-${String(endDay).padStart(2, "0")}`,
  };
}

"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useApp } from "@/contexts/AppContext";
import { Header } from "@/components/layout/Header";
import { DonutChart, buildDonutSegments } from "@/components/charts/DonutChart";
import { CashflowChart } from "@/components/charts/CashflowChart";
import { getSupabaseClient } from "@/lib/supabase/client";
import { checkAccountDiscrepancy, type BalanceDiscrepancy } from "@/lib/balance-checker";
import {
  getMonthRange,
  isDateOnly,
  toBrazilDateKey,
  addDaysToBrazilDate,
  parseBrazilDate,
} from "@/lib/date-utils";
import {
  currencyFormatter,
  shortDateFormatter,
  formatCompactBRL,
  BRAZIL_TZ,
} from "@/lib/formatters";
import {
  accountIconLookup,
} from "@/constants/icons";
import {
  DEFAULT_ACCOUNT_ICON_BG,
  DEFAULT_ACCOUNT_ICON_COLOR,
  DEFAULT_CATEGORY_ICON_BG,
  DEFAULT_CATEGORY_ICON_COLOR,
} from "@/constants/styles";
import type { DashboardCategoryDatum, DashboardCashflowPoint } from "@/types";

const supabase = getSupabaseClient();

type Transaction = {
  id: string;
  amount: string;
  personal_amount: string | null;
  description: string | null;
  posted_at: string;
  source: string | null;
  account: { id: string; name: string } | null;
  category: { id: string; name: string; category_type: string } | null;
};

export default function DashboardPage() {
  const {
    session,
    activeFamilyId,
    accounts,
    categories,
    accountBalances,
    isLoadingBalances,
    activeMonth,
    dataRefreshCounter,
  } = useApp();

  // Alert counts
  const [uncategorizedOfxCount, setUncategorizedOfxCount] = useState(0);
  const [unreconciledManualCount, setUnreconciledManualCount] = useState(0);
  const [discrepancies, setDiscrepancies] = useState<BalanceDiscrepancy[]>([]);

  // Dashboard-specific state
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [isLoadingTransactions, setIsLoadingTransactions] = useState(false);
  const [monthlySummary, setMonthlySummary] = useState({ income: 0, expense: 0, count: 0 });
  const [dashboardExpenseData, setDashboardExpenseData] = useState<DashboardCategoryDatum[]>([]);
  const [dashboardIncomeData, setDashboardIncomeData] = useState<DashboardCategoryDatum[]>([]);
  const [dashboardCashflowPoints, setDashboardCashflowPoints] = useState<DashboardCashflowPoint[]>([]);
  const [isLoadingDashboardAnalytics, setIsLoadingDashboardAnalytics] = useState(false);

  // Load transactions for dashboard
  useEffect(() => {
    if (!activeFamilyId || !session?.access_token || accounts.length === 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Intentional: reset on missing data
      setTransactions([]);
      return;
    }

    const monthRange = getMonthRange(activeMonth);
    const loadTransactions = async () => {
      setIsLoadingTransactions(true);
      const { data, error } = await supabase
        .from("transactions")
        .select(
          "id, amount, personal_amount, description, posted_at, source, account:accounts(id, name), category:categories(id, name, category_type)",
        )
        .in("account_id", accounts.map((a) => a.id))
        .gte("posted_at", monthRange.startDate)
        .lte("posted_at", monthRange.endDate)
        .order("posted_at", { ascending: false })
        .order("created_at", { ascending: false })
        .range(0, 7);

      if (error) {
        setTransactions([]);
        setIsLoadingTransactions(false);
        return;
      }

      setTransactions(
        (data ?? []).map((item) => {
          const account = item.account as unknown as { id: string; name: string } | null;
          const category = item.category as unknown as { id: string; name: string; category_type: string } | null;
          return {
            id: item.id,
            amount: item.amount,
            personal_amount: (item as Record<string, unknown>).personal_amount as string | null,
            description: item.description,
            posted_at: item.posted_at,
            source: item.source,
            account: account ? { id: account.id, name: account.name } : null,
            category: category
              ? { id: category.id, name: category.name, category_type: category.category_type }
              : null,
          };
        }),
      );
      setIsLoadingTransactions(false);
    };

    loadTransactions();
  }, [activeFamilyId, session?.access_token, accounts, activeMonth, dataRefreshCounter]);

  // Load monthly summary
  useEffect(() => {
    if (!activeFamilyId || !session?.access_token || accounts.length === 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Intentional: reset on missing data
      setMonthlySummary({ income: 0, expense: 0, count: 0 });
      return;
    }

    const monthRange = getMonthRange(activeMonth);
    const loadSummary = async () => {
      const { data, error } = await supabase
        .from("transactions")
        .select("amount, personal_amount, source")
        .in("account_id", accounts.map((a) => a.id))
        .gte("posted_at", monthRange.startDate)
        .lte("posted_at", monthRange.endDate);

      if (error) {
        setMonthlySummary({ income: 0, expense: 0, count: 0 });
        return;
      }

      let income = 0;
      let expense = 0;

      (data ?? []).forEach((item) => {
        if (item.source === "transfer") return;

        const effectiveAmount = item.personal_amount != null ? Number(item.personal_amount) : Number(item.amount);
        if (!Number.isFinite(effectiveAmount)) return;

        if (effectiveAmount > 0) {
          income += effectiveAmount;
        } else if (effectiveAmount < 0) {
          expense += Math.abs(effectiveAmount);
        }
      });

      setMonthlySummary({ income, expense, count: data?.length ?? 0 });
    };

    loadSummary();
  }, [activeFamilyId, session?.access_token, accounts, activeMonth, dataRefreshCounter]);

  // Load alert counts (uncategorized OFX + unreconciled manuals + discrepancies)
  useEffect(() => {
    if (!activeFamilyId || !session?.access_token) {
      /* eslint-disable react-hooks/set-state-in-effect -- Intentional: reset on missing data */
      setUncategorizedOfxCount(0);
      setUnreconciledManualCount(0);
      setDiscrepancies([]);
      /* eslint-enable react-hooks/set-state-in-effect */
      return;
    }

    const loadAlerts = async () => {
      const [ofxRes, manualRes] = await Promise.all([
        supabase.rpc("uncategorized_ofx_count", { family_uuid: activeFamilyId }),
        supabase.rpc("unreconciled_manual_count", { family_uuid: activeFamilyId }),
      ]);
      setUncategorizedOfxCount(Number(ofxRes.data) || 0);
      setUnreconciledManualCount(Number(manualRes.data) || 0);

      // Check balance discrepancies for reconcilable accounts
      const reconcilable = accounts.filter(
        (a) => a.is_reconcilable && a.reconciled_balance != null && a.reconciled_until,
      );
      if (reconcilable.length > 0) {
        const results = await Promise.all(reconcilable.map((a) => checkAccountDiscrepancy(a)));
        setDiscrepancies(results.filter((d): d is BalanceDiscrepancy => d != null));
      } else {
        setDiscrepancies([]);
      }
    };

    loadAlerts();
  }, [activeFamilyId, session?.access_token, accounts, dataRefreshCounter]);

  // Load dashboard analytics
  useEffect(() => {
    if (!activeFamilyId || !session?.access_token || accounts.length === 0) {
      /* eslint-disable react-hooks/set-state-in-effect -- Intentional: reset on missing data */
      setDashboardExpenseData([]);
      setDashboardIncomeData([]);
      setDashboardCashflowPoints([]);
      /* eslint-enable react-hooks/set-state-in-effect */
      return;
    }

    const monthRange = getMonthRange(activeMonth);
    if (!monthRange.startDate || !monthRange.endDate) return;

    let cancelled = false;
    const loadAnalytics = async () => {
      setIsLoadingDashboardAnalytics(true);

      const { data, error } = await supabase
        .from("transactions")
        .select(
          "amount, personal_amount, source, posted_at, category:categories(id, name, category_type, parent_id, icon_bg, icon_color)",
        )
        .in("account_id", accounts.map((a) => a.id))
        .gte("posted_at", monthRange.startDate)
        .lte("posted_at", monthRange.endDate)
        .order("posted_at", { ascending: true })
        .range(0, 4999);

      if (cancelled) return;

      if (error) {
        setDashboardExpenseData([]);
        setDashboardIncomeData([]);
        setDashboardCashflowPoints([]);
        setIsLoadingDashboardAnalytics(false);
        return;
      }

      // Color utilities
      const hslToHex = (hue: number, saturation: number, lightness: number) => {
        const s = saturation / 100;
        const l = lightness / 100;
        const c = (1 - Math.abs(2 * l - 1)) * s;
        const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
        const m = l - c / 2;
        let r = 0, g = 0, b = 0;
        if (hue < 60) { r = c; g = x; }
        else if (hue < 120) { r = x; g = c; }
        else if (hue < 180) { g = c; b = x; }
        else if (hue < 240) { g = x; b = c; }
        else if (hue < 300) { r = x; b = c; }
        else { r = c; b = x; }
        const toByte = (value: number) => Math.round((value + m) * 255).toString(16).padStart(2, "0");
        return `#${toByte(r)}${toByte(g)}${toByte(b)}`.toUpperCase();
      };

      const stableColorForId = (id: string) => {
        let hash = 0;
        for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
        return hslToHex(hash % 360, 72, 48);
      };

      const pickColor = (id: string, bg?: string | null, color?: string | null) => {
        if (bg && bg !== DEFAULT_CATEGORY_ICON_BG) return bg;
        if (color && color !== DEFAULT_CATEGORY_ICON_COLOR) return color;
        return stableColorForId(id);
      };

      const expenseMap = new Map<string, DashboardCategoryDatum>();
      const incomeMap = new Map<string, DashboardCategoryDatum>();
      const dailyNet = new Map<string, number>();

      const addDaily = (date: string, delta: number) => {
        if (!Number.isFinite(delta)) return;
        dailyNet.set(date, (dailyNet.get(date) ?? 0) + delta);
      };

      (data ?? []).forEach((row) => {
        const rawAmount = Number(row.amount);
        if (!Number.isFinite(rawAmount)) return;

        const postedAt = typeof row.posted_at === "string" ? row.posted_at : "";
        const dayKey = postedAt
          ? isDateOnly(postedAt)
            ? postedAt
            : toBrazilDateKey(postedAt)
          : monthRange.startDate;

        if (row.source === "transfer") return;
        if (row.source === "adjustment") {
          addDaily(dayKey, rawAmount);
          return;
        }

        const effectiveAmount = row.personal_amount != null ? Number(row.personal_amount) : rawAmount;
        if (!Number.isFinite(effectiveAmount)) return;

        // personal_amount = 0 means fully ignored from totals
        if (effectiveAmount === 0 && row.personal_amount != null) return;

        const category = row.category as unknown as {
          id: string;
          name: string;
          category_type: string;
          parent_id?: string | null;
          icon_bg?: string | null;
          icon_color?: string | null;
        } | null;

        if (!category?.id) return;

        const categoryEntry = categories.find((c) => c.id === category.id);
        const parentId = categoryEntry?.parent_id ?? null;
        const parentName = parentId ? categories.find((c) => c.id === parentId)?.name ?? "" : "";
        const label = parentName ? `${parentName} / ${category.name}` : category.name;
        const color = pickColor(category.id, category.icon_bg, category.icon_color);

        if (category.category_type === "income") {
          incomeMap.set(category.id, {
            id: category.id,
            label,
            color,
            value: (incomeMap.get(category.id)?.value ?? 0) + Math.abs(effectiveAmount),
          });
        } else if (category.category_type === "expense") {
          expenseMap.set(category.id, {
            id: category.id,
            label,
            color,
            value: (expenseMap.get(category.id)?.value ?? 0) + Math.abs(effectiveAmount),
          });
        }

        addDaily(dayKey, effectiveAmount);
      });

      const expenseSegments = buildDonutSegments(Array.from(expenseMap.values()));
      const incomeSegments = buildDonutSegments(Array.from(incomeMap.values()));

      const dayPoints: DashboardCashflowPoint[] = [];
      let cursor = monthRange.startDate;
      let running = 0;
      while (cursor <= monthRange.endDate) {
        running += dailyNet.get(cursor) ?? 0;
        dayPoints.push({ date: cursor, value: running });
        cursor = addDaysToBrazilDate(cursor, 1);
      }

      setDashboardExpenseData(expenseSegments);
      setDashboardIncomeData(incomeSegments);
      setDashboardCashflowPoints(dayPoints);
      setIsLoadingDashboardAnalytics(false);
    };

    loadAnalytics();
    return () => { cancelled = true; };
  }, [activeFamilyId, session?.access_token, accounts, categories, activeMonth, dataRefreshCounter]);

  // Computed values
  const totalBalance = Object.values(accountBalances).reduce((sum, val) => sum + (Number.isFinite(val) ? val : 0), 0);
  const monthResult = monthlySummary.income - monthlySummary.expense;
  const topAccountsByBalance = [...accounts]
    .map((a) => ({ ...a, balance: accountBalances[a.id] ?? 0 }))
    .sort((a, b) => b.balance - a.balance)
    .slice(0, 5);

  // Month label
  const monthDate = parseBrazilDate(`${activeMonth}-01`);
  const monthLabel = Number.isNaN(monthDate.getTime())
    ? activeMonth
    : new Intl.DateTimeFormat("pt-BR", { month: "long", year: "numeric", timeZone: BRAZIL_TZ })
        .format(monthDate)
        .replace(/^./, (c) => c.toUpperCase());

  // Formatting helpers
  const balanceValueTone = totalBalance < 0 ? "text-rose-100" : totalBalance > 0 ? "text-emerald-100" : "text-white";
  const resultValueTone = monthResult < 0 ? "text-rose-100" : monthResult > 0 ? "text-emerald-100" : "text-white";
  const balanceDisplay = `${totalBalance > 0 ? "+ " : totalBalance < 0 ? "- " : ""}${currencyFormatter.format(Math.abs(totalBalance))}`;
  const resultDisplay = `${monthResult > 0 ? "+ " : monthResult < 0 ? "- " : ""}${currencyFormatter.format(Math.abs(monthResult))}`;
  const balanceIndicator = totalBalance < 0
    ? { label: "Negativo", dot: "bg-rose-500", text: "text-rose-700" }
    : totalBalance > 0
      ? { label: "Positivo", dot: "bg-emerald-500", text: "text-emerald-700" }
      : { label: "Zerado", dot: "bg-slate-300", text: "text-slate-600" };
  const resultIndicator = monthResult < 0
    ? { label: "Negativo", dot: "bg-rose-500", text: "text-rose-700" }
    : monthResult > 0
      ? { label: "Positivo", dot: "bg-emerald-500", text: "text-emerald-700" }
      : { label: "Zerado", dot: "bg-slate-300", text: "text-slate-600" };

  const renderAccountIcon = (account: { name: string; icon_key: string | null; icon_bg: string | null; icon_color: string | null }) => {
    const iconKey = account.icon_key ?? "initials";
    const iconOption = accountIconLookup[iconKey];
    const iconBg = account.icon_bg ?? DEFAULT_ACCOUNT_ICON_BG;
    const iconColor = account.icon_color ?? DEFAULT_ACCOUNT_ICON_COLOR;
    const shouldShowInitials = iconKey === "initials" || (!iconOption?.icon && !iconOption?.imageSrc);
    const isLogo = Boolean(iconOption?.imageSrc);

    return (
      <span className="flex h-10 w-10 items-center justify-center rounded-full" style={{ backgroundColor: iconBg, color: iconColor }}>
        {isLogo ? (
          <img src={iconOption?.imageSrc} alt={iconOption?.label ?? account.name} className="h-5 w-5 object-contain" loading="lazy" />
        ) : shouldShowInitials ? (
          <span className="text-sm font-semibold">{account.name.slice(0, 2).toUpperCase()}</span>
        ) : iconOption?.icon ? (
          iconOption.icon({ className: "h-5 w-5" })
        ) : (
          <span className="text-sm font-semibold">{account.name.slice(0, 2).toUpperCase()}</span>
        )}
      </span>
    );
  };

  const getCategoryDisplayLabel = (categoryId?: string | null, fallbackName?: string | null) => {
    if (!categoryId) return fallbackName ?? "Categoria";
    const category = categories.find((c) => c.id === categoryId);
    if (!category) return fallbackName ?? "Categoria";
    if (!category.parent_id) return category.name;
    const parent = categories.find((c) => c.id === category.parent_id);
    return parent ? `${parent.name} / ${category.name}` : category.name;
  };

  return (
    <>
      <Header />
      <main className="flex min-w-0 flex-col gap-4 sm:gap-6">
        {/* Summary cards */}
        <section className="grid gap-3 sm:gap-4 md:grid-cols-2 xl:grid-cols-4 overflow-hidden">
          <div className="min-w-0 overflow-hidden rounded-2xl bg-gradient-to-br from-sky-500 to-sky-600 px-3 py-4 text-white shadow-sm sm:p-4">
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold uppercase tracking-[0.3em] text-sky-100">Saldo nas contas</p>
              <span className={`inline-flex items-center gap-1 rounded-full bg-white/90 px-2 py-0.5 text-[10px] font-semibold ${balanceIndicator.text}`}>
                <span className={`h-2 w-2 rounded-full ${balanceIndicator.dot}`} />
                {balanceIndicator.label}
              </span>
            </div>
            <p className={`mt-2 text-2xl font-semibold ${balanceValueTone}`}>{balanceDisplay}</p>
            <p className="mt-1 text-xs text-sky-100">Até {monthLabel}</p>
          </div>
          <div className="min-w-0 overflow-hidden rounded-2xl bg-gradient-to-br from-emerald-500 to-emerald-600 px-3 py-4 text-white shadow-sm sm:p-4">
            <p className="text-xs font-semibold uppercase tracking-[0.3em] text-emerald-100">Receitas</p>
            <p className="mt-2 text-2xl font-semibold">{currencyFormatter.format(monthlySummary.income)}</p>
            <p className="mt-1 text-xs text-emerald-100">Período: {monthLabel}</p>
          </div>
          <div className="min-w-0 overflow-hidden rounded-2xl bg-gradient-to-br from-rose-500 to-rose-600 px-3 py-4 text-white shadow-sm sm:p-4">
            <p className="text-xs font-semibold uppercase tracking-[0.3em] text-rose-100">Despesas</p>
            <p className="mt-2 text-2xl font-semibold">{currencyFormatter.format(monthlySummary.expense)}</p>
            <p className="mt-1 text-xs text-rose-100">Período: {monthLabel}</p>
          </div>
          <div className="min-w-0 overflow-hidden rounded-2xl bg-gradient-to-br from-amber-500 to-amber-600 px-3 py-4 text-white shadow-sm sm:p-4">
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold uppercase tracking-[0.3em] text-amber-100">Resultado do mês</p>
              <span className={`inline-flex items-center gap-1 rounded-full bg-white/90 px-2 py-0.5 text-[10px] font-semibold ${resultIndicator.text}`}>
                <span className={`h-2 w-2 rounded-full ${resultIndicator.dot}`} />
                {resultIndicator.label}
              </span>
            </div>
            <p className={`mt-2 text-2xl font-semibold ${resultValueTone}`}>{resultDisplay}</p>
            <p className="mt-1 text-xs text-amber-100">Período: {monthLabel}</p>
          </div>
        </section>

        {/* Alerts */}
        {(uncategorizedOfxCount > 0 || unreconciledManualCount > 0 || discrepancies.length > 0) ? (
          <section className="flex flex-col gap-3">
            {discrepancies.length > 0 ? (
              <Link
                href="/reconciliacao"
                className="flex items-center gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 transition hover:border-amber-300"
              >
                <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5 shrink-0 text-amber-500" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                  <line x1="12" y1="9" x2="12" y2="13" />
                  <line x1="12" y1="17" x2="12.01" y2="17" />
                </svg>
                <span>
                  <span className="font-semibold">{discrepancies.length}</span> conta(s) com divergencia de saldo
                </span>
              </Link>
            ) : null}
            {uncategorizedOfxCount > 0 ? (
              <Link
                href="/lancamentos?filter=uncategorized"
                className="flex items-center gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 transition hover:border-amber-300"
              >
                <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5 shrink-0 text-amber-500" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M7 7h7l5 5-7 7-5-5V7z" />
                  <circle cx="10" cy="10" r="1.2" />
                </svg>
                <span>
                  <span className="font-semibold">{uncategorizedOfxCount}</span> transacao(oes) importada(s) sem categoria
                </span>
              </Link>
            ) : null}
            {unreconciledManualCount > 0 ? (
              <Link
                href="/reconciliacao"
                className="flex items-center gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 transition hover:border-amber-300"
              >
                <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5 shrink-0 text-amber-500" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
                </svg>
                <span>
                  <span className="font-semibold">{unreconciledManualCount}</span> transacao(oes) manual(is) sem reconciliar
                </span>
              </Link>
            ) : null}
          </section>
        ) : null}

        {/* Accounts and transactions */}
        <section className="grid min-w-0 gap-4 sm:gap-6 xl:grid-cols-2">
          {/* Top accounts by balance */}
          <div className="min-w-0 overflow-hidden rounded-3xl border border-[var(--border)] bg-white/80 px-2 py-4 shadow-sm sm:p-6">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="pl-1 sm:pl-0">
                <h3 className="text-base font-semibold uppercase tracking-[0.2em] text-[var(--ink)] sm:text-lg sm:tracking-[0.24em]">
                  Contas com maior saldo
                </h3>
                <p className="mt-1 text-sm text-[var(--muted)]">Até {monthLabel}</p>
              </div>
            </div>
            <div className="mt-4 space-y-3">
              {isLoadingBalances ? (
                <p className="text-sm text-[var(--muted)]">Calculando saldos...</p>
              ) : topAccountsByBalance.length === 0 ? (
                <p className="text-sm text-[var(--muted)]">Nenhuma conta criada ainda.</p>
              ) : (
                topAccountsByBalance.map((account) => {
                  const tone = account.balance < 0 ? "text-rose-600" : account.balance > 0 ? "text-emerald-600" : "text-[var(--muted)]";
                  return (
                    <Link
                      key={account.id}
                      href="/contas"
                      className="flex w-full min-w-0 items-center justify-between gap-3 overflow-hidden rounded-2xl border border-[var(--border)] bg-white px-4 py-3 text-left shadow-sm transition hover:border-[var(--accent)]"
                    >
                      <div className="flex min-w-0 flex-1 items-center gap-3">
                        {renderAccountIcon(account)}
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold text-[var(--ink)]">{account.name}</p>
                          <p className="text-xs text-[var(--muted)]">{account.account_type}</p>
                        </div>
                      </div>
                      <span className={`shrink-0 max-w-[110px] truncate text-right text-sm font-semibold tabular-nums ${tone}`} title={currencyFormatter.format(account.balance)}>
                        <span className="sm:hidden">{formatCompactBRL(account.balance)}</span>
                        <span className="hidden sm:inline">{currencyFormatter.format(account.balance)}</span>
                      </span>
                    </Link>
                  );
                })
              )}
            </div>
            {!isLoadingBalances && topAccountsByBalance.length > 0 ? (
              <Link
                href="/contas"
                className="mt-4 inline-flex w-full items-center justify-center rounded-2xl border border-[var(--border)] bg-white px-4 py-3 text-sm font-semibold text-[var(--ink)] shadow-sm transition hover:border-[var(--accent)]"
              >
                Ver todas as contas
              </Link>
            ) : null}
          </div>

          {/* Latest transactions */}
          <div className="min-w-0 overflow-hidden rounded-3xl border border-[var(--border)] bg-white/80 px-2 py-4 shadow-sm sm:p-6">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="pl-1 sm:pl-0">
                <h3 className="text-base font-semibold uppercase tracking-[0.2em] text-[var(--ink)] sm:text-lg sm:tracking-[0.24em]">
                  Últimas transações
                </h3>
                <p className="mt-1 text-sm text-[var(--muted)]">{monthLabel}</p>
              </div>
            </div>
            <div className="mt-4 space-y-3">
              {isLoadingTransactions ? (
                <p className="text-sm text-[var(--muted)]">Carregando lançamentos...</p>
              ) : transactions.length === 0 ? (
                <p className="text-sm text-[var(--muted)]">Nenhum lançamento encontrado.</p>
              ) : (
                transactions.slice(0, 8).map((item) => {
                  const type = item.source === "transfer" ? "transfer" : item.source === "adjustment" ? "adjustment" : item.category?.category_type ?? null;
                  const amountVal = Number(item.amount);
                  const sign = amountVal > 0 ? "+" : amountVal < 0 ? "-" : "";
                  const tone = amountVal > 0 ? "text-emerald-600" : amountVal < 0 ? "text-rose-600" : "text-[var(--ink)]";
                  const label = type === "transfer" ? "Transferência" : type === "adjustment" ? "Ajuste" : item.category ? getCategoryDisplayLabel(item.category.id, item.category.name) : "Categoria";
                  const dateLabel = shortDateFormatter.format(parseBrazilDate(item.posted_at));

                  return (
                    <Link
                      key={item.id}
                      href="/lancamentos"
                      className="flex w-full min-w-0 items-center justify-between gap-3 overflow-hidden rounded-2xl border border-[var(--border)] bg-white px-4 py-3 text-left shadow-sm transition hover:border-[var(--accent)]"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-center justify-between gap-3">
                          <span className="min-w-0 flex-1 truncate text-sm font-semibold text-[var(--ink)]">{item.description || label}</span>
                          <span className={`shrink-0 max-w-[110px] truncate text-right text-sm font-semibold tabular-nums ${tone}`}>
                            <span className="sm:hidden">{sign} {formatCompactBRL(Math.abs(amountVal))}</span>
                            <span className="hidden sm:inline">{sign} {currencyFormatter.format(Math.abs(amountVal))}</span>
                          </span>
                        </div>
                        <p className="mt-1 truncate text-xs text-[var(--muted)]">
                          {dateLabel} • {label}
                          {item.account?.name ? ` • ${item.account.name}` : ""}
                        </p>
                      </div>
                    </Link>
                  );
                })
              )}
            </div>
            {!isLoadingTransactions && transactions.length > 0 ? (
              <Link
                href="/lancamentos"
                className="mt-4 inline-flex w-full items-center justify-center rounded-2xl border border-[var(--border)] bg-white px-4 py-3 text-sm font-semibold text-[var(--ink)] shadow-sm transition hover:border-[var(--accent)]"
              >
                Ver todos os lançamentos
              </Link>
            ) : null}
          </div>
        </section>

        {/* Charts */}
        <section className="grid min-w-0 items-stretch gap-4 sm:gap-6 xl:grid-cols-3">
          <div className={isLoadingDashboardAnalytics ? "opacity-60" : ""}>
            <DonutChart title="Despesas por categoria" segments={dashboardExpenseData} />
          </div>
          <div className={isLoadingDashboardAnalytics ? "opacity-60" : ""}>
            <DonutChart title="Receitas por categoria" segments={dashboardIncomeData} />
          </div>
          <div className={isLoadingDashboardAnalytics ? "opacity-60" : ""}>
            <CashflowChart title="Fluxo de caixa no mês" points={dashboardCashflowPoints} />
          </div>
        </section>
      </main>
    </>
  );
}

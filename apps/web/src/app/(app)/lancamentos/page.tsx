"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Header } from "@/components/layout/Header";
import { useApp, type Category, type EditTransaction } from "@/contexts/AppContext";
import { getSupabaseClient } from "@/lib/supabase/client";
import { currencyFormatter, shortDateFormatter, longDateFormatter } from "@/lib/formatters";
import { getDateParts, formatDateKey, parseDateValue, getMonthRange, calendarWeekdays } from "@/lib/date-utils";
import { buildTransactionSearchFilter } from "@/lib/search-utils";
import { typeFilterAll } from "@/types";

const supabase = getSupabaseClient();

const monthNamesFull = [
  "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
  "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro",
];

const typeFilterOptions = [
  {
    value: "expense",
    label: "Despesas",
    active: "bg-rose-100 text-rose-700",
    inactive: "text-[var(--muted)] hover:text-rose-600",
  },
  {
    value: "income",
    label: "Receitas",
    active: "bg-emerald-100 text-emerald-700",
    inactive: "text-[var(--muted)] hover:text-emerald-600",
  },
  {
    value: "transfer",
    label: "Transferências",
    active: "bg-sky-100 text-sky-700",
    inactive: "text-[var(--muted)] hover:text-sky-600",
  },
];

const isBalanceAdjustCategory = (name?: string) =>
  name?.toLowerCase().includes("ajuste") ?? false;

type TransactionRow = {
  id: string;
  amount: string;
  description: string | null;
  original_description: string | null;
  posted_at: string;
  created_at: string;
  source: string | null;
  external_id: string | null;
  auto_categorized: boolean;
  transfer_linked_id: string | null;
  account: { id: string; name: string } | null;
  category: { id: string; name: string; category_type: string } | null;
};

export default function LancamentosPage() {
  const {
    session,
    activeFamilyId,
    activeMonth,
    accounts,
    categories,
    archivedCategories,
    dataRefreshCounter,
    triggerRefresh,
    openTransactionModal,
  } = useApp();

  const searchParams = useSearchParams();
  const initialUncategorized = searchParams.get("filter") === "uncategorized";

  // Filter state
  const [filterAccountIds, setFilterAccountIds] = useState<string[]>([]);
  const [filterCategoryIds, setFilterCategoryIds] = useState<string[]>([]);
  const [typeFilters, setTypeFilters] = useState<string[]>([...typeFilterAll]);
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [filterUncategorized, setFilterUncategorized] = useState(initialUncategorized);
  const [filterStartDate, setFilterStartDate] = useState("");
  const [filterEndDate, setFilterEndDate] = useState("");
  const [pageSize, setPageSize] = useState(50);
  const [limit, setLimit] = useState(50);

  // Selection state
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isBatchCategoryOpen, setIsBatchCategoryOpen] = useState(false);
  const [batchCategorySearch, setBatchCategorySearch] = useState("");
  const [batchCategoryId, setBatchCategoryId] = useState<string | null>(null);
  const [isBatchUpdating, setIsBatchUpdating] = useState(false);

  // UI state
  const [isMobileFiltersOpen, setIsMobileFiltersOpen] = useState(false);
  const [isAccountFilterOpen, setIsAccountFilterOpen] = useState(false);
  const [isCategoryFilterOpen, setIsCategoryFilterOpen] = useState(false);

  // Calendar modal state
  const [isCalendarOpen, setIsCalendarOpen] = useState(false);
  const [calendarTarget, setCalendarTarget] = useState<"start" | "end" | null>(null);
  const [calendarTempDate, setCalendarTempDate] = useState("");
  const [calendarMonth, setCalendarMonth] = useState(new Date().getMonth());
  const [calendarYear, setCalendarYear] = useState(new Date().getFullYear());

  // Data state
  const [transactions, setTransactions] = useState<TransactionRow[]>([]);
  const [transactionsTotal, setTransactionsTotal] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  // Refs for dropdowns
  const accountFilterRef = useRef<HTMLDivElement>(null);
  const categoryFilterRef = useRef<HTMLDivElement>(null);

  // Build categories lookup
  const categoriesById = useMemo(() => {
    return [...categories, ...archivedCategories].reduce<Record<string, Category>>(
      (acc, cat) => {
        acc[cat.id] = cat;
        return acc;
      },
      {},
    );
  }, [categories, archivedCategories]);

  const getCategoryDisplayLabel = useCallback(
    (categoryId?: string | null, fallbackName?: string | null) => {
      if (!categoryId) return fallbackName ?? "Categoria";
      const category = categoriesById[categoryId];
      if (!category) return fallbackName ?? "Categoria";
      if (!category.parent_id) return category.name;
      const parent = categoriesById[category.parent_id];
      return parent ? `${parent.name} / ${category.name}` : category.name;
    },
    [categoriesById],
  );

  // Category filter options
  const categoryFilterOptions = useMemo(() => {
    const source = [...categories, ...archivedCategories];
    const archivedIds = new Set(archivedCategories.map((c) => c.id));
    return source
      .filter((cat) => !isBalanceAdjustCategory(cat.name))
      .filter((cat) => cat.category_type !== "transfer")
      .map((cat) => {
        const baseLabel = getCategoryDisplayLabel(cat.id, cat.name);
        const label = archivedIds.has(cat.id) ? `${baseLabel} (arquivada)` : baseLabel;
        return { ...cat, label };
      })
      .sort((a, b) => a.label.localeCompare(b.label, "pt-BR"));
  }, [categories, archivedCategories, getCategoryDisplayLabel]);

  // Month range
  const monthRange = useMemo(() => getMonthRange(activeMonth), [activeMonth]);

  // Debounce search query for server-side filtering
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchQuery.trim().toLowerCase());
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  // Effective date range — when uncategorized filter is active without explicit dates, show all periods
  const effectiveStartDate = filterStartDate || (filterUncategorized ? "" : monthRange.startDate);
  const effectiveEndDate = filterEndDate || (filterUncategorized ? "" : monthRange.endDate);

  // Load transactions
  useEffect(() => {
    if (!session?.access_token || !activeFamilyId || accounts.length === 0) {
      /* eslint-disable react-hooks/set-state-in-effect -- Intentional: reset state */
      setTransactions([]);
      setTransactionsTotal(null);
      /* eslint-enable react-hooks/set-state-in-effect */
      return;
    }

    const loadTransactions = async () => {
      setIsLoading(true);

      const effectiveAccountIds =
        filterAccountIds.length > 0
          ? filterAccountIds
          : accounts.map((a) => a.id);

      let query = supabase
        .from("transactions")
        .select(
          "id, amount, description, original_description, posted_at, created_at, source, external_id, auto_categorized, transfer_linked_id, account:accounts(id, name), category:categories(id, name, category_type)",
          { count: "exact" },
        )
        .in("account_id", effectiveAccountIds)
        .order("posted_at", { ascending: false })
        .order("created_at", { ascending: false })
        .range(0, Math.max(limit - 1, 0));

      if (filterUncategorized) {
        query = query.is("category_id", null);
      } else if (filterCategoryIds.length > 0) {
        query = query.in("category_id", filterCategoryIds);
      }

      const searchFilter = buildTransactionSearchFilter(debouncedSearch);
      if (searchFilter) {
        query = query.or(searchFilter);
      }

      if (effectiveStartDate) {
        query = query.gte("posted_at", effectiveStartDate);
      }

      if (effectiveEndDate) {
        query = query.lte("posted_at", effectiveEndDate);
      }

      const { data, error, count } = await query;

      if (error) {
        console.error("Error loading transactions:", error);
        setTransactions([]);
        setTransactionsTotal(null);
        setIsLoading(false);
        return;
      }

      const rows: TransactionRow[] = (data ?? []).map((item) => ({
        id: item.id,
        amount: item.amount,
        description: item.description,
        original_description: (item as Record<string, unknown>).original_description as string | null,
        posted_at: item.posted_at,
        created_at: item.created_at,
        source: item.source,
        external_id: item.external_id,
        auto_categorized: (item as Record<string, unknown>).auto_categorized === true,
        transfer_linked_id: (item as Record<string, unknown>).transfer_linked_id as string | null,
        account: item.account as unknown as { id: string; name: string } | null,
        category: item.category as unknown as { id: string; name: string; category_type: string } | null,
      }));

      setTransactions(rows);
      setTransactionsTotal(count ?? null);
      setIsLoading(false);
    };

    loadTransactions();
  }, [
    session?.access_token,
    activeFamilyId,
    accounts,
    limit,
    filterAccountIds,
    filterCategoryIds,
    filterUncategorized,
    effectiveStartDate,
    effectiveEndDate,
    debouncedSearch,
    dataRefreshCounter,
  ]);

  // Reset limit when filters change
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Intentional: sync limit with filters
    setLimit(pageSize);
  }, [pageSize, filterAccountIds, filterCategoryIds, filterUncategorized, filterStartDate, filterEndDate, activeMonth, debouncedSearch]);

  // Close dropdowns on outside click
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        accountFilterRef.current &&
        !accountFilterRef.current.contains(event.target as Node)
      ) {
        setIsAccountFilterOpen(false);
      }
      if (
        categoryFilterRef.current &&
        !categoryFilterRef.current.contains(event.target as Node)
      ) {
        setIsCategoryFilterOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Type filtered transactions
  const typeFilteredTransactions = useMemo(() => {
    return transactions.filter((tx) => {
      const isAdjustment = tx.source === "adjustment";
      const isLinkedTransfer = Boolean(tx.transfer_linked_id) || (tx.category?.category_type === "transfer" && tx.source === "ofx");
      const rawValue = Number(tx.amount);
      const adjustmentType =
        isAdjustment && Number.isFinite(rawValue)
          ? rawValue >= 0
            ? "income"
            : "expense"
          : null;
      const typeValue =
        tx.source === "transfer" || isLinkedTransfer
          ? "transfer"
          : isAdjustment
            ? adjustmentType
            : tx.category?.category_type;
      if (!typeValue) return true;
      return typeFilters.includes(typeValue);
    });
  }, [transactions, typeFilters]);

  // Visible transactions (search is now server-side)
  const visibleTransactions = typeFilteredTransactions;

  // Filter state
  const isTypeFilterActive = typeFilters.length !== typeFilterAll.length;
  const isCustomDateRange = Boolean(
    filterStartDate &&
      filterEndDate &&
      monthRange.startDate &&
      monthRange.endDate &&
      (filterStartDate !== monthRange.startDate || filterEndDate !== monthRange.endDate),
  );
  const hasActiveFilters = Boolean(
    filterAccountIds.length > 0 ||
      filterCategoryIds.length > 0 ||
      filterUncategorized ||
      searchQuery.trim() ||
      isTypeFilterActive ||
      isCustomDateRange,
  );
  const activeFiltersCount = [
    filterAccountIds.length > 0 ? 1 : 0,
    filterCategoryIds.length > 0 || filterUncategorized ? 1 : 0,
    searchQuery.trim() ? 1 : 0,
    isTypeFilterActive ? 1 : 0,
    isCustomDateRange ? 1 : 0,
  ].reduce((total, v) => total + v, 0);
  const showPagination = true;
  const showLocalFilter = isTypeFilterActive;

  // Filter chips
  const activeFilterChips = useMemo(() => {
    const chips: Array<{ key: string; label: string; className: string; title?: string }> = [];
    if (filterAccountIds.length > 0) {
      const selected = accounts
        .filter((a) => filterAccountIds.includes(a.id))
        .map((a) => a.name);
      const label = selected.length === 1 ? selected[0] : `${selected.length} contas`;
      chips.push({
        key: "account",
        label: `Contas: ${label}`,
        title: selected.join(", "),
        className: "bg-slate-100 text-slate-600",
      });
    }
    if (filterUncategorized) {
      chips.push({
        key: "uncategorized",
        label: "Sem categoria",
        className: "bg-amber-100 text-amber-700",
      });
    } else if (filterCategoryIds.length > 0) {
      const selected = filterCategoryIds
        .map((id) => getCategoryDisplayLabel(id, categoriesById[id]?.name))
        .filter(Boolean);
      const label = selected.length === 1 ? selected[0] : `${selected.length} categorias`;
      chips.push({
        key: "category",
        label: `Categorias: ${label}`,
        title: selected.join(", "),
        className: "bg-slate-100 text-slate-600",
      });
    }
    if (isTypeFilterActive) {
      typeFilterOptions
        .filter((opt) => typeFilters.includes(opt.value))
        .forEach((opt) => {
          chips.push({ key: `type-${opt.value}`, label: opt.label, className: opt.active });
        });
    }
    if (searchQuery.trim()) {
      chips.push({
        key: "search",
        label: `Busca: ${searchQuery.trim()}`,
        title: searchQuery.trim(),
        className: "bg-slate-100 text-slate-600",
      });
    }
    if (isCustomDateRange && filterStartDate && filterEndDate) {
      const startLabel = formatDate(filterStartDate);
      const endLabel = formatDate(filterEndDate);
      chips.push({
        key: "period",
        label: `Período: ${startLabel} – ${endLabel}`,
        title: `${startLabel} até ${endLabel}`,
        className: "bg-slate-100 text-slate-600",
      });
    }
    return chips;
  }, [
    filterAccountIds,
    filterCategoryIds,
    filterUncategorized,
    typeFilters,
    searchQuery,
    isTypeFilterActive,
    isCustomDateRange,
    filterStartDate,
    filterEndDate,
    accounts,
    categoriesById,
    getCategoryDisplayLabel,
  ]);

  // Mobile transaction groups
  const mobileTransactionGroups = useMemo(() => {
    return visibleTransactions.reduce<Record<string, TransactionRow[]>>(
      (acc, tx) => {
        const key = tx.posted_at.slice(0, 10);
        if (!acc[key]) acc[key] = [];
        acc[key].push(tx);
        return acc;
      },
      {},
    );
  }, [visibleTransactions]);

  const mobileTransactionEntries = Object.entries(mobileTransactionGroups).sort(
    ([a], [b]) => b.localeCompare(a),
  );

  // Toggle functions
  const toggleTypeFilter = (value: string) => {
    setTypeFilters((current) => {
      const isActive = current.includes(value);
      if (isActive) {
        if (current.length === 1) return current;
        return current.filter((v) => v !== value);
      }
      return [...typeFilterAll].filter((v) => current.includes(v) || v === value);
    });
  };

  const toggleAccountFilter = (accountId: string) => {
    setFilterAccountIds((current) => {
      const isSelected = current.includes(accountId);
      return isSelected
        ? current.filter((id) => id !== accountId)
        : [...current, accountId];
    });
  };

  const toggleCategoryFilter = (categoryId: string) => {
    setFilterCategoryIds((current) => {
      const allIds = categoryFilterOptions.map((c) => c.id);
      const isSelected = current.includes(categoryId);
      const next = isSelected
        ? current.filter((id) => id !== categoryId)
        : [...current, categoryId];
      return next.length === allIds.length ? [] : next;
    });
  };

  const clearFilters = () => {
    setFilterAccountIds([]);
    setFilterCategoryIds([]);
    setFilterUncategorized(false);
    setSearchQuery("");
    setTypeFilters([...typeFilterAll]);
    setFilterStartDate("");
    setFilterEndDate("");
  };

  // Open edit modal for a transaction
  const openEditModal = (tx: TransactionRow) => {
    const edit: EditTransaction = {
      id: tx.id,
      description: tx.description,
      original_description: tx.original_description,
      category_id: tx.category?.id ?? null,
      amount: tx.amount,
      account_id: tx.account?.id ?? null,
      posted_at: tx.posted_at,
      source: tx.source,
      external_id: tx.external_id,
      transfer_linked_id: tx.transfer_linked_id,
    };
    const catType = tx.category?.category_type as "expense" | "income" | "transfer" | undefined;
    openTransactionModal(catType, edit);
  };

  // Selection helpers
  const effectiveSelectedIds = selectedIds;

  const editableVisibleIds = useMemo(
    () =>
      visibleTransactions
        .filter((tx) => tx.source !== "transfer" && tx.source !== "adjustment")
        .map((tx) => tx.id),
    [visibleTransactions],
  );

  const isAllSelected =
    editableVisibleIds.length > 0 && editableVisibleIds.every((id) => effectiveSelectedIds.has(id));

  const toggleSelection = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (isAllSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(editableVisibleIds));
    }
  };

  const clearSelection = () => {
    setSelectedIds(new Set());
    setIsBatchCategoryOpen(false);
    setBatchCategorySearch("");
    setBatchCategoryId(null);
  };

  // Batch update category
  const batchUpdateCategory = async (categoryId: string) => {
    const ids = Array.from(effectiveSelectedIds);
    if (ids.length === 0) return;

    setIsBatchUpdating(true);
    const { error } = await supabase
      .from("transactions")
      .update({ category_id: categoryId, auto_categorized: false })
      .in("id", ids);

    if (error) {
      console.error("Batch update error:", error);
    } else {
      clearSelection();
      triggerRefresh();
    }
    setIsBatchUpdating(false);
  };

  // Batch category options
  const batchCategoryOptions = useMemo(() => {
    const opts = categories
      .filter((c) => c.category_type !== "transfer" && c.name !== "Ajuste de saldo")
      .map((c) => ({
        id: c.id,
        label: getCategoryDisplayLabel(c.id, c.name),
        type: c.category_type,
      }))
      .sort((a, b) => a.label.localeCompare(b.label, "pt-BR"));

    if (!batchCategorySearch.trim()) return opts;
    const q = batchCategorySearch.trim().toLowerCase();
    return opts.filter((o) => o.label.toLowerCase().includes(q));
  }, [categories, batchCategorySearch, getCategoryDisplayLabel]);

  // Calendar functions
  const openCalendar = (target: "start" | "end") => {
    const fallbackDate =
      target === "start"
        ? filterStartDate || monthRange.startDate || new Date().toISOString().slice(0, 10)
        : filterEndDate || monthRange.endDate || new Date().toISOString().slice(0, 10);
    const parts = getDateParts(fallbackDate);
    if (parts) {
      setCalendarMonth(parts.monthIndex);
      setCalendarYear(parts.year);
    }
    setCalendarTempDate(fallbackDate);
    setCalendarTarget(target);
    setIsCalendarOpen(true);
  };

  const closeCalendar = () => {
    setIsCalendarOpen(false);
    setCalendarTarget(null);
  };

  const applyCalendar = () => {
    if (!calendarTarget) {
      closeCalendar();
      return;
    }
    if (calendarTarget === "start") {
      setFilterStartDate(calendarTempDate);
      if (filterEndDate && calendarTempDate > filterEndDate) {
        setFilterEndDate(calendarTempDate);
      }
    } else {
      setFilterEndDate(calendarTempDate);
      if (filterStartDate && calendarTempDate < filterStartDate) {
        setFilterStartDate(calendarTempDate);
      }
    }
    closeCalendar();
  };

  // Calendar derived state
  const calendarLabel = `${monthNamesFull[calendarMonth]} ${calendarYear}`;
  const calendarFirstWeekday = new Date(calendarYear, calendarMonth, 1).getDay();
  const calendarDaysInMonth = new Date(calendarYear, calendarMonth + 1, 0).getDate();
  const calendarDays = [
    ...Array(calendarFirstWeekday).fill(null),
    ...Array.from({ length: calendarDaysInMonth }, (_, i) => i + 1),
  ];
  const calendarSelectedParts = getDateParts(calendarTempDate);
  const calendarSelectedDate = calendarTempDate
    ? parseDateValue(calendarTempDate)
    : new Date();
  const calendarSelectedLabel = new Intl.DateTimeFormat("pt-BR", {
    weekday: "short",
    day: "numeric",
    month: "short",
  })
    .format(calendarSelectedDate)
    .replace(".", "")
    .toUpperCase();

  // Format helpers
  function formatDate(value: string) {
    const parsed = parseDateValue(value);
    if (Number.isNaN(parsed.getTime())) return value;
    return shortDateFormatter.format(parsed);
  }

  function formatMobileDate(value: string) {
    const parsed = parseDateValue(value);
    if (Number.isNaN(parsed.getTime())) return value;
    return longDateFormatter
      .format(parsed)
      .replace(/\./g, "")
      .replace(/\s+de\s+/g, " ")
      .replace(/\s{2,}/g, " ")
      .toUpperCase();
  }

  return (
    <>
      <Header />
      <main className="flex flex-col gap-4 sm:gap-6">
        <section className="rounded-3xl border border-[var(--border)] bg-white/80 px-1.5 py-4 shadow-sm sm:p-6">
          {/* Header */}
          <div className="flex flex-wrap items-center justify-between gap-2 sm:gap-4">
            <div className="pl-1 sm:pl-0">
              <h3 className="text-base font-semibold uppercase tracking-[0.2em] text-[var(--ink)] sm:text-lg sm:tracking-[0.24em]">
                Lançamentos
              </h3>
            </div>
            {hasActiveFilters && (
              <button
                type="button"
                onClick={clearFilters}
                className="hidden rounded-full border border-[var(--border)] bg-white px-4 py-2 text-xs font-semibold text-[var(--ink)] transition hover:border-[var(--accent)] sm:inline-flex"
              >
                Limpar filtros
              </button>
            )}
          </div>

          <div className="mt-2 h-px w-full bg-[var(--border)]/60 sm:mt-3" />

          {/* Mobile Filters */}
          <div className="mt-4 sm:hidden">
            <div className="rounded-2xl border border-[var(--border)] bg-white shadow-sm">
              <div className="flex items-center justify-between px-3 py-2">
                <button
                  type="button"
                  onClick={() => setIsMobileFiltersOpen((prev) => !prev)}
                  className="flex items-center gap-2 text-xs font-semibold text-[var(--ink)]"
                >
                  <span className="uppercase tracking-[0.2em] text-[var(--muted)]">
                    Filtros
                  </span>
                  {activeFiltersCount > 0 && (
                    <span className="rounded-full bg-[var(--accent-soft)] px-2 py-0.5 text-[10px] font-semibold text-[var(--accent-strong)]">
                      {activeFiltersCount}
                    </span>
                  )}
                  <svg
                    aria-hidden="true"
                    viewBox="0 0 24 24"
                    className={`h-4 w-4 text-[var(--muted)] transition ${isMobileFiltersOpen ? "rotate-180" : ""}`}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M6 9l6 6 6-6" />
                  </svg>
                </button>
                {hasActiveFilters && (
                  <button
                    type="button"
                    onClick={() => {
                      clearFilters();
                      setIsMobileFiltersOpen(false);
                    }}
                    className="text-xs font-semibold text-[var(--accent-strong)]"
                  >
                    Limpar
                  </button>
                )}
              </div>
              {!isMobileFiltersOpen && activeFilterChips.length > 0 && (
                <div className="flex flex-wrap gap-2 px-3 pb-3">
                  {activeFilterChips.map((chip) => (
                    <span
                      key={chip.key}
                      title={chip.title ?? chip.label}
                      className={`rounded-full px-3 py-1 text-[11px] font-semibold ${
                        chip.key === "period" ? "max-w-full whitespace-normal" : "max-w-[160px] truncate"
                      } ${chip.className}`}
                    >
                      {chip.label}
                    </span>
                  ))}
                </div>
              )}
              {isMobileFiltersOpen && (
                <div className="grid gap-3 border-t border-[var(--border)] px-3 py-3">
                  {/* Account filter */}
                  <div className="grid gap-2">
                    <label className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">
                      Conta
                    </label>
                    <div className="rounded-2xl border border-[var(--border)] bg-white px-3 py-2 shadow-sm">
                      <label className="flex cursor-pointer items-center justify-between gap-3 py-1 text-xs font-semibold text-[var(--ink)]">
                        <span>Todas as contas</span>
                        <input
                          type="checkbox"
                          checked={filterAccountIds.length === 0}
                          onChange={() => setFilterAccountIds([])}
                          className="h-4 w-4 accent-[var(--accent)]"
                        />
                      </label>
                      <div className="mt-2 max-h-40 space-y-1 overflow-auto border-t border-[var(--border)] pt-2">
                        {accounts.map((account) => (
                          <label
                            key={account.id}
                            className="flex cursor-pointer items-center justify-between gap-3 py-1 text-xs font-semibold text-[var(--ink)]"
                          >
                            <span className="truncate">{account.name}</span>
                            <input
                              type="checkbox"
                              checked={filterAccountIds.includes(account.id)}
                              onChange={() => toggleAccountFilter(account.id)}
                              className="h-4 w-4 accent-[var(--accent)]"
                            />
                          </label>
                        ))}
                      </div>
                    </div>
                  </div>
                  {/* Category filter */}
                  <div className="grid gap-2">
                    <label className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">
                      Categoria
                    </label>
                    <div className="rounded-2xl border border-[var(--border)] bg-white px-3 py-2 shadow-sm">
                      <label className="flex cursor-pointer items-center justify-between gap-3 py-1 text-xs font-semibold text-[var(--ink)]">
                        <span>Todas as categorias</span>
                        <input
                          type="checkbox"
                          checked={filterCategoryIds.length === 0}
                          onChange={() => setFilterCategoryIds([])}
                          className="h-4 w-4 accent-[var(--accent)]"
                        />
                      </label>
                      <div className="mt-2 max-h-48 space-y-1 overflow-auto border-t border-[var(--border)] pt-2">
                        {categoryFilterOptions.map((category) => (
                          <label
                            key={category.id}
                            className="flex cursor-pointer items-center justify-between gap-3 py-1 text-xs font-semibold text-[var(--ink)]"
                          >
                            <span className="truncate">{category.label}</span>
                            <input
                              type="checkbox"
                              checked={filterCategoryIds.includes(category.id)}
                              onChange={() => toggleCategoryFilter(category.id)}
                              className="h-4 w-4 accent-[var(--accent)]"
                            />
                          </label>
                        ))}
                      </div>
                    </div>
                  </div>
                  {/* Period filter */}
                  <div className="grid gap-2">
                    <label className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">
                      Período
                    </label>
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        onClick={() => openCalendar("start")}
                        className="flex h-10 w-full items-center justify-between gap-2 rounded-xl border border-[var(--border)] bg-white px-3 text-xs font-semibold text-[var(--ink)] shadow-sm transition hover:border-[var(--accent)]"
                      >
                        <span className="truncate">
                          {filterStartDate ? formatDate(filterStartDate) : "Data inicial"}
                        </span>
                        <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4 text-[var(--muted)]" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <rect x="3" y="4" width="18" height="18" rx="2" />
                          <path d="M16 2v4M8 2v4M3 10h18" />
                        </svg>
                      </button>
                      <button
                        type="button"
                        onClick={() => openCalendar("end")}
                        className="flex h-10 w-full items-center justify-between gap-2 rounded-xl border border-[var(--border)] bg-white px-3 text-xs font-semibold text-[var(--ink)] shadow-sm transition hover:border-[var(--accent)]"
                      >
                        <span className="truncate">
                          {filterEndDate ? formatDate(filterEndDate) : "Data final"}
                        </span>
                        <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4 text-[var(--muted)]" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <rect x="3" y="4" width="18" height="18" rx="2" />
                          <path d="M16 2v4M8 2v4M3 10h18" />
                        </svg>
                      </button>
                    </div>
                  </div>
                  {/* Page size */}
                  <div className="grid gap-2">
                    <label className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">
                      Por página
                    </label>
                    <select
                      value={pageSize}
                      onChange={(e) => setPageSize(Number(e.target.value) || 50)}
                      className="h-10 w-full rounded-xl border border-[var(--border)] bg-white px-3 text-sm text-[var(--ink)] shadow-sm outline-none transition focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--ring)]"
                    >
                      <option value={25}>25 lançamentos</option>
                      <option value={50}>50 lançamentos</option>
                      <option value={100}>100 lançamentos</option>
                    </select>
                  </div>
                  {/* Type filter */}
                  <div className="grid gap-2">
                    <label className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">
                      Tipo
                    </label>
                    <div className="flex flex-wrap items-center gap-1 rounded-full border border-[var(--border)] bg-white px-1 py-1 shadow-sm">
                      {typeFilterOptions.map((option) => {
                        const isActive = typeFilters.includes(option.value);
                        return (
                          <button
                            key={option.value}
                            type="button"
                            aria-pressed={isActive}
                            onClick={() => toggleTypeFilter(option.value)}
                            className={`rounded-full px-3 py-1 text-xs font-semibold transition ${isActive ? option.active : option.inactive}`}
                          >
                            {option.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  {/* Uncategorized filter */}
                  <div className="grid gap-2">
                    <button
                      type="button"
                      aria-pressed={filterUncategorized}
                      onClick={() => {
                        setFilterUncategorized((prev) => !prev);
                        if (!filterUncategorized) setFilterCategoryIds([]);
                      }}
                      className={`h-10 w-full rounded-xl border text-xs font-semibold transition ${
                        filterUncategorized
                          ? "bg-amber-100 text-amber-700 border-amber-200"
                          : "bg-white text-[var(--muted)] border-[var(--border)] hover:text-amber-600 hover:border-amber-200"
                      }`}
                    >
                      Sem categoria
                    </button>
                  </div>
                  {/* Search */}
                  <div className="grid gap-2">
                    <label className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">
                      Busca
                    </label>
                    <input
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="Buscar lançamentos, contas ou categorias..."
                      className="h-10 w-full rounded-xl border border-[var(--border)] bg-white px-4 text-xs font-semibold text-[var(--ink)] shadow-sm outline-none transition focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--ring)]"
                    />
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Desktop Filters */}
          <div className="mt-4 hidden flex-wrap items-center gap-3 sm:flex">
            {/* Account dropdown */}
            <div ref={accountFilterRef} className="relative">
              <button
                type="button"
                onClick={() => {
                  setIsAccountFilterOpen((prev) => !prev);
                  setIsCategoryFilterOpen(false);
                }}
                className="min-w-[200px] rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-left text-sm font-semibold text-[var(--ink)] shadow-sm outline-none transition hover:border-[var(--accent)] hover:text-[var(--accent-strong)]"
              >
                {filterAccountIds.length === 0
                  ? "Todas as contas"
                  : filterAccountIds.length === 1
                    ? accounts.find((a) => a.id === filterAccountIds[0])?.name ?? "Conta"
                    : `${filterAccountIds.length} contas`}
              </button>
              {isAccountFilterOpen && (
                <div className="absolute left-0 top-[calc(100%+8px)] z-30 w-[320px] overflow-hidden rounded-2xl border border-[var(--border)] bg-white shadow-lg">
                  <div className="border-b border-[var(--border)] px-3 py-2">
                    <label className="flex cursor-pointer items-center justify-between gap-3 text-xs font-semibold text-[var(--ink)]">
                      <span>Todas as contas</span>
                      <input
                        type="checkbox"
                        checked={filterAccountIds.length === 0}
                        onChange={() => setFilterAccountIds([])}
                        className="h-4 w-4 accent-[var(--accent)]"
                      />
                    </label>
                  </div>
                  <div className="max-h-64 overflow-auto px-3 py-2">
                    <div className="space-y-1">
                      {accounts.map((account) => (
                        <label
                          key={account.id}
                          className="flex cursor-pointer items-center justify-between gap-3 rounded-xl px-2 py-2 text-xs font-semibold text-[var(--ink)] transition hover:bg-slate-50"
                        >
                          <span className="truncate">{account.name}</span>
                          <input
                            type="checkbox"
                            checked={filterAccountIds.includes(account.id)}
                            onChange={() => toggleAccountFilter(account.id)}
                            className="h-4 w-4 accent-[var(--accent)]"
                          />
                        </label>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Category dropdown */}
            <div ref={categoryFilterRef} className="relative">
              <button
                type="button"
                onClick={() => {
                  setIsCategoryFilterOpen((prev) => !prev);
                  setIsAccountFilterOpen(false);
                }}
                className="min-w-[220px] rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-left text-sm font-semibold text-[var(--ink)] shadow-sm outline-none transition hover:border-[var(--accent)] hover:text-[var(--accent-strong)]"
              >
                {filterCategoryIds.length === 0
                  ? "Todas as categorias"
                  : filterCategoryIds.length === 1
                    ? getCategoryDisplayLabel(filterCategoryIds[0], categoriesById[filterCategoryIds[0]]?.name)
                    : `${filterCategoryIds.length} categorias`}
              </button>
              {isCategoryFilterOpen && (
                <div className="absolute left-0 top-[calc(100%+8px)] z-30 w-[360px] overflow-hidden rounded-2xl border border-[var(--border)] bg-white shadow-lg">
                  <div className="border-b border-[var(--border)] px-3 py-2">
                    <label className="flex cursor-pointer items-center justify-between gap-3 text-xs font-semibold text-[var(--ink)]">
                      <span>Todas as categorias</span>
                      <input
                        type="checkbox"
                        checked={filterCategoryIds.length === 0}
                        onChange={() => setFilterCategoryIds([])}
                        className="h-4 w-4 accent-[var(--accent)]"
                      />
                    </label>
                  </div>
                  <div className="max-h-64 overflow-auto px-3 py-2">
                    <div className="space-y-1">
                      {categoryFilterOptions.map((category) => (
                        <label
                          key={category.id}
                          className="flex cursor-pointer items-center justify-between gap-3 rounded-xl px-2 py-2 text-xs font-semibold text-[var(--ink)] transition hover:bg-slate-50"
                        >
                          <span className="truncate">{category.label}</span>
                          <input
                            type="checkbox"
                            checked={filterCategoryIds.includes(category.id)}
                            onChange={() => toggleCategoryFilter(category.id)}
                            className="h-4 w-4 accent-[var(--accent)]"
                          />
                        </label>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Period */}
            <div className="flex items-center gap-2 rounded-xl border border-[var(--border)] bg-white px-3 py-2 shadow-sm">
              <span className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">
                Período
              </span>
              <button
                type="button"
                onClick={() => openCalendar("start")}
                className="flex min-w-[120px] items-center justify-between gap-2 text-xs font-semibold text-[var(--ink)] transition hover:text-[var(--accent-strong)]"
              >
                <span className="truncate">
                  {filterStartDate ? formatDate(filterStartDate) : "Data inicial"}
                </span>
                <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4 text-[var(--muted)]" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="4" width="18" height="18" rx="2" />
                  <path d="M16 2v4M8 2v4M3 10h18" />
                </svg>
              </button>
              <span className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">
                até
              </span>
              <button
                type="button"
                onClick={() => openCalendar("end")}
                className="flex min-w-[120px] items-center justify-between gap-2 text-xs font-semibold text-[var(--ink)] transition hover:text-[var(--accent-strong)]"
              >
                <span className="truncate">
                  {filterEndDate ? formatDate(filterEndDate) : "Data final"}
                </span>
                <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4 text-[var(--muted)]" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="4" width="18" height="18" rx="2" />
                  <path d="M16 2v4M8 2v4M3 10h18" />
                </svg>
              </button>
            </div>

            {/* Page size */}
            <select
              value={pageSize}
              onChange={(e) => setPageSize(Number(e.target.value) || 50)}
              className="min-w-[170px] rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm text-[var(--ink)] shadow-sm outline-none transition focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--ring)]"
            >
              <option value={25}>25 / página</option>
              <option value={50}>50 / página</option>
              <option value={100}>100 / página</option>
            </select>

            {/* Type filter */}
            <div className="flex flex-wrap items-center gap-1 rounded-full border border-[var(--border)] bg-white px-1 py-1 shadow-sm">
              {typeFilterOptions.map((option) => {
                const isActive = typeFilters.includes(option.value);
                return (
                  <button
                    key={option.value}
                    type="button"
                    aria-pressed={isActive}
                    onClick={() => toggleTypeFilter(option.value)}
                    className={`rounded-full px-3 py-1 text-xs font-semibold transition ${isActive ? option.active : option.inactive}`}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>

            {/* Uncategorized filter */}
            <button
              type="button"
              aria-pressed={filterUncategorized}
              onClick={() => {
                setFilterUncategorized((prev) => !prev);
                if (!filterUncategorized) setFilterCategoryIds([]);
              }}
              className={`rounded-full px-3 py-1.5 text-xs font-semibold border transition ${
                filterUncategorized
                  ? "bg-amber-100 text-amber-700 border-amber-200"
                  : "bg-white text-[var(--muted)] border-[var(--border)] hover:text-amber-600 hover:border-amber-200"
              }`}
            >
              Sem categoria
            </button>

            {/* Search */}
            <div className="min-w-[220px] flex-1">
              <input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Buscar lançamentos, contas ou categorias..."
                className="h-10 w-full rounded-xl border border-[var(--border)] bg-white px-4 text-xs font-semibold text-[var(--ink)] shadow-sm outline-none transition focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--ring)]"
              />
            </div>
          </div>

          {/* Mobile List */}
          <div className="mt-4 sm:hidden">
            {isLoading ? (
              <p className="text-sm text-[var(--muted)]">Carregando lançamentos...</p>
            ) : visibleTransactions.length === 0 ? (
              <p className="text-sm text-[var(--muted)]">Nenhum lançamento encontrado.</p>
            ) : (
              <div className="space-y-3">
                {mobileTransactionEntries.map(([dateKey, dayTransactions]) => (
                  <div key={dateKey}>
                    <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">
                      {formatMobileDate(dateKey)}
                    </p>
                    <div className="mt-2 space-y-2">
                      {dayTransactions.map((tx) => {
                        const isManualTransfer = tx.source === "transfer";
                        const isLinkedOFXTransfer = Boolean(tx.transfer_linked_id) || (tx.category?.category_type === "transfer" && tx.source === "ofx");
                        const isTransferRow = isManualTransfer || isLinkedOFXTransfer;
                        const isAdjustRow = tx.source === "adjustment";
                        const rawValue = Number(tx.amount);
                        const isNumeric = Number.isFinite(rawValue);
                        const displayValue = isNumeric ? Math.abs(rawValue) : rawValue;
                        const formattedValue = isNumeric ? currencyFormatter.format(displayValue) : tx.amount;
                        const categoryType = tx.category?.category_type;
                        const sign = rawValue < 0 ? "-" : rawValue > 0 ? "+" : "";
                        const valueTone = rawValue < 0 ? "text-rose-600" : rawValue > 0 ? "text-emerald-600" : "text-[var(--ink)]";
                        const isUncategorized = !tx.category?.id && !isTransferRow && !isAdjustRow;
                        const categoryLabel = tx.category?.id
                          ? getCategoryDisplayLabel(tx.category.id, tx.category?.name)
                          : isTransferRow ? "Transferência" : isAdjustRow ? "Ajuste de saldo" : "Sem categoria";
                        const title = tx.description?.trim() || categoryLabel;
                        const hasOriginalDescription = tx.original_description && tx.original_description !== tx.description;
                        const meta = [categoryLabel, tx.account?.name ?? "Conta"].join(" | ");
                        const iconTone = isTransferRow
                          ? "bg-sky-100 text-sky-600"
                          : isAdjustRow ? "bg-amber-100 text-amber-600"
                          : categoryType === "income" ? "bg-emerald-100 text-emerald-600"
                          : categoryType === "expense" ? "bg-rose-100 text-rose-600"
                          : "bg-slate-100 text-slate-500";

                        const canEdit = !isManualTransfer && !isAdjustRow;

                        return (
                          <div
                            key={tx.id}
                            className={`flex w-full items-start gap-2 rounded-2xl border border-[var(--border)] bg-white px-3 py-2 text-left shadow-sm transition ${
                              canEdit ? "cursor-pointer hover:border-[var(--accent)] hover:shadow-md" : ""
                            } ${effectiveSelectedIds.has(tx.id) ? "border-[var(--accent)] bg-blue-50" : ""}`}
                          >
                            {canEdit && (
                              <div className="flex shrink-0 items-center pt-3">
                                <input
                                  type="checkbox"
                                  checked={effectiveSelectedIds.has(tx.id)}
                                  onChange={() => toggleSelection(tx.id)}
                                  className="h-4 w-4 cursor-pointer rounded border-gray-300 accent-[var(--accent)]"
                                />
                              </div>
                            )}
                            <button
                              type="button"
                              disabled={!canEdit}
                              onClick={() => canEdit && openEditModal(tx)}
                              className="flex flex-1 items-start gap-3"
                            >
                            <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${iconTone}`}>
                              {isTransferRow ? (
                                <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                  <path d="M7 7h10" /><path d="M14 4l3 3-3 3" /><path d="M17 17H7" /><path d="M10 20l-3-3 3-3" />
                                </svg>
                              ) : isAdjustRow ? (
                                <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                  <path d="M4 6h16" /><path d="M4 12h10" /><path d="M4 18h7" /><circle cx="18" cy="12" r="2" />
                                </svg>
                              ) : categoryType === "income" ? (
                                <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                  <path d="M12 19V5" /><path d="M5 12l7-7 7 7" />
                                </svg>
                              ) : (
                                <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                  <path d="M12 5v14" /><path d="M19 12l-7 7-7-7" />
                                </svg>
                              )}
                            </div>
                            <div className="min-w-0 flex-1">
                              <p className="break-words text-sm font-semibold leading-snug text-[var(--ink)]">{title}</p>
                              {hasOriginalDescription && (
                                <p className="mt-0.5 break-words text-[11px] italic leading-snug text-[var(--muted)]">
                                  Original: {tx.original_description}
                                </p>
                              )}
                              <p className="mt-0.5 break-words text-xs leading-snug text-[var(--muted)]">
                                {isUncategorized ? (
                                  <><span className="font-semibold text-amber-600">Sem categoria</span>{" | "}{tx.account?.name ?? "Conta"}</>
                                ) : (
                                  <>{meta}{tx.auto_categorized && <span className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-blue-300/60" title="Categorizada automaticamente por regra" />}</>
                                )}
                              </p>
                            </div>
                            <div className="ml-2 shrink-0 text-right">
                              <p className={`min-w-[88px] text-sm font-semibold ${valueTone}`}>
                                {sign} {formattedValue}
                              </p>
                            </div>
                          </button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Desktop Table */}
          <div className="mt-4 hidden overflow-x-auto sm:block">
            <table className="w-full text-sm">
              <thead className="text-xs uppercase tracking-[0.2em] text-[var(--muted)]">
                <tr className="border-b border-[var(--border)]">
                  <th className="w-8 py-2">
                    <input
                      type="checkbox"
                      checked={isAllSelected}
                      onChange={toggleSelectAll}
                      className="h-4 w-4 cursor-pointer rounded border-gray-300 accent-[var(--accent)]"
                      title="Selecionar todos"
                    />
                  </th>
                  <th className="py-2 text-left font-semibold">Data</th>
                  <th className="py-2 text-left font-semibold">Categoria</th>
                  <th className="py-2 text-left font-semibold">Tipo</th>
                  <th className="py-2 text-left font-semibold">Conta</th>
                  <th className="py-2 text-right font-semibold">Valor</th>
                </tr>
              </thead>
              <tbody>
                {isLoading ? (
                  <tr>
                    <td colSpan={6} className="py-4 text-sm text-[var(--muted)]">
                      Carregando lançamentos...
                    </td>
                  </tr>
                ) : visibleTransactions.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-4 text-sm text-[var(--muted)]">
                      Nenhum lançamento encontrado.
                    </td>
                  </tr>
                ) : (
                  visibleTransactions.map((tx) => {
                    const isManualTransfer = tx.source === "transfer";
                    const isLinkedOFXTransfer = Boolean(tx.transfer_linked_id) || (tx.category?.category_type === "transfer" && tx.source === "ofx");
                    const isTransferRow = isManualTransfer || isLinkedOFXTransfer;
                    const isAdjustRow = tx.source === "adjustment";
                    const rawValue = Number(tx.amount);
                    const isNumeric = Number.isFinite(rawValue);
                    const displayValue = isNumeric ? Math.abs(rawValue) : rawValue;
                    const formattedValue = isNumeric ? currencyFormatter.format(displayValue) : tx.amount;
                    const categoryType = tx.category?.category_type;
                    const sign = isTransferRow || isAdjustRow
                      ? rawValue < 0 ? "-" : "+"
                      : categoryType === "income" ? "+" : categoryType === "expense" ? "-"
                      : rawValue < 0 ? "-" : rawValue > 0 ? "+" : "";
                    const valueTone = isTransferRow || isAdjustRow
                      ? rawValue < 0 ? "text-rose-600" : "text-emerald-600"
                      : categoryType === "expense" ? "text-rose-600" : categoryType === "income" ? "text-emerald-600"
                      : rawValue < 0 ? "text-rose-600" : rawValue > 0 ? "text-emerald-600" : "text-[var(--ink)]";
                    const isUncategorized = !tx.category?.id && !isTransferRow && !isAdjustRow;
                    const categoryLabel = tx.category?.id
                      ? getCategoryDisplayLabel(tx.category.id, tx.category?.name)
                      : isTransferRow ? "Transferência" : isAdjustRow ? "Ajuste de saldo" : "Sem categoria";
                    const typeLabel = isTransferRow ? "Transferência" : isAdjustRow ? "Ajuste"
                      : categoryType === "income" ? "Receita" : categoryType === "expense" ? "Despesa" : "Outro";
                    const hasOriginalDescription = tx.original_description && tx.original_description !== tx.description;
                    const canEdit = !isManualTransfer && !isAdjustRow;

                    return (
                      <tr
                        key={tx.id}
                        onClick={() => canEdit && openEditModal(tx)}
                        className={`border-b border-[var(--border)] last:border-b-0 ${
                          canEdit ? "cursor-pointer transition hover:bg-slate-50" : ""
                        } ${effectiveSelectedIds.has(tx.id) ? "bg-blue-50" : ""}`}
                      >
                        <td className="w-8 py-3" onClick={(e) => e.stopPropagation()}>
                          {canEdit && (
                            <input
                              type="checkbox"
                              checked={effectiveSelectedIds.has(tx.id)}
                              onChange={() => toggleSelection(tx.id)}
                              className="h-4 w-4 cursor-pointer rounded border-gray-300 accent-[var(--accent)]"
                            />
                          )}
                        </td>
                        <td className="py-3 text-sm text-[var(--muted)]">
                          <div>{formatDate(tx.posted_at)}</div>
                          {tx.description && (
                            <div className="mt-0.5 text-xs text-[var(--ink)]">{tx.description}</div>
                          )}
                          {hasOriginalDescription && (
                            <div className="mt-0.5 text-[11px] italic text-[var(--muted)]">
                              Original: {tx.original_description}
                            </div>
                          )}
                        </td>
                        <td className="py-3 text-sm text-[var(--ink)]">
                          {isUncategorized ? (
                            <span className="font-semibold text-amber-600">Sem categoria</span>
                          ) : (
                            <>{categoryLabel}{tx.auto_categorized && <span className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-blue-300/60" title="Categorizada automaticamente por regra" />}</>
                          )}
                        </td>
                        <td className="py-3 text-xs font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">{typeLabel}</td>
                        <td className="py-3 text-sm text-[var(--muted)]">{tx.account?.name ?? "Conta"}</td>
                        <td className={`py-3 text-right text-sm font-semibold ${valueTone}`}>
                          {sign} {formattedValue}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          {/* Footer */}
          {transactionsTotal !== null && (
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-xs uppercase tracking-[0.2em] text-[var(--muted)]">
              {showLocalFilter ? (
                <span>Resultados: {visibleTransactions.length}</span>
              ) : (
                <span>Exibindo {visibleTransactions.length} de {transactionsTotal}</span>
              )}
              {showPagination ? (
                transactions.length < transactionsTotal ? (
                  <button
                    type="button"
                    disabled={isLoading}
                    onClick={() => setLimit((prev) => prev + pageSize)}
                    className="rounded-full border border-[var(--border)] bg-white px-4 py-2 text-xs font-semibold text-[var(--ink)] transition hover:border-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    Mostrar mais
                  </button>
                ) : (
                  <span>Fim da lista</span>
                )
              ) : (
                <span>Filtro local aplicado</span>
              )}
            </div>
          )}
        </section>

        {/* Batch action bar */}
        {effectiveSelectedIds.size > 0 && (
          <div className="fixed bottom-6 left-4 right-4 z-40 mx-auto max-w-md rounded-2xl border border-[var(--border)] bg-white px-4 py-3 shadow-lg sm:left-1/2 sm:right-auto sm:-translate-x-1/2 sm:px-5">
            {batchCategoryId ? (
              <div className="flex flex-col gap-2">
                <div className="text-center text-sm text-[var(--ink)]">
                  <span className="font-semibold">{effectiveSelectedIds.size}</span>{" "}
                  lançamento{effectiveSelectedIds.size > 1 ? "s" : ""} → <span className="font-semibold">{categories.find((c) => c.id === batchCategoryId)?.name ?? "Categoria"}</span>
                </div>
                <div className="flex items-center justify-center gap-2">
                  <button
                    type="button"
                    onClick={() => batchUpdateCategory(batchCategoryId)}
                    disabled={isBatchUpdating}
                    className="rounded-full border border-emerald-500 bg-emerald-500 px-5 py-1.5 text-xs font-semibold text-white transition hover:opacity-90 disabled:opacity-60"
                  >
                    {isBatchUpdating ? "Salvando..." : "Confirmar"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setBatchCategoryId(null)}
                    disabled={isBatchUpdating}
                    className="rounded-full border border-[var(--border)] px-4 py-1.5 text-xs font-semibold text-[var(--muted)] transition hover:bg-slate-50 disabled:opacity-60"
                  >
                    Trocar
                  </button>
                  <button
                    type="button"
                    onClick={clearSelection}
                    disabled={isBatchUpdating}
                    className="rounded-full border border-[var(--border)] px-4 py-1.5 text-xs font-semibold text-[var(--muted)] transition hover:bg-slate-50 disabled:opacity-60"
                  >
                    Cancelar
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-center gap-3">
                <span className="text-sm font-semibold text-[var(--ink)]">
                  {effectiveSelectedIds.size} selecionado{effectiveSelectedIds.size > 1 ? "s" : ""}
                </span>
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setIsBatchCategoryOpen(!isBatchCategoryOpen)}
                    disabled={isBatchUpdating}
                    className="rounded-full border border-[var(--accent)] bg-[var(--accent)] px-4 py-1.5 text-xs font-semibold text-white transition hover:opacity-90 disabled:opacity-60"
                  >
                    Definir categoria
                  </button>
                  {isBatchCategoryOpen && (
                    <div className="absolute bottom-full right-0 mb-2 w-[min(calc(100vw-32px),288px)] overflow-hidden rounded-xl border border-[var(--border)] bg-white shadow-lg sm:left-0 sm:right-auto sm:w-72">
                      <div className="border-b border-[var(--border)] px-3 py-2">
                        <input
                          type="text"
                          placeholder="Buscar categoria..."
                          value={batchCategorySearch}
                          onChange={(e) => setBatchCategorySearch(e.target.value)}
                          className="w-full rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm outline-none focus:border-[var(--accent)]"
                          autoFocus
                        />
                      </div>
                      <div className="max-h-60 overflow-y-auto">
                        {batchCategoryOptions.length === 0 ? (
                          <p className="px-3 py-2 text-sm text-[var(--muted)]">Nenhuma categoria encontrada</p>
                        ) : (
                          batchCategoryOptions.map((opt) => (
                            <button
                              key={opt.id}
                              type="button"
                              onClick={() => {
                                setBatchCategoryId(opt.id);
                                setIsBatchCategoryOpen(false);
                                setBatchCategorySearch("");
                              }}
                              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition hover:bg-slate-50"
                            >
                              <span
                                className={`inline-block h-2 w-2 rounded-full ${
                                  opt.type === "income" ? "bg-emerald-400" : "bg-rose-400"
                                }`}
                              />
                              {opt.label}
                            </button>
                          ))
                        )}
                      </div>
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={clearSelection}
                  className="rounded-full border border-[var(--border)] px-4 py-1.5 text-xs font-semibold text-[var(--muted)] transition hover:bg-slate-50"
                >
                  Limpar
                </button>
              </div>
            )}
          </div>
        )}

        {/* Calendar Modal */}
        {isCalendarOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center px-4 py-6">
            <button
              type="button"
              aria-label="Fechar calendário"
              onClick={closeCalendar}
              className="absolute inset-0 animate-[overlay-in_0.2s_ease-out] bg-slate-900/40 backdrop-blur-sm"
            />
            <div className="relative z-10 w-full max-w-sm overflow-hidden rounded-3xl border border-[var(--border)] bg-white shadow-[var(--shadow)]">
              <div className="-mx-px -mt-px rounded-t-3xl bg-[var(--accent)] px-5 py-4 text-white">
                <p className="text-[11px] font-semibold uppercase tracking-[0.3em] text-white/70">
                  {calendarTarget === "end" ? "Data final" : "Data inicial"}
                </p>
                <p className="mt-1 text-lg font-semibold">{calendarSelectedLabel}</p>
              </div>
              <div className="px-5 py-4">
                <div className="flex items-center justify-between">
                  <button
                    type="button"
                    onClick={() => {
                      if (calendarMonth === 0) {
                        setCalendarMonth(11);
                        setCalendarYear((prev) => prev - 1);
                      } else {
                        setCalendarMonth((prev) => prev - 1);
                      }
                    }}
                    className="flex h-9 w-9 items-center justify-center rounded-full border border-[var(--border)] text-[var(--muted)] transition hover:border-[var(--accent)]"
                    aria-label="Mês anterior"
                  >
                    <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M15 18l-6-6 6-6" />
                    </svg>
                  </button>
                  <span className="text-sm font-semibold text-[var(--ink)]">{calendarLabel}</span>
                  <button
                    type="button"
                    onClick={() => {
                      if (calendarMonth === 11) {
                        setCalendarMonth(0);
                        setCalendarYear((prev) => prev + 1);
                      } else {
                        setCalendarMonth((prev) => prev + 1);
                      }
                    }}
                    className="flex h-9 w-9 items-center justify-center rounded-full border border-[var(--border)] text-[var(--muted)] transition hover:border-[var(--accent)]"
                    aria-label="Próximo mês"
                  >
                    <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M9 6l6 6-6 6" />
                    </svg>
                  </button>
                </div>
                <div className="mt-3 grid grid-cols-7 gap-1 text-center text-[10px] font-semibold text-[var(--muted)]">
                  {calendarWeekdays.map((weekday) => (
                    <span key={weekday}>{weekday}</span>
                  ))}
                </div>
                <div className="mt-2 grid grid-cols-7 gap-1 text-center text-sm">
                  {calendarDays.map((day, index) => {
                    if (!day) return <span key={`empty-${index}`} />;
                    const isSelected =
                      Boolean(calendarSelectedParts) &&
                      day === calendarSelectedParts?.day &&
                      calendarMonth === calendarSelectedParts?.monthIndex &&
                      calendarYear === calendarSelectedParts?.year;
                    return (
                      <button
                        key={`${calendarYear}-${calendarMonth}-${day}`}
                        type="button"
                        onClick={() => setCalendarTempDate(formatDateKey(calendarYear, calendarMonth, day))}
                        className={`flex h-9 w-9 items-center justify-center rounded-full text-sm font-semibold transition ${
                          isSelected ? "bg-[var(--accent)] text-white" : "text-[var(--ink)] hover:bg-slate-100"
                        }`}
                      >
                        {day}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="flex items-center justify-end gap-3 border-t border-[var(--border)] px-5 py-4">
                <button
                  type="button"
                  onClick={closeCalendar}
                  className="rounded-full border border-[var(--border)] bg-white px-4 py-2 text-xs font-semibold text-[var(--ink)] transition hover:border-[var(--accent)]"
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  onClick={applyCalendar}
                  className="rounded-full bg-[var(--accent)] px-4 py-2 text-xs font-semibold text-white shadow-sm transition hover:bg-[var(--accent-strong)]"
                >
                  Confirmar
                </button>
              </div>
            </div>
          </div>
        )}
      </main>
    </>
  );
}

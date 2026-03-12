"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { useApp, type Category } from "@/contexts/AppContext";
import { getSupabaseClient } from "@/lib/supabase/client";
import { primaryButton } from "@/constants/styles";
import {
  getBrazilToday,
  getDateParts,
  formatDateKey,
  parseBrazilDate,
  addDaysToBrazilDate,
  calendarWeekdays,
} from "@/lib/date-utils";
import { calendarDateFormatter } from "@/lib/formatters";

const supabase = getSupabaseClient();

const monthNamesFull = [
  "Janeiro",
  "Fevereiro",
  "Março",
  "Abril",
  "Maio",
  "Junho",
  "Julho",
  "Agosto",
  "Setembro",
  "Outubro",
  "Novembro",
  "Dezembro",
];

const transactionTypeOptions = [
  { value: "expense", label: "Despesa" },
  { value: "income", label: "Receita" },
  { value: "transfer", label: "Transferência" },
];

const transactionTypeStyles: Record<
  string,
  { active: string; inactive: string }
> = {
  expense: {
    active: "bg-rose-500/10 text-rose-700 shadow-sm",
    inactive: "text-[var(--muted)] hover:text-rose-700",
  },
  income: {
    active: "bg-emerald-500/10 text-emerald-700 shadow-sm",
    inactive: "text-[var(--muted)] hover:text-emerald-700",
  },
  transfer: {
    active: "bg-sky-500/10 text-sky-700 shadow-sm",
    inactive: "text-[var(--muted)] hover:text-sky-700",
  },
};

function isBalanceAdjustCategory(name: string) {
  const normalized = name.toLowerCase().trim();
  return normalized === "ajuste de saldo" || normalized === "balance adjustment";
}

export function TransactionModal() {
  const {
    session,
    activeFamilyId,
    accounts,
    categories,
    archivedCategories,
    transactionModal,
    closeTransactionModal,
    triggerRefresh,
    activeMembership,
  } = useApp();

  // Form state
  const [transactionType, setTransactionType] = useState("expense");
  const [transactionAccountId, setTransactionAccountId] = useState("");
  const [transactionDestinationAccountId, setTransactionDestinationAccountId] =
    useState("");
  const [transactionCategoryId, setTransactionCategoryId] = useState("");
  const [transactionAmount, setTransactionAmount] = useState("");
  const [transactionDescription, setTransactionDescription] = useState("");
  const [transactionTime, setTransactionTime] = useState("");
  const [transactionDate, setTransactionDate] = useState(() =>
    getBrazilToday(),
  );
  const [datePreset, setDatePreset] = useState<
    "today" | "yesterday" | "custom"
  >("today");

  // Calendar state
  const [isCalendarOpen, setIsCalendarOpen] = useState(false);
  const [calendarTempDate, setCalendarTempDate] = useState(() =>
    getBrazilToday(),
  );
  const [calendarMonth, setCalendarMonth] = useState(() => {
    const parts = getDateParts(getBrazilToday());
    return parts ? parts.monthIndex : new Date().getMonth();
  });
  const [calendarYear, setCalendarYear] = useState(() => {
    const parts = getDateParts(getBrazilToday());
    return parts ? parts.year : new Date().getFullYear();
  });

  // Category search state
  const [categorySearch, setCategorySearch] = useState("");
  const [isCategoryDropdownOpen, setIsCategoryDropdownOpen] = useState(false);
  const categoryDropdownRef = useRef<HTMLDivElement>(null);
  const categoryInputRef = useRef<HTMLInputElement>(null);

  // Reconciliation hint state
  const [showHint, setShowHint] = useState(false);
  const [hintDescription, setHintDescription] = useState("");
  const [hintAmountMin, setHintAmountMin] = useState("");
  const [hintAmountMax, setHintAmountMax] = useState("");

  // Transfer linking state (OFX edit mode)
  const [transferTargetAccountId, setTransferTargetAccountId] = useState("");
  const [transferCandidates, setTransferCandidates] = useState<Array<{
    id: string;
    amount: number;
    description: string | null;
    posted_at: string;
  }>>([]);
  const [selectedCandidateId, setSelectedCandidateId] = useState("");
  const [isSearchingCandidates, setIsSearchingCandidates] = useState(false);
  const [isUnlinking, setIsUnlinking] = useState(false);

  // Personal amount state
  const [personalAmountEnabled, setPersonalAmountEnabled] = useState(false);
  const [personalAmountValue, setPersonalAmountValue] = useState("");

  // Error and loading state
  const [transactionError, setTransactionError] = useState<string | null>(null);
  const [isCreatingTransaction, setIsCreatingTransaction] = useState(false);

  // Build category map for parent lookups (needed before useLayoutEffect for edit mode)
  const categoriesById = [...categories, ...archivedCategories].reduce<
    Record<string, Category>
  >((acc, category) => {
    acc[category.id] = category;
    return acc;
  }, {});

  // Derived: editing mode
  const isEditing = Boolean(transactionModal.editTransaction);
  const editTx = transactionModal.editTransaction;
  const isOFXTransaction = Boolean(editTx?.source === "ofx" || editTx?.external_id);

  // Reset form when modal opens
  const prevIsOpen = useRef(false);
  useLayoutEffect(() => {
    if (transactionModal.isOpen && !prevIsOpen.current) {
      const today = getBrazilToday();
      if (editTx) {
        // Edit mode: pre-fill from existing transaction
        const cat = editTx.category_id ? categoriesById[editTx.category_id] : null;
        const catType = cat?.category_type as "expense" | "income" | "transfer" | undefined;
        const isLinkedTransfer = Boolean(editTx.transfer_linked_id) || catType === "transfer";
        const inferredType = isLinkedTransfer ? "transfer" : (catType ?? (Number(editTx.amount) >= 0 ? "income" : "expense"));
        setTransactionType(inferredType);
        setTransactionAccountId(editTx.account_id ?? "");
        setTransactionDestinationAccountId("");
        setTransferTargetAccountId("");
        setTransferCandidates([]);
        setSelectedCandidateId("");
        setIsUnlinking(false);
        setTransactionCategoryId(editTx.category_id ?? "");
        const rawAmount = Number(editTx.amount);
        setTransactionAmount(Number.isFinite(rawAmount) ? String(Math.abs(rawAmount)) : editTx.amount);
        setTransactionDescription(editTx.description ?? "");
        setTransactionTime("");
        const editDate = editTx.posted_at?.slice(0, 10) || today;
        setTransactionDate(editDate);
        setDatePreset("custom");
        setCalendarTempDate(editDate);
        const editParts = getDateParts(editDate);
        if (editParts) {
          setCalendarMonth(editParts.monthIndex);
          setCalendarYear(editParts.year);
        }
      } else {
        // Create mode
        setTransactionType(transactionModal.initialType ?? "expense");
        setTransactionAccountId("");
        setTransactionDestinationAccountId("");
        setTransferTargetAccountId("");
        setTransferCandidates([]);
        setSelectedCandidateId("");
        setIsUnlinking(false);
        setTransactionCategoryId("");
        setCategorySearch("");
        setIsCategoryDropdownOpen(false);
        setTransactionAmount("");
        setTransactionDescription("");
        setTransactionTime("");
        setTransactionDate(today);
        setDatePreset("today");
        setCalendarTempDate(today);
        const todayParts = getDateParts(today);
        if (todayParts) {
          setCalendarMonth(todayParts.monthIndex);
          setCalendarYear(todayParts.year);
        }
      }
      setTransactionError(null);
      setIsCalendarOpen(false);
      // Reset personal amount fields
      if (editTx) {
        if (editTx.personal_amount != null) {
          setPersonalAmountEnabled(true);
          setPersonalAmountValue(String(Math.abs(Number(editTx.personal_amount))));
        } else {
          setPersonalAmountEnabled(false);
          setPersonalAmountValue("");
        }
      } else {
        setPersonalAmountEnabled(false);
        setPersonalAmountValue("");
      }
      // Reset hint fields
      if (editTx) {
        const hint = (editTx as { reconciliation_hint?: { match_description?: string; match_amount_min?: number; match_amount_max?: number } | null }).reconciliation_hint;
        setHintDescription(hint?.match_description ?? "");
        setHintAmountMin(hint?.match_amount_min != null ? String(hint.match_amount_min) : "");
        setHintAmountMax(hint?.match_amount_max != null ? String(hint.match_amount_max) : "");
        setShowHint(Boolean(hint));
      } else {
        setHintDescription("");
        setHintAmountMin("");
        setHintAmountMax("");
        setShowHint(false);
      }
    }
    prevIsOpen.current = transactionModal.isOpen;
  }, [transactionModal.isOpen, transactionModal.initialType, editTx, categoriesById]);

  // Lock body scroll when modal is open
  useEffect(() => {
    if (typeof document === "undefined") return;
    if (!transactionModal.isOpen) return;

    const { body } = document;
    const previousOverflow = body.style.overflow;
    body.style.overflow = "hidden";
    return () => {
      body.style.overflow = previousOverflow;
    };
  }, [transactionModal.isOpen]);

  // Escape key handling
  useEffect(() => {
    if (!transactionModal.isOpen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (isCalendarOpen) {
          setIsCalendarOpen(false);
        } else {
          closeTransactionModal();
        }
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [transactionModal.isOpen, isCalendarOpen, closeTransactionModal]);

  // Search OFX candidates when target account changes
  useEffect(() => {
    if (!isOFXTransaction || transactionType !== "transfer" || !transferTargetAccountId || !editTx) {
      setTransferCandidates([]);
      setSelectedCandidateId("");
      return;
    }

    const searchCandidates = async () => {
      setIsSearchingCandidates(true);
      setTransferCandidates([]);
      setSelectedCandidateId("");

      const txAmount = Number(editTx.amount);
      const oppositeAmount = -txAmount;
      const tolerance = 0.01;
      const txDate = editTx.posted_at?.slice(0, 10);

      if (!txDate || !Number.isFinite(txAmount)) {
        setIsSearchingCandidates(false);
        return;
      }

      // Date range: ±3 days
      const dateObj = new Date(txDate + "T12:00:00Z");
      const minDate = new Date(dateObj.getTime() - 3 * 86400000).toISOString().slice(0, 10);
      const maxDate = new Date(dateObj.getTime() + 3 * 86400000).toISOString().slice(0, 10);

      const { data, error } = await supabase
        .from("transactions")
        .select("id, amount, description, posted_at")
        .eq("account_id", transferTargetAccountId)
        .eq("source", "ofx")
        .is("transfer_linked_id", null)
        .gte("posted_at", minDate)
        .lte("posted_at", maxDate)
        .gte("amount", Math.min(oppositeAmount - tolerance, oppositeAmount + tolerance))
        .lte("amount", Math.max(oppositeAmount - tolerance, oppositeAmount + tolerance));

      if (error) {
        setIsSearchingCandidates(false);
        return;
      }

      const candidates = (data ?? []).map((item) => ({
        id: item.id,
        amount: Number(item.amount),
        description: item.description,
        posted_at: item.posted_at,
      }));

      setTransferCandidates(candidates);
      // Auto-select if exactly one candidate
      if (candidates.length === 1) {
        setSelectedCandidateId(candidates[0].id);
      }
      setIsSearchingCandidates(false);
    };

    searchCandidates();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transferTargetAccountId, transactionType]);

  // Derived state
  const isTransfer = transactionType === "transfer";
  const isOFXTransferLinking = isEditing && isOFXTransaction && isTransfer;
  const isAlreadyLinked = Boolean(editTx?.transfer_linked_id);
  const canCreateTransaction = accounts.length > 0;

  // OFX transfer: infer direction from amount sign
  const editAmount = Number(editTx?.amount);
  const isOutgoing = Number.isFinite(editAmount) && editAmount < 0;
  const transferAccountLabel = isOutgoing ? "Conta destino" : "Conta origem";

  // Available target accounts for OFX transfer linking (exclude current account)
  const transferTargetAccounts = accounts.filter(
    (account) => account.id !== editTx?.account_id,
  );

  const getCategoryDisplayLabel = (id: string, name: string) => {
    const category = categoriesById[id];
    if (!category?.parent_id) return name;
    const parent = categoriesById[category.parent_id];
    return parent ? `${parent.name} / ${name}` : name;
  };

  const buildCategoryOptions = (targetType?: string) => {
    return categories
      .filter((category) => !isBalanceAdjustCategory(category.name))
      .filter((category) =>
        targetType
          ? category.category_type === targetType
          : category.category_type !== "transfer",
      )
      .map((category) => ({
        ...category,
        label: getCategoryDisplayLabel(category.id, category.name),
      }))
      .sort((a, b) => a.label.localeCompare(b.label, "pt-BR"));
  };

  const transactionCategoryOptions =
    transactionType && !isTransfer
      ? buildCategoryOptions(transactionType)
      : [];

  const hasCategoryOptions = transactionCategoryOptions.length > 0;
  const activeTypeLabel =
    transactionTypeOptions.find((option) => option.value === transactionType)
      ?.label ?? "";

  const categorySelectDisabled =
    !transactionType || isTransfer || !hasCategoryOptions;
  const categoryPlaceholder = transactionType
    ? `Buscar categoria de ${activeTypeLabel.toLowerCase()}...`
    : "Selecione o tipo primeiro";

  const filteredCategoryOptions = categorySearch
    ? transactionCategoryOptions.filter((c) =>
        c.label.toLowerCase().includes(categorySearch.toLowerCase()),
      )
    : transactionCategoryOptions;

  const selectedCategoryLabel = transactionCategoryId
    ? transactionCategoryOptions.find((c) => c.id === transactionCategoryId)
        ?.label ?? ""
    : "";

  const handleCategorySelect = useCallback(
    (id: string) => {
      setTransactionCategoryId(id);
      setCategorySearch("");
      setIsCategoryDropdownOpen(false);
    },
    [setTransactionCategoryId],
  );

  // Close category dropdown on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        categoryDropdownRef.current &&
        !categoryDropdownRef.current.contains(e.target as Node)
      ) {
        setIsCategoryDropdownOpen(false);
        setCategorySearch("");
      }
    };
    if (isCategoryDropdownOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      return () =>
        document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [isCategoryDropdownOpen]);

  // Check if editing account is reconcilable (for hint section)
  const editAccountIsReconcilable = isEditing && editTx?.account_id
    ? Boolean(accounts.find((a) => a.id === editTx.account_id)?.is_reconcilable)
    : false;
  const showHintSection = isEditing && !isOFXTransaction && editAccountIsReconcilable;

  // Reconciled period warning
  const selectedAccountForReconciliation = !isEditing ? accounts.find((a) => a.id === transactionAccountId) : null;
  const isInReconciledPeriod = Boolean(
    selectedAccountForReconciliation?.reconciled_until &&
    transactionDate &&
    transactionDate <= selectedAccountForReconciliation.reconciled_until,
  );
  const userRole = activeMembership?.role;
  const isAdminUser = userRole === "owner" || userRole === "admin";
  const showReconciledWarning = isInReconciledPeriod && isAdminUser;

  // Destination accounts (for transfers)
  const destinationAccounts = accounts.filter(
    (account) => account.id !== transactionAccountId,
  );
  const destinationSelectDisabled =
    destinationAccounts.length === 0 || !transactionAccountId;
  const destinationPlaceholder = !transactionAccountId
    ? "Selecione a conta origem"
    : destinationAccounts.length === 0
      ? "Nenhuma outra conta"
      : "Selecione a conta";

  // Date helpers
  const applyDatePreset = (preset: "today" | "yesterday" | "custom") => {
    setDatePreset(preset);
    if (preset === "custom") {
      const customDateParts = getDateParts(transactionDate);
      if (customDateParts) {
        setCalendarMonth(customDateParts.monthIndex);
        setCalendarYear(customDateParts.year);
      }
      setCalendarTempDate(transactionDate);
      setIsCalendarOpen(true);
      return;
    }
    const today = getBrazilToday();
    const nextDate =
      preset === "yesterday" ? addDaysToBrazilDate(today, -1) : today;
    setTransactionDate(nextDate);
    setCalendarTempDate(nextDate);
    setIsCalendarOpen(false);
  };

  const openCalendarPicker = () => {
    const customDateParts = getDateParts(transactionDate);
    if (customDateParts) {
      setCalendarMonth(customDateParts.monthIndex);
      setCalendarYear(customDateParts.year);
    }
    setCalendarTempDate(transactionDate);
    setIsCalendarOpen(true);
  };

  // Calendar computed values
  const selectedDate = parseBrazilDate(transactionDate);
  const selectedDateLabel = calendarDateFormatter
    .format(selectedDate)
    .replace(".", "")
    .toUpperCase();
  const calendarSelectedDate = parseBrazilDate(calendarTempDate);
  const calendarSelectedParts = getDateParts(calendarTempDate);
  const calendarSelectedLabel = calendarDateFormatter
    .format(calendarSelectedDate)
    .replace(".", "")
    .toUpperCase();
  const calendarLabel = `${monthNamesFull[calendarMonth]} ${calendarYear}`;
  const firstWeekday = new Date(calendarYear, calendarMonth, 1).getDay();
  const daysInMonth = new Date(calendarYear, calendarMonth + 1, 0).getDate();
  const calendarDays: Array<number | null> = [];
  for (let idx = 0; idx < firstWeekday; idx += 1) {
    calendarDays.push(null);
  }
  for (let day = 1; day <= daysInMonth; day += 1) {
    calendarDays.push(day);
  }
  while (calendarDays.length % 7 !== 0) {
    calendarDays.push(null);
  }

  // Form submission
  const handleCreateTransaction = async (
    event: FormEvent<HTMLFormElement>,
  ) => {
    event.preventDefault();
    setTransactionError(null);

    if (!session?.access_token || !activeFamilyId) {
      setTransactionError("Selecione uma família ativa.");
      return;
    }

    if (!transactionAccountId) {
      setTransactionError("Selecione a conta.");
      return;
    }

    if (!transactionType) {
      setTransactionError("Selecione o tipo.");
      return;
    }

    if (isTransfer && !isEditing) {
      if (!transactionDestinationAccountId) {
        setTransactionError("Selecione a conta destino.");
        return;
      }

      if (transactionDestinationAccountId === transactionAccountId) {
        setTransactionError("A conta destino deve ser diferente.");
        return;
      }
    }

    if (!isTransfer && !isEditing) {
      if (!transactionCategoryId) {
        setTransactionError("Selecione a categoria.");
        return;
      }

      const selectedCategory = categories.find(
        (category) => category.id === transactionCategoryId,
      );
      if (!selectedCategory || selectedCategory.category_type !== transactionType) {
        setTransactionError(
          "Selecione uma categoria válida para o tipo escolhido.",
        );
        return;
      }
    }

    const normalizedAmount = transactionAmount.replace(",", ".").trim();
    const amountValue = Number(normalizedAmount);

    if (!isEditing && (!Number.isFinite(amountValue) || amountValue <= 0)) {
      setTransactionError("Informe um valor válido.");
      return;
    }

    if (!transactionDate) {
      setTransactionError("Informe a data.");
      return;
    }

    // Check reconciled period for manual transactions (not editing)
    if (!isEditing && transactionAccountId) {
      const selectedAccount = accounts.find((a) => a.id === transactionAccountId);
      if (selectedAccount?.reconciled_until && transactionDate <= selectedAccount.reconciled_until) {
        const userRole = activeMembership?.role;
        const isAdmin = userRole === "owner" || userRole === "admin";
        if (!isAdmin) {
          setTransactionError(
            `Período reconciliado até ${selectedAccount.reconciled_until}. Lançamentos manuais neste período exigem permissão de administrador.`,
          );
          return;
        }
      }
    }

    const submitter = (event.nativeEvent as SubmitEvent).submitter as
      | HTMLButtonElement
      | null;
    const submitAction = submitter?.dataset.action ?? "close";

    setIsCreatingTransaction(true);
    let insertError: { message: string } | null = null;

    // Edit mode: update existing transaction
    if (isEditing && editTx) {
      // OFX Transfer linking flow
      if (isOFXTransferLinking && !isAlreadyLinked) {
        if (!transferTargetAccountId) {
          setTransactionError("Selecione a conta para vincular a transferência.");
          setIsCreatingTransaction(false);
          return;
        }

        // Find transfer category
        const transferCategory = categories.find((c) => c.category_type === "transfer");
        const transferCategoryId = transferCategory?.id ?? null;

        if (selectedCandidateId) {
          // Link two existing OFX transactions atomically via RPC
          const { error: linkErr } = await supabase.rpc("link_transfer", {
            tx_a: editTx.id,
            tx_b: selectedCandidateId,
            transfer_category: transferCategoryId,
          });
          if (linkErr) {
            insertError = linkErr;
          }
        } else {
          // Create counterpart in target account
          const txAmount = Number(editTx.amount);
          const counterpartAmount = -txAmount;
          const currentAccount = accounts.find((a) => a.id === editTx.account_id);
          const counterpartDesc = isOutgoing
            ? `Transferência de ${currentAccount?.name ?? "conta"}`
            : `Transferência para ${currentAccount?.name ?? "conta"}`;

          const { data: inserted, error: insertErr } = await supabase
            .from("transactions")
            .insert({
              account_id: transferTargetAccountId,
              category_id: transferCategoryId,
              amount: counterpartAmount,
              currency: "BRL",
              description: counterpartDesc,
              posted_at: editTx.posted_at,
              source: "manual",
            })
            .select("id")
            .single();

          if (insertErr || !inserted) {
            insertError = insertErr ?? { message: "Erro ao criar contrapartida" };
          } else {
            // Link both sides atomically via RPC
            const { error: linkErr } = await supabase.rpc("link_transfer", {
              tx_a: editTx.id,
              tx_b: inserted.id,
              transfer_category: transferCategoryId,
            });
            // Also update description on the OFX side (separate from link)
            if (!linkErr) {
              const newDesc = transactionDescription.trim() || editTx.description;
              if (newDesc !== editTx.description) {
                await supabase
                  .from("transactions")
                  .update({ description: newDesc })
                  .eq("id", editTx.id);
              }
            }
            if (linkErr) {
              insertError = linkErr;
            }
          }
        }
      } else {
        // Standard edit flow (non-transfer)

        // Build reconciliation_hint JSONB
        let reconciliationHint: Record<string, unknown> | null = null;
        if (showHintSection) {
          const hasHintData = hintDescription.trim() || hintAmountMin || hintAmountMax;
          if (hasHintData) {
            reconciliationHint = {};
            if (hintDescription.trim()) {
              reconciliationHint.match_description = hintDescription.trim();
            }
            if (hintAmountMin) {
              reconciliationHint.match_amount_min = Number(hintAmountMin);
            }
            if (hintAmountMax) {
              reconciliationHint.match_amount_max = Number(hintAmountMax);
            }
          }
        }

        // Determine if category type changed and flip amount sign accordingly
        const oldCat = editTx.category_id ? categoriesById[editTx.category_id] : null;
        const newCat = transactionCategoryId ? categoriesById[transactionCategoryId] : null;
        const oldType = oldCat?.category_type;
        const newType = newCat?.category_type;
        const currentAmount = Number(editTx.amount);

        const updatePayload: Record<string, unknown> = {
          description: transactionDescription.trim() || null,
          category_id: transactionCategoryId || null,
          posted_at: transactionDate,
          auto_categorized: false,
        };

        // Flip sign when switching between expense and income
        if (
          Number.isFinite(currentAmount) &&
          oldType && newType && oldType !== newType &&
          ((oldType === "expense" && newType === "income") ||
           (oldType === "income" && newType === "expense"))
        ) {
          updatePayload.amount = -currentAmount;
        }
        if (showHintSection) {
          updatePayload.reconciliation_hint = reconciliationHint;
        }

        // Personal amount
        if (personalAmountEnabled) {
          const paValue = Number(personalAmountValue);
          if (Number.isFinite(paValue)) {
            // Apply same sign as the transaction amount
            const currentAmt = updatePayload.amount != null ? Number(updatePayload.amount) : Number(editTx.amount);
            updatePayload.personal_amount = currentAmt < 0 ? -paValue : paValue;
          }
        } else {
          updatePayload.personal_amount = null;
        }

        const { error } = await supabase
          .from("transactions")
          .update(updatePayload)
          .eq("id", editTx.id);
        if (error) {
          insertError = error;
        }
      }
    } else if (isTransfer) {
      const transferId =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const originAccount = accounts.find(
        (account) => account.id === transactionAccountId,
      );
      const destinationAccount = accounts.find(
        (account) => account.id === transactionDestinationAccountId,
      );
      const baseDescription = transactionDescription.trim();
      const outgoingDescription =
        baseDescription.length > 0
          ? `${baseDescription} (Transferência para ${
              destinationAccount?.name ?? "conta"
            })`
          : `Transferência para ${destinationAccount?.name ?? "conta"}`;
      const incomingDescription =
        baseDescription.length > 0
          ? `${baseDescription} (Transferência de ${originAccount?.name ?? "conta"})`
          : `Transferência de ${originAccount?.name ?? "conta"}`;
      const occurredTimeValue = transactionTime.trim() || null;

      const { error } = await supabase.from("transactions").insert([
        {
          account_id: transactionAccountId,
          category_id: null,
          amount: -amountValue,
          currency: "BRL",
          description: outgoingDescription,
          posted_at: transactionDate,
          occurred_time: occurredTimeValue,
          source: "transfer",
          external_id: transferId,
        },
        {
          account_id: transactionDestinationAccountId,
          category_id: null,
          amount: amountValue,
          currency: "BRL",
          description: incomingDescription,
          posted_at: transactionDate,
          occurred_time: occurredTimeValue,
          source: "transfer",
          external_id: transferId,
        },
      ]);
      if (error) {
        insertError = error;
      }
    } else {
      const occurredTimeValue = transactionTime.trim() || null;
      const signedAmount = transactionType === "expense" ? -Math.abs(amountValue) : Math.abs(amountValue);
      const { error } = await supabase.from("transactions").insert({
        account_id: transactionAccountId,
        category_id: transactionCategoryId,
        amount: signedAmount,
        currency: "BRL",
        description: transactionDescription.trim() || null,
        posted_at: transactionDate,
        occurred_time: occurredTimeValue,
      });
      if (error) {
        insertError = error;
      }
    }

    if (insertError) {
      setTransactionError(insertError.message);
      setIsCreatingTransaction(false);
      return;
    }

    setTransactionAmount("");
    setTransactionDescription("");
    triggerRefresh();
    setIsCreatingTransaction(false);
    if (submitAction === "repeat") {
      return;
    }
    closeTransactionModal();
  };

  if (!transactionModal.isOpen) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center px-3 py-4 sm:items-center sm:px-4 sm:py-6">
      <button
        type="button"
        aria-label="Fechar modal"
        onClick={closeTransactionModal}
        className="absolute inset-0 animate-[overlay-in_0.2s_ease-out] bg-slate-900/40 backdrop-blur-sm"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="novo-lançamento-title"
        className={`relative z-10 flex w-full max-w-2xl animate-[modal-in_0.22s_ease-out] flex-col overflow-hidden rounded-2xl border bg-white sm:rounded-3xl ${
          isCalendarOpen
            ? "border-transparent shadow-none"
            : "border-[var(--border)] shadow-[var(--shadow)]"
        }`}
      >
        <div className="flex items-start justify-between gap-2 border-b border-[var(--border)] px-4 py-3 sm:border-none sm:px-6 sm:pt-6 sm:pb-0">
          <div className="min-w-0">
            <p className="hidden text-[10px] font-semibold uppercase tracking-[0.3em] text-[var(--muted)] sm:block">
              {isEditing ? "Editar lançamento" : "Novo lançamento"}
            </p>
            <h2
              id="novo-lançamento-title"
              className="mt-0.5 text-base font-semibold text-[var(--ink)] sm:mt-2 sm:text-xl"
            >
              {isEditing ? "Editar movimentação" : "Registrar movimentação"}
            </h2>
            <p className="mt-1 hidden text-sm text-[var(--muted)] sm:block">
              {isEditing ? "Altere os campos desejados." : "Preencha os campos abaixo."}
            </p>
          </div>
          <button
            type="button"
            onClick={closeTransactionModal}
            className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-[var(--border)] bg-white text-[var(--muted)] shadow-sm transition hover:border-[var(--accent)] hover:text-[var(--ink)] sm:h-auto sm:w-auto sm:px-4 sm:py-2 sm:text-xs sm:font-semibold sm:text-[var(--ink)]"
            aria-label="Fechar"
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              className="h-4 w-4 sm:mr-2"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M18 6L6 18" />
              <path d="M6 6l12 12" />
            </svg>
            <span className="hidden sm:inline">Fechar</span>
          </button>
        </div>

        <div className="max-h-[calc(100vh-10rem)] flex-1 overflow-y-auto px-5 py-4 sm:max-h-[calc(100vh-16rem)] sm:px-6 sm:py-6">
          {!canCreateTransaction ? (
            <div className="rounded-2xl border border-dashed border-[var(--border)] bg-slate-50 px-4 py-4 text-sm text-[var(--muted)]">
              Crie ao menos uma conta para liberar os lançamentos.
            </div>
          ) : (
            <form
              className="grid gap-5 sm:gap-6"
              onSubmit={handleCreateTransaction}
            >
              {/* Transaction Type */}
              {(() => {
                // Editing OFX: only expense/income (no transfer)
                // Editing manual transfer: type is locked
                // Creating: all options
                const editingTransfer = isEditing && editTx?.source === "transfer";
                if (editingTransfer) return null;
                const typeOptions = transactionTypeOptions;
                return (
                  <div className="flex flex-col gap-2">
                    <label className="text-xs font-semibold text-[var(--muted)]">
                      Tipo
                    </label>
                    <div
                      role="group"
                      className={`grid rounded-xl border border-[var(--border)] bg-slate-50 p-1 ${typeOptions.length === 3 ? "grid-cols-3" : "grid-cols-2"}`}
                    >
                      {typeOptions.map((option) => (
                        <button
                          key={option.value}
                          type="button"
                          onClick={() => {
                            setTransactionType(option.value);
                            setTransactionDestinationAccountId("");
                            setTransactionCategoryId("");
                            setTransferTargetAccountId("");
                            setTransferCandidates([]);
                            setSelectedCandidateId("");
                          }}
                          className={`min-w-0 rounded-lg px-2 py-2 text-xs font-semibold transition ${
                            transactionType === option.value
                              ? (transactionTypeStyles[option.value]?.active ??
                                "bg-white text-[var(--accent-strong)] shadow-sm")
                              : (transactionTypeStyles[option.value]?.inactive ??
                                "text-[var(--muted)] hover:text-[var(--ink)]")
                          }`}
                          aria-pressed={transactionType === option.value}
                        >
                          <span className="block truncate">{option.label}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })()}

              {/* Account & Category/Destination */}
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="flex flex-col gap-2">
                  <label className="text-xs font-semibold text-[var(--muted)]">
                    {isTransfer && !isOFXTransferLinking ? "Conta origem" : "Conta"}
                  </label>
                  <div className="relative">
                    <svg
                      aria-hidden="true"
                      viewBox="0 0 24 24"
                      className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--muted)]"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                    >
                      <rect x="3" y="6" width="18" height="12" rx="2" />
                      <path d="M3 10h18" />
                    </svg>
                    <select
                      value={transactionAccountId}
                      onChange={(event) =>
                        setTransactionAccountId(event.target.value)
                      }
                      disabled={isEditing}
                      className="w-full rounded-xl border border-[var(--border)] bg-white px-10 py-3 text-sm text-[var(--ink)] shadow-sm outline-none transition focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--ring)] disabled:cursor-not-allowed disabled:bg-slate-50"
                    >
                      <option value="">Selecione a conta</option>
                      {accounts.map((account) => (
                        <option key={account.id} value={account.id}>
                          {account.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                {isOFXTransferLinking ? (
                  <div className="flex flex-col gap-2">
                    <label className="text-xs font-semibold text-[var(--muted)]">
                      {transferAccountLabel}
                    </label>
                    <div className="relative">
                      <svg
                        aria-hidden="true"
                        viewBox="0 0 24 24"
                        className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--muted)]"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                      >
                        <path d="M4 12h12" />
                        <path d="M12 6l6 6-6 6" />
                      </svg>
                      <select
                        value={transferTargetAccountId}
                        onChange={(event) =>
                          setTransferTargetAccountId(event.target.value)
                        }
                        disabled={isAlreadyLinked}
                        className="w-full rounded-xl border border-[var(--border)] bg-white px-10 py-3 text-sm text-[var(--ink)] shadow-sm outline-none transition focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--ring)] disabled:cursor-not-allowed disabled:bg-slate-50"
                      >
                        <option value="">Selecione a conta</option>
                        {transferTargetAccounts.map((account) => (
                          <option key={account.id} value={account.id}>
                            {account.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                ) : isTransfer ? (
                  <div className="flex flex-col gap-2">
                    <label className="text-xs font-semibold text-[var(--muted)]">
                      Conta destino
                    </label>
                    <div className="relative">
                      <svg
                        aria-hidden="true"
                        viewBox="0 0 24 24"
                        className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--muted)]"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                      >
                        <path d="M4 12h12" />
                        <path d="M12 6l6 6-6 6" />
                      </svg>
                      <select
                        value={transactionDestinationAccountId}
                        onChange={(event) =>
                          setTransactionDestinationAccountId(event.target.value)
                        }
                        disabled={destinationSelectDisabled}
                        className="w-full rounded-xl border border-[var(--border)] bg-white px-10 py-3 text-sm text-[var(--ink)] shadow-sm outline-none transition focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--ring)] disabled:cursor-not-allowed disabled:bg-slate-50"
                      >
                        <option value="">{destinationPlaceholder}</option>
                        {destinationAccounts.map((account) => (
                          <option key={account.id} value={account.id}>
                            {account.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-col gap-2">
                    <label className="text-xs font-semibold text-[var(--muted)]">
                      Categoria
                    </label>
                    <div className="relative" ref={categoryDropdownRef}>
                      <svg
                        aria-hidden="true"
                        viewBox="0 0 24 24"
                        className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--muted)]"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                      >
                        <path d="M7 7h7l5 5-7 7-5-5V7z" />
                        <circle cx="10" cy="10" r="1.2" />
                      </svg>
                      <input
                        ref={categoryInputRef}
                        type="text"
                        value={
                          isCategoryDropdownOpen
                            ? categorySearch
                            : selectedCategoryLabel
                        }
                        onChange={(e) => {
                          setCategorySearch(e.target.value);
                          if (!isCategoryDropdownOpen)
                            setIsCategoryDropdownOpen(true);
                        }}
                        onFocus={() => {
                          if (!categorySelectDisabled) {
                            setIsCategoryDropdownOpen(true);
                            setCategorySearch("");
                          }
                        }}
                        placeholder={categoryPlaceholder}
                        disabled={categorySelectDisabled}
                        autoComplete="off"
                        className="w-full rounded-xl border border-[var(--border)] bg-white px-10 py-3 text-sm text-[var(--ink)] shadow-sm outline-none transition focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--ring)] disabled:cursor-not-allowed disabled:bg-slate-50"
                      />
                      {transactionCategoryId && !isCategoryDropdownOpen ? (
                        <button
                          type="button"
                          onClick={() => {
                            setTransactionCategoryId("");
                            setCategorySearch("");
                            categoryInputRef.current?.focus();
                          }}
                          className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--muted)] hover:text-[var(--ink)]"
                        >
                          <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
                            <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.28 7.22a.75.75 0 00-1.06 1.06L8.94 10l-1.72 1.72a.75.75 0 101.06 1.06L10 11.06l1.72 1.72a.75.75 0 101.06-1.06L11.06 10l1.72-1.72a.75.75 0 00-1.06-1.06L10 8.94 8.28 7.22z" clipRule="evenodd" />
                          </svg>
                        </button>
                      ) : null}
                      {isCategoryDropdownOpen &&
                        !categorySelectDisabled ? (
                        <ul className="absolute z-50 mt-1 max-h-48 w-full overflow-y-auto rounded-xl border border-[var(--border)] bg-white py-1 shadow-lg">
                          {filteredCategoryOptions.length === 0 ? (
                            <li className="px-4 py-2 text-xs text-[var(--muted)]">
                              Nenhuma categoria encontrada
                            </li>
                          ) : (
                            filteredCategoryOptions.map((category) => (
                              <li key={category.id}>
                                <button
                                  type="button"
                                  onClick={() =>
                                    handleCategorySelect(category.id)
                                  }
                                  className={`w-full px-4 py-2 text-left text-sm hover:bg-slate-50 ${
                                    category.id === transactionCategoryId
                                      ? "bg-[var(--accent)]/5 font-medium text-[var(--accent)]"
                                      : "text-[var(--ink)]"
                                  }`}
                                >
                                  {category.label}
                                </button>
                              </li>
                            ))
                          )}
                        </ul>
                      ) : null}
                    </div>
                    {transactionType && !hasCategoryOptions ? (
                      <p className="text-xs text-amber-600">
                        Crie uma categoria de {activeTypeLabel} antes de
                        registrar.
                      </p>
                    ) : null}
                  </div>
                )}
              </div>

              {/* OFX Transfer: candidate list */}
              {isOFXTransferLinking && transferTargetAccountId && !isAlreadyLinked ? (
                <div className="rounded-xl border border-[var(--border)] bg-slate-50 p-3">
                  <p className="text-xs font-semibold text-[var(--muted)]">
                    OFX candidatas na conta selecionada
                  </p>
                  {isSearchingCandidates ? (
                    <p className="mt-2 text-xs text-[var(--muted)]">Buscando...</p>
                  ) : transferCandidates.length === 0 ? (
                    <p className="mt-2 text-xs text-[var(--muted)]">
                      Nenhuma OFX correspondente encontrada. Ao salvar, uma contrapartida será criada automaticamente.
                    </p>
                  ) : (
                    <div className="mt-2 space-y-1">
                      {transferCandidates.map((candidate) => {
                        const isSelected = selectedCandidateId === candidate.id;
                        const formattedAmount = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Math.abs(candidate.amount));
                        return (
                          <button
                            key={candidate.id}
                            type="button"
                            onClick={() => setSelectedCandidateId(isSelected ? "" : candidate.id)}
                            className={`flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left text-xs transition ${
                              isSelected
                                ? "border-sky-300 bg-sky-50 text-sky-700"
                                : "border-[var(--border)] bg-white text-[var(--ink)] hover:border-sky-200"
                            }`}
                          >
                            <div className="min-w-0 flex-1">
                              <span className="font-semibold">{candidate.description ?? "Sem descrição"}</span>
                              <span className="ml-2 text-[var(--muted)]">{candidate.posted_at?.slice(0, 10)}</span>
                            </div>
                            <span className={`ml-2 shrink-0 font-semibold ${candidate.amount >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
                              {candidate.amount >= 0 ? "+" : "-"} {formattedAmount}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              ) : null}

              {/* OFX Transfer: unlink button */}
              {isOFXTransferLinking && isAlreadyLinked ? (
                <div className="rounded-xl border border-sky-200 bg-sky-50 px-4 py-3">
                  <p className="text-sm text-sky-700">
                    Esta transação está vinculada como transferência.
                  </p>
                  <button
                    type="button"
                    disabled={isUnlinking}
                    onClick={async () => {
                      if (!editTx?.transfer_linked_id || !editTx?.id) return;
                      setIsUnlinking(true);
                      setTransactionError(null);
                      // Unlink both sides atomically via RPC
                      const { error: unlinkErr } = await supabase.rpc("unlink_transfer", {
                        tx_id: editTx.id,
                      });
                      setIsUnlinking(false);
                      if (unlinkErr) {
                        setTransactionError(unlinkErr.message ?? "Erro ao desvincular");
                        return;
                      }
                      triggerRefresh();
                      closeTransactionModal();
                    }}
                    className="mt-2 rounded-lg border border-sky-300 bg-white px-3 py-1.5 text-xs font-semibold text-sky-700 transition hover:bg-sky-100 disabled:opacity-60"
                  >
                    {isUnlinking ? "Desvinculando..." : "Desvincular transferência"}
                  </button>
                </div>
              ) : null}

              {/* Amount & Date */}
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="flex flex-col gap-2">
                  <label className="text-xs font-semibold text-[var(--muted)]">
                    Valor
                  </label>
                  <div className="relative">
                    <svg
                      aria-hidden="true"
                      viewBox="0 0 24 24"
                      className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--muted)]"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                    >
                      <circle cx="12" cy="12" r="8" />
                      <path d="M9 10h6M9 14h6" />
                    </svg>
                    <input
                      value={transactionAmount}
                      onChange={(event) =>
                        setTransactionAmount(event.target.value)
                      }
                      placeholder="R$ 0,00"
                      inputMode="decimal"
                      disabled={isEditing}
                      className="w-full rounded-xl border border-[var(--border)] bg-white px-10 py-3 text-sm text-[var(--ink)] shadow-sm outline-none transition focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--ring)] disabled:cursor-not-allowed disabled:bg-slate-50"
                    />
                  </div>
                </div>
                <div className="flex flex-col gap-2">
                  <label className="text-xs font-semibold text-[var(--muted)]">
                    Data
                  </label>
                  {isEditing && isOFXTransaction ? (
                    <div className="grid gap-2">
                      <div className="w-full rounded-xl border border-[var(--border)] bg-slate-50 px-4 py-3 text-sm font-semibold text-[var(--muted)]">
                        {selectedDateLabel}
                      </div>
                      <p className="text-xs text-amber-600">
                        Data não editável — veio do extrato bancário.
                      </p>
                    </div>
                  ) : (
                    <div className="grid gap-2">
                      <div
                        role="group"
                        className="grid grid-cols-3 rounded-xl border border-[var(--border)] bg-slate-50 p-1"
                      >
                        {(
                          [
                            { label: "Hoje", value: "today" },
                            { label: "Ontem", value: "yesterday" },
                            { label: "Outros", value: "custom" },
                          ] as const
                        ).map((option) => (
                          <button
                            key={option.value}
                            type="button"
                            onClick={() => applyDatePreset(option.value)}
                            className={`min-w-0 rounded-lg px-2 py-2 text-xs font-semibold transition ${
                              datePreset === option.value
                                ? "bg-white text-[var(--accent-strong)] shadow-sm"
                                : "text-[var(--muted)] hover:text-[var(--ink)]"
                            }`}
                            aria-pressed={datePreset === option.value}
                          >
                            <span className="block truncate">{option.label}</span>
                          </button>
                        ))}
                      </div>
                      {datePreset === "custom" ? (
                        <button
                          type="button"
                          onClick={openCalendarPicker}
                          className="flex w-full items-center justify-between rounded-xl border border-[var(--border)] bg-white px-4 py-3 text-sm font-semibold text-[var(--ink)] shadow-sm transition hover:border-[var(--accent)]"
                        >
                          <span>{selectedDateLabel}</span>
                          <svg
                            aria-hidden="true"
                            viewBox="0 0 24 24"
                            className="h-4 w-4 text-[var(--muted)]"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.5"
                          >
                            <rect x="3" y="5" width="18" height="16" rx="2" />
                            <path d="M16 3v4M8 3v4M3 11h18" />
                          </svg>
                        </button>
                      ) : null}
                    </div>
                  )}
                </div>

                {/* Time */}
                <div className="flex flex-col gap-2">
                  <label className="text-xs font-semibold text-[var(--muted)]">
                    Hora (opcional)
                  </label>
                  <div className="relative">
                    <svg
                      aria-hidden="true"
                      viewBox="0 0 24 24"
                      className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--muted)]"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                    >
                      <circle cx="12" cy="12" r="8" />
                      <path d="M12 7v6l3 2" />
                    </svg>
                    <input
                      value={transactionTime}
                      onChange={(event) =>
                        setTransactionTime(event.target.value)
                      }
                      type="time"
                      step="60"
                      placeholder="HH:MM"
                      className="w-full rounded-xl border border-[var(--border)] bg-white px-10 py-3 text-sm text-[var(--ink)] shadow-sm outline-none transition focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--ring)]"
                    />
                  </div>
                  <p className="text-xs text-[var(--muted)]">
                    Usado apenas no extrato para ordenar lançamentos do mesmo
                    dia.
                  </p>
                </div>
              </div>

              {/* Description */}
              <div className="flex flex-col gap-2">
                <label className="text-xs font-semibold text-[var(--muted)]">
                  Descrição
                </label>
                <div className="relative">
                  <svg
                    aria-hidden="true"
                    viewBox="0 0 24 24"
                    className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--muted)]"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                  >
                    <path d="M7 3h7l5 5v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" />
                    <path d="M14 3v6h6" />
                  </svg>
                  <input
                    value={transactionDescription}
                    onChange={(event) =>
                      setTransactionDescription(event.target.value)
                    }
                    placeholder="Descrição (opcional)"
                    className="w-full rounded-xl border border-[var(--border)] bg-white px-10 py-3 text-sm text-[var(--ink)] shadow-sm outline-none transition focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--ring)]"
                  />
                </div>
                {isEditing && editTx?.original_description && editTx.original_description !== transactionDescription && (
                  <p className="mt-1 text-xs italic text-[var(--muted)]">
                    Original: {editTx.original_description}
                  </p>
                )}
              </div>

              {/* Personal amount (valor nos totais) */}
              {isEditing && transactionType !== "transfer" && (
                <div>
                  <button
                    type="button"
                    onClick={() => setPersonalAmountEnabled(!personalAmountEnabled)}
                    className="flex items-center gap-2 text-xs font-semibold text-[var(--muted)] transition hover:text-[var(--ink)]"
                  >
                    <svg
                      aria-hidden="true"
                      viewBox="0 0 24 24"
                      className={`h-3.5 w-3.5 transition ${personalAmountEnabled ? "rotate-90" : ""}`}
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M9 18l6-6-6-6" />
                    </svg>
                    Valor nos totais
                    {personalAmountEnabled && (
                      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] text-amber-700">
                        Personalizado
                      </span>
                    )}
                  </button>
                  {personalAmountEnabled && (
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <div className="flex flex-col gap-1">
                        <label className="text-[10px] font-semibold text-[var(--muted)]">Valor pessoal</label>
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          value={personalAmountValue}
                          onChange={(e) => setPersonalAmountValue(e.target.value)}
                          placeholder="0.00"
                          className="w-32 rounded-lg border border-[var(--border)] bg-white px-3 py-2 text-sm text-[var(--ink)] outline-none focus:border-[var(--accent)]"
                        />
                      </div>
                      <div className="flex gap-1.5 pt-4">
                        <button type="button" onClick={() => setPersonalAmountValue("0")} className="rounded-full border border-[var(--border)] px-3 py-1 text-xs text-[var(--muted)] hover:bg-slate-50">Ignorar</button>
                        <button type="button" onClick={() => { const half = Math.abs(Number(editTx?.amount ?? 0)) / 2; setPersonalAmountValue(half.toFixed(2)); }} className="rounded-full border border-[var(--border)] px-3 py-1 text-xs text-[var(--muted)] hover:bg-slate-50">50%</button>
                        <button type="button" onClick={() => { setPersonalAmountEnabled(false); setPersonalAmountValue(""); }} className="rounded-full border border-[var(--border)] px-3 py-1 text-xs text-[var(--muted)] hover:bg-slate-50">Original</button>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Reconciliation hint (manual transactions in reconcilable accounts) */}
              {showHintSection ? (
                <div>
                  <button
                    type="button"
                    onClick={() => setShowHint((prev) => !prev)}
                    className="flex items-center gap-2 text-xs font-semibold text-[var(--muted)] transition hover:text-[var(--ink)]"
                  >
                    <svg
                      aria-hidden="true"
                      viewBox="0 0 24 24"
                      className={`h-3.5 w-3.5 transition ${showHint ? "rotate-90" : ""}`}
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M9 18l6-6-6-6" />
                    </svg>
                    Dica de reconciliacao
                  </button>
                  {showHint ? (
                    <div className="mt-2 grid gap-3 rounded-xl border border-[var(--border)] bg-slate-50 p-3 sm:grid-cols-3">
                      <div className="flex flex-col gap-1">
                        <label className="text-[10px] font-semibold text-[var(--muted)]">
                          Descricao OFX contem
                        </label>
                        <input
                          value={hintDescription}
                          onChange={(e) => setHintDescription(e.target.value)}
                          placeholder="PIX FULANO"
                          className="rounded-lg border border-[var(--border)] bg-white px-3 py-2 text-sm text-[var(--ink)] outline-none focus:border-[var(--accent)]"
                        />
                      </div>
                      <div className="flex flex-col gap-1">
                        <label className="text-[10px] font-semibold text-[var(--muted)]">
                          Valor minimo
                        </label>
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          value={hintAmountMin}
                          onChange={(e) => setHintAmountMin(e.target.value)}
                          placeholder="0.00"
                          className="rounded-lg border border-[var(--border)] bg-white px-3 py-2 text-sm text-[var(--ink)] outline-none focus:border-[var(--accent)]"
                        />
                      </div>
                      <div className="flex flex-col gap-1">
                        <label className="text-[10px] font-semibold text-[var(--muted)]">
                          Valor maximo
                        </label>
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          value={hintAmountMax}
                          onChange={(e) => setHintAmountMax(e.target.value)}
                          placeholder="0.00"
                          className="rounded-lg border border-[var(--border)] bg-white px-3 py-2 text-sm text-[var(--ink)] outline-none focus:border-[var(--accent)]"
                        />
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}

              {/* Reconciled period warning (admin override) */}
              {showReconciledWarning && (
                <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">
                  Atenção: esta data está no período reconciliado (até {selectedAccountForReconciliation?.reconciled_until}). Como administrador, você pode prosseguir.
                </div>
              )}

              {/* Error */}
              {transactionError ? (
                <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
                  {transactionError}
                </div>
              ) : null}

              {/* Submit buttons */}
              {isEditing ? (
                <div>
                  <button
                    type="submit"
                    data-action="close"
                    disabled={isCreatingTransaction}
                    className={`${primaryButton} w-full disabled:cursor-not-allowed disabled:opacity-70`}
                  >
                    {isCreatingTransaction ? "Salvando..." : "Salvar"}
                  </button>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  <button
                    type="submit"
                    data-action="close"
                    disabled={isCreatingTransaction}
                    className={`${primaryButton} w-full disabled:cursor-not-allowed disabled:opacity-70`}
                  >
                    {isCreatingTransaction ? "Salvando..." : "Salvar e fechar"}
                  </button>
                  <button
                    type="submit"
                    data-action="repeat"
                    disabled={isCreatingTransaction}
                    className="inline-flex w-full items-center justify-center rounded-xl border border-[var(--border)] bg-white px-4 py-2.5 text-sm font-semibold text-[var(--ink)] shadow-sm transition hover:border-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-70"
                  >
                    {isCreatingTransaction ? "Salvando..." : "Salvar e criar outro"}
                  </button>
                </div>
              )}
            </form>
          )}
        </div>

        {/* Calendar Modal */}
        {isCalendarOpen ? (
          <div className="absolute inset-0 z-20 flex items-center justify-center">
            <button
              type="button"
              aria-label="Fechar calendário"
              onClick={() => setIsCalendarOpen(false)}
              className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm"
            />
            <div className="relative z-10 w-full max-w-sm overflow-hidden rounded-3xl border border-[var(--border)] bg-white shadow-[var(--shadow)]">
              <div className="bg-[var(--accent)] px-5 py-4 text-white">
                <p className="text-[11px] font-semibold uppercase tracking-[0.3em] text-white/70">
                  {calendarYear}
                </p>
                <p className="mt-1 text-lg font-semibold">
                  {calendarSelectedLabel}
                </p>
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
                      <path d="M15 18l-6-6 6-6" />
                    </svg>
                  </button>
                  <span className="text-sm font-semibold text-[var(--ink)]">
                    {calendarLabel}
                  </span>
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
                    if (!day) {
                      return <span key={`empty-${index}`} />;
                    }
                    const isSelected =
                      Boolean(calendarSelectedParts) &&
                      day === calendarSelectedParts?.day &&
                      calendarMonth === calendarSelectedParts?.monthIndex &&
                      calendarYear === calendarSelectedParts?.year;
                    return (
                      <button
                        key={`${calendarYear}-${calendarMonth}-${day}`}
                        type="button"
                        onClick={() => {
                          setCalendarTempDate(
                            formatDateKey(calendarYear, calendarMonth, day),
                          );
                        }}
                        className={`flex h-9 w-9 items-center justify-center rounded-full text-sm font-semibold transition ${
                          isSelected
                            ? "bg-[var(--accent)] text-white"
                            : "text-[var(--ink)] hover:bg-slate-100"
                        }`}
                      >
                        {day}
                      </button>
                    );
                  })}
                </div>
                <div className="mt-4 flex items-center justify-between">
                  <button
                    type="button"
                    onClick={() => setIsCalendarOpen(false)}
                    className="text-xs font-semibold text-[var(--muted)] transition hover:text-[var(--ink)]"
                  >
                    Cancelar
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setTransactionDate(calendarTempDate);
                      setDatePreset("custom");
                      setIsCalendarOpen(false);
                    }}
                    className="text-xs font-semibold text-[var(--accent-strong)] transition hover:text-[var(--accent)]"
                  >
                    OK
                  </button>
                </div>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { useApp, type Account } from "@/contexts/AppContext";
import { getSupabaseClient } from "@/lib/supabase/client";
import { parseOFX, type ParsedOFX } from "@/lib/ofx-parser";
import { primaryButton, secondaryButton, DEFAULT_ACCOUNT_ICON_BG, DEFAULT_ACCOUNT_ICON_COLOR } from "@/constants/styles";
import { baseAccountIconOptions } from "@/constants/icons";
import { bankLogoOptions } from "@/lib/bank-logos";

const supabase = getSupabaseClient();

type AccountModalProps = {
  isOpen: boolean;
  onClose: () => void;
  editingAccount: Account | null;
};

export function AccountModal({
  isOpen,
  onClose,
  editingAccount,
}: AccountModalProps) {
  const { session, activeFamilyId, accounts, loadAccounts, triggerRefresh } = useApp();

  // Form state
  const [accountName, setAccountName] = useState("");
  const [accountType, setAccountType] = useState("checking");
  const [accountVisibility, setAccountVisibility] = useState("shared");
  const [accountOpeningBalance, setAccountOpeningBalance] = useState("");
  const [accountIconKey, setAccountIconKey] = useState("initials");
  const [accountIconBg, setAccountIconBg] = useState(DEFAULT_ACCOUNT_ICON_BG);
  const [accountIconColor, setAccountIconColor] = useState(DEFAULT_ACCOUNT_ICON_COLOR);
  const [bankLogoSearch, setBankLogoSearch] = useState("");
  const [accountIsReconcilable, setAccountIsReconcilable] = useState(false);
  const [ofxBankId, setOfxBankId] = useState("");
  const [ofxAccountId, setOfxAccountId] = useState("");

  const [isParsingOfx, setIsParsingOfx] = useState(false);
  const [pendingOfxData, setPendingOfxData] = useState<ParsedOFX | null>(null);

  // Error and loading state
  const [accountError, setAccountError] = useState<string | null>(null);
  const [isCreatingAccount, setIsCreatingAccount] = useState(false);

  const isEditingAccount = editingAccount !== null;

  // Reset form when modal opens - using ref to detect open transition
  const prevIsOpen = useRef(false);

  useLayoutEffect(() => {
    // Only reset when transitioning from closed to open
    if (isOpen && !prevIsOpen.current) {
      setAccountError(null);
      setBankLogoSearch("");

      if (editingAccount) {
        setAccountName(editingAccount.name);
        setAccountType(editingAccount.account_type);
        setAccountVisibility(editingAccount.visibility);
        setAccountOpeningBalance(
          editingAccount.opening_balance !== null &&
          Number.isFinite(editingAccount.opening_balance)
            ? String(editingAccount.opening_balance).replace(".", ",")
            : "",
        );
        setAccountIconKey(editingAccount.icon_key ?? "initials");
        setAccountIconBg(editingAccount.icon_bg ?? DEFAULT_ACCOUNT_ICON_BG);
        setAccountIconColor(editingAccount.icon_color ?? DEFAULT_ACCOUNT_ICON_COLOR);
        setAccountIsReconcilable(editingAccount.is_reconcilable ?? false);
        setOfxBankId(editingAccount.ofx_bank_id ?? "");
        setOfxAccountId(editingAccount.ofx_account_id ?? "");
      } else {
        setAccountName("");
        setAccountType("checking");
        setAccountVisibility("shared");
        setAccountOpeningBalance("");
        setAccountIconKey("initials");
        setAccountIconBg(DEFAULT_ACCOUNT_ICON_BG);
        setAccountIconColor(DEFAULT_ACCOUNT_ICON_COLOR);
        setAccountIsReconcilable(false);
        setOfxBankId("");
        setOfxAccountId("");
        setPendingOfxData(null);
      }
    }
    prevIsOpen.current = isOpen;
  }, [isOpen, editingAccount]);

  // Lock body scroll
  useEffect(() => {
    if (typeof document === "undefined" || !isOpen) return;

    const { body } = document;
    const previousOverflow = body.style.overflow;
    body.style.overflow = "hidden";
    return () => {
      body.style.overflow = previousOverflow;
    };
  }, [isOpen]);

  // Escape key
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  // Filter bank logos
  const filteredBankLogoOptions = bankLogoSearch.trim()
    ? bankLogoOptions.filter((option) =>
        option.label.toLowerCase().includes(bankLogoSearch.toLowerCase()),
      )
    : bankLogoOptions;

  // Handle OFX file to extract bank/account IDs and optionally fill account details
  const handleOfxFile = useCallback(async (file: File, fillAllFields: boolean = false) => {
    if (!file.name.toLowerCase().endsWith(".ofx")) {
      setAccountError("Formato inválido. Envie um arquivo .ofx");
      return;
    }
    setIsParsingOfx(true);
    setAccountError(null);
    try {
      const text = await file.text();
      const parsed = await parseOFX(text);

      // Always fill OFX IDs
      setOfxBankId(parsed.bankId);
      setOfxAccountId(parsed.accountId);

      if (fillAllFields) {
        // Store parsed OFX for importing transactions after account creation
        setPendingOfxData(parsed);

        // Enable reconcilable
        setAccountIsReconcilable(true);

        // Suggest account name based on bank
        if (parsed.bankName) {
          setAccountName(parsed.bankName);
        }

        // Try to find matching bank logo
        const bankNameLower = parsed.bankName.toLowerCase();
        const matchingLogo = bankLogoOptions.find((opt) => {
          const labelLower = opt.label.toLowerCase();
          // Check if bank name contains or is contained in the logo label
          return labelLower.includes(bankNameLower) || bankNameLower.includes(labelLower.split(" ")[0]);
        });
        if (matchingLogo) {
          setAccountIconKey(matchingLogo.key);
        }

        // Calculate opening balance: ledgerBalance - sum(transactions)
        // Opening balance = what the balance was before the first transaction in the statement
        if (parsed.ledgerBalance !== null && parsed.transactions.length > 0) {
          const transactionsSum = parsed.transactions.reduce((sum, tx) => sum + tx.amount, 0);
          const openingBalance = parsed.ledgerBalance - transactionsSum;
          setAccountOpeningBalance(openingBalance.toFixed(2).replace(".", ","));
        } else if (parsed.ledgerBalance !== null) {
          // No transactions, use ledger balance as opening
          setAccountOpeningBalance(parsed.ledgerBalance.toFixed(2).replace(".", ","));
        }
      }
    } catch {
      setAccountError("Erro ao ler arquivo OFX.");
    } finally {
      setIsParsingOfx(false);
    }
  }, []);

  const formatDbError = (message: string): string => {
    if (message.includes("accounts_ofx_ids_unique")) {
      return "Já existe outra conta com esses identificadores OFX.";
    }
    return message;
  };

  const handleCreateAccount = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setAccountError(null);

    if (!session?.access_token || !activeFamilyId) {
      setAccountError("Selecione uma família ativa.");
      return;
    }

    const trimmedName = accountName.trim();
    if (!trimmedName) {
      setAccountError("Informe o nome da conta.");
      return;
    }

    const normalizedBalance = accountOpeningBalance.replace(",", ".").trim();
    const balanceValue = normalizedBalance ? Number(normalizedBalance) : 0;

    if (normalizedBalance && !Number.isFinite(balanceValue)) {
      setAccountError("Saldo inicial inválido.");
      return;
    }

    setIsCreatingAccount(true);

    // Create the account and get its ID
    const { data: insertedAccount, error } = await supabase
      .from("accounts")
      .insert({
        family_id: activeFamilyId,
        name: trimmedName,
        account_type: accountType,
        visibility: accountVisibility,
        opening_balance: balanceValue,
        icon_key: accountIconKey,
        icon_bg: accountIconBg,
        icon_color: accountIconColor,
        is_reconcilable: accountIsReconcilable,
        ofx_bank_id: ofxBankId.trim() || null,
        ofx_account_id: ofxAccountId.trim() || null,
      })
      .select("id")
      .single();

    if (error || !insertedAccount) {
      setAccountError(formatDbError(error?.message ?? "Erro ao criar conta"));
      setIsCreatingAccount(false);
      return;
    }

    // If we have pending OFX data, import the transactions
    if (pendingOfxData && pendingOfxData.transactions.length > 0) {
      try {
        // Generate raw hash for deduplication
        const rawHash = `${pendingOfxData.bankId}-${pendingOfxData.accountId}-${pendingOfxData.startDate}-${pendingOfxData.endDate}-${pendingOfxData.transactions.length}`;

        const response = await fetch("/api/imports/confirm", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({
            accountId: insertedAccount.id,
            familyId: activeFamilyId,
            transactions: pendingOfxData.transactions,
            source: "ofx",
            rawHash,
            startDate: pendingOfxData.startDate,
            endDate: pendingOfxData.endDate,
            ledgerBalance: pendingOfxData.ledgerBalance,
          }),
        });

        if (!response.ok) {
          const errorData = await response.json();
          console.error("Error importing transactions:", errorData);
          // Account was created, but transactions failed - show warning but don't fail
          setAccountError(`Conta criada, mas erro ao importar transações: ${errorData.error || "Erro desconhecido"}`);
          await loadAccounts(activeFamilyId);
          triggerRefresh();
          setIsCreatingAccount(false);
          return;
        }
      } catch (importError) {
        console.error("Error importing transactions:", importError);
        setAccountError("Conta criada, mas erro ao importar transações.");
        await loadAccounts(activeFamilyId);
        triggerRefresh();
        setIsCreatingAccount(false);
        return;
      }
    }

    await loadAccounts(activeFamilyId);
    triggerRefresh();
    setIsCreatingAccount(false);
    onClose();
  };

  const handleUpdateAccount = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setAccountError(null);

    if (!session?.access_token || !activeFamilyId || !editingAccount) {
      setAccountError("Selecione uma família ativa.");
      return;
    }

    const trimmedName = accountName.trim();
    if (!trimmedName) {
      setAccountError("Informe o nome da conta.");
      return;
    }

    const normalizedBalance = accountOpeningBalance.replace(",", ".").trim();
    const balanceValue = normalizedBalance ? Number(normalizedBalance) : 0;

    if (normalizedBalance && !Number.isFinite(balanceValue)) {
      setAccountError("Saldo inicial inválido.");
      return;
    }

    setIsCreatingAccount(true);

    const { error } = await supabase
      .from("accounts")
      .update({
        name: trimmedName,
        account_type: accountType,
        visibility: accountVisibility,
        opening_balance: balanceValue,
        icon_key: accountIconKey,
        icon_bg: accountIconBg,
        icon_color: accountIconColor,
        is_reconcilable: accountIsReconcilable,
        ofx_bank_id: ofxBankId.trim() || null,
        ofx_account_id: ofxAccountId.trim() || null,
      })
      .eq("id", editingAccount.id);

    if (error) {
      setAccountError(formatDbError(error.message));
      setIsCreatingAccount(false);
      return;
    }

    await loadAccounts(activeFamilyId);
    triggerRefresh();
    setIsCreatingAccount(false);
    onClose();
  };

  // Check if the current OFX IDs conflict with another account
  const ofxDuplicateAccount = (() => {
    const bankTrimmed = ofxBankId.trim();
    const acctTrimmed = ofxAccountId.trim();
    if (!bankTrimmed || !acctTrimmed) return null;
    return accounts.find(
      (a) =>
        a.ofx_bank_id === bankTrimmed &&
        a.ofx_account_id === acctTrimmed &&
        a.id !== editingAccount?.id,
    ) ?? null;
  })();

  if (!isOpen) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center px-3 py-4 sm:items-center sm:px-4 sm:py-6">
      <button
        type="button"
        aria-label="Fechar modal"
        onClick={onClose}
        className="absolute inset-0 animate-[overlay-in_0.2s_ease-out] bg-slate-900/40 backdrop-blur-sm"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="conta-modal-title"
        className="relative z-10 w-full max-w-lg animate-[modal-in_0.22s_ease-out] overflow-hidden rounded-3xl border border-[var(--border)] bg-white shadow-[var(--shadow)]"
      >
        <div className="flex items-start justify-between gap-2 border-b border-[var(--border)] px-5 py-4">
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-[0.3em] text-[var(--muted)]">
              {isEditingAccount ? "Editar conta" : "Nova conta"}
            </p>
            <h2
              id="conta-modal-title"
              className="mt-1 text-lg font-semibold text-[var(--ink)]"
            >
              {isEditingAccount ? "Atualizar informações" : "Adicionar conta"}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-[var(--border)] bg-white text-[var(--muted)] shadow-sm transition hover:border-[var(--accent)] hover:text-[var(--ink)]"
            aria-label="Fechar"
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
              <path d="M18 6L6 18" />
              <path d="M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="max-h-[calc(100vh-12rem)] overflow-y-auto px-5 py-5">
          <form
            className="grid gap-4"
            onSubmit={isEditingAccount ? handleUpdateAccount : handleCreateAccount}
          >
            {/* Import from OFX banner (only for new accounts) */}
            {!isEditingAccount && (
              <div className={`rounded-2xl border p-4 ${pendingOfxData ? "border-emerald-200 bg-emerald-50" : "border-sky-200 bg-sky-50"}`}>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className={`text-sm font-semibold ${pendingOfxData ? "text-emerald-900" : "text-sky-900"}`}>
                      {pendingOfxData ? "Extrato OFX carregado" : "Criar a partir de extrato"}
                    </p>
                    <p className={`mt-0.5 text-xs ${pendingOfxData ? "text-emerald-700" : "text-sky-700"}`}>
                      {pendingOfxData
                        ? `${pendingOfxData.transactions.length} transações de ${pendingOfxData.startDate} a ${pendingOfxData.endDate}`
                        : "Preenche nome, saldo e importa as transações do extrato"}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {pendingOfxData && (
                      <button
                        type="button"
                        onClick={() => {
                          setPendingOfxData(null);
                          setOfxBankId("");
                          setOfxAccountId("");
                        }}
                        className="rounded-xl border border-emerald-300 bg-white px-3 py-2 text-xs font-semibold text-emerald-700 shadow-sm transition hover:bg-emerald-100"
                      >
                        Limpar
                      </button>
                    )}
                    <label className="relative cursor-pointer">
                      <span className={`inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-xs font-semibold shadow-sm transition ${
                        pendingOfxData
                          ? "border-emerald-300 bg-white text-emerald-700 hover:bg-emerald-100"
                          : "border-sky-300 bg-white text-sky-700 hover:bg-sky-100"
                      } ${isParsingOfx ? "pointer-events-none opacity-60" : ""}`}>
                        {isParsingOfx ? (
                          <>
                            <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
                            Lendo...
                          </>
                        ) : (
                          <>
                            <svg aria-hidden="true" viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                              <polyline points="17 8 12 3 7 8" />
                              <line x1="12" y1="3" x2="12" y2="15" />
                            </svg>
                            {pendingOfxData ? "Trocar" : "Importar OFX"}
                          </>
                        )}
                      </span>
                      <input
                        type="file"
                        accept=".ofx"
                        className="absolute inset-0 cursor-pointer opacity-0"
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (file) handleOfxFile(file, true);
                          e.target.value = "";
                        }}
                      />
                    </label>
                  </div>
                </div>
              </div>
            )}

            {/* Account Name */}
            <div className="grid gap-2">
              <label className="text-xs font-semibold text-[var(--muted)]">
                Nome da conta
              </label>
              <input
                value={accountName}
                onChange={(event) => setAccountName(event.target.value)}
                placeholder="Ex.: Conta principal"
                className="w-full rounded-xl border border-[var(--border)] bg-white px-4 py-3 text-sm text-[var(--ink)] shadow-sm outline-none transition focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--ring)]"
              />
            </div>

            {/* Icon Selection */}
            <div className="grid gap-2">
              <label className="text-xs font-semibold text-[var(--muted)]">
                Icone da conta
              </label>
              <div className="grid gap-4">
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-[0.3em] text-[var(--muted)]">
                    Icones
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {baseAccountIconOptions.map((option) => {
                      const isActive = accountIconKey === option.key;
                      return (
                        <button
                          key={option.key}
                          type="button"
                          onClick={() => setAccountIconKey(option.key)}
                          aria-label={option.label}
                          aria-pressed={isActive}
                          title={option.label}
                          className={`flex h-10 w-10 items-center justify-center rounded-full border transition ${
                            isActive
                              ? "border-[var(--accent)] ring-2 ring-[var(--ring)]"
                              : "border-[var(--border)] hover:border-[var(--accent)]"
                          }`}
                          style={{
                            backgroundColor: accountIconBg,
                            color: accountIconColor,
                          }}
                        >
                          {option.key === "initials" ? (
                            <span className="text-[10px] font-semibold">Aa</span>
                          ) : (
                            option.icon?.({ className: "h-4 w-4" })
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
                {bankLogoOptions.length ? (
                  <div>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-[10px] font-semibold uppercase tracking-[0.3em] text-[var(--muted)]">
                        Bancos
                      </p>
                      <input
                        value={bankLogoSearch}
                        onChange={(event) => setBankLogoSearch(event.target.value)}
                        placeholder="Buscar banco"
                        className="w-full max-w-[220px] rounded-full border border-[var(--border)] bg-white px-3 py-1.5 text-xs text-[var(--ink)] shadow-sm outline-none transition focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--ring)]"
                      />
                    </div>
                    <div className="mt-2 grid max-h-48 grid-cols-6 gap-2 overflow-auto pr-1 sm:grid-cols-8">
                      {filteredBankLogoOptions.map((option) => {
                        const isActive = accountIconKey === option.key;
                        return (
                          <button
                            key={option.key}
                            type="button"
                            onClick={() => setAccountIconKey(option.key)}
                            aria-label={option.label}
                            aria-pressed={isActive}
                            title={option.label}
                            className={`flex h-10 w-10 items-center justify-center rounded-full border transition ${
                              isActive
                                ? "border-[var(--accent)] ring-2 ring-[var(--ring)]"
                                : "border-[var(--border)] hover:border-[var(--accent)]"
                            }`}
                            style={{ backgroundColor: accountIconBg }}
                          >
                            <img
                              src={option.imageSrc}
                              alt={option.label}
                              className="h-5 w-5 object-contain"
                              loading="lazy"
                            />
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ) : null}
              </div>
              <p className="text-xs text-[var(--muted)]">
                Escolha um icone para facilitar a identificacao da conta.
              </p>
            </div>

            {/* Colors */}
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-2">
                <label className="text-xs font-semibold text-[var(--muted)]">
                  Cor do fundo
                </label>
                <div className="flex items-center gap-3">
                  <input
                    type="color"
                    value={accountIconBg}
                    onChange={(event) => setAccountIconBg(event.target.value)}
                    className="h-10 w-12 rounded-lg border border-[var(--border)] bg-white shadow-sm"
                  />
                  <span className="text-xs font-semibold text-[var(--muted)]">
                    {accountIconBg.toUpperCase()}
                  </span>
                </div>
              </div>
              <div className="grid gap-2">
                <label className="text-xs font-semibold text-[var(--muted)]">
                  Cor do icone
                </label>
                <div className="flex items-center gap-3">
                  <input
                    type="color"
                    value={accountIconColor}
                    onChange={(event) => setAccountIconColor(event.target.value)}
                    className="h-10 w-12 rounded-lg border border-[var(--border)] bg-white shadow-sm"
                  />
                  <span className="text-xs font-semibold text-[var(--muted)]">
                    {accountIconColor.toUpperCase()}
                  </span>
                </div>
              </div>
            </div>

            {/* Opening Balance */}
            <div className="grid gap-2">
              <label className="text-xs font-semibold text-[var(--muted)]">
                Saldo inicial (opcional)
              </label>
              <input
                value={accountOpeningBalance}
                onChange={(event) => setAccountOpeningBalance(event.target.value)}
                placeholder="R$ 0,00"
                inputMode="decimal"
                className="w-full rounded-xl border border-[var(--border)] bg-white px-4 py-3 text-sm text-[var(--ink)] shadow-sm outline-none transition focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--ring)]"
              />
            </div>

            {/* Type and Visibility */}
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-2">
                <label className="text-xs font-semibold text-[var(--muted)]">
                  Tipo
                </label>
                <select
                  value={accountType}
                  onChange={(event) => setAccountType(event.target.value)}
                  className="w-full rounded-xl border border-[var(--border)] bg-white px-4 py-3 text-sm text-[var(--ink)] shadow-sm outline-none transition focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--ring)]"
                >
                  <option value="checking">Conta corrente</option>
                  <option value="savings">Poupanca</option>
                  <option value="credit_card">Cartao</option>
                  <option value="cash">Dinheiro</option>
                </select>
              </div>
              <div className="grid gap-2">
                <label className="text-xs font-semibold text-[var(--muted)]">
                  Visibilidade
                </label>
                <select
                  value={accountVisibility}
                  onChange={(event) => setAccountVisibility(event.target.value)}
                  className="w-full rounded-xl border border-[var(--border)] bg-white px-4 py-3 text-sm text-[var(--ink)] shadow-sm outline-none transition focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--ring)]"
                >
                  <option value="shared">Compartilhada</option>
                  <option value="private">Privada</option>
                </select>
              </div>
            </div>

            {/* Reconcilable toggle */}
            <div className="grid gap-2">
              <label className="flex cursor-pointer items-center gap-3">
                <input
                  type="checkbox"
                  checked={accountIsReconcilable}
                  onChange={(event) => setAccountIsReconcilable(event.target.checked)}
                  className="h-4 w-4 accent-[var(--accent)]"
                />
                <span className="text-sm font-semibold text-[var(--ink)]">
                  Conta reconciliável
                </span>
              </label>
              <p className="text-xs text-[var(--muted)]">
                Habilite para contas que recebem importação de extrato OFX. Após importar, lançamentos manuais no período importado serão bloqueados para não-administradores.
              </p>
            </div>

            {/* OFX account identifiers (only when reconcilable) */}
            {accountIsReconcilable && (
              <div className="grid gap-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="grid gap-2">
                    <label className="text-xs font-semibold text-[var(--muted)]">
                      Código do banco (OFX)
                    </label>
                    <input
                      value={ofxBankId}
                      onChange={(event) => setOfxBankId(event.target.value)}
                      placeholder="Ex.: 0260"
                      className="w-full rounded-xl border border-[var(--border)] bg-white px-4 py-3 text-sm text-[var(--ink)] shadow-sm outline-none transition focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--ring)]"
                    />
                  </div>
                  <div className="grid gap-2">
                    <label className="text-xs font-semibold text-[var(--muted)]">
                      Número da conta (OFX)
                    </label>
                    <input
                      value={ofxAccountId}
                      onChange={(event) => setOfxAccountId(event.target.value)}
                      placeholder="Ex.: 3590614-5"
                      className="w-full rounded-xl border border-[var(--border)] bg-white px-4 py-3 text-sm text-[var(--ink)] shadow-sm outline-none transition focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--ring)]"
                    />
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <label className="relative cursor-pointer">
                    <span className={`${secondaryButton} inline-flex items-center gap-2 text-xs ${isParsingOfx ? "pointer-events-none opacity-60" : ""}`}>
                      {isParsingOfx ? (
                        <>
                          <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
                          Lendo...
                        </>
                      ) : (
                        <>
                          <svg aria-hidden="true" viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                            <polyline points="17 8 12 3 7 8" />
                            <line x1="12" y1="3" x2="12" y2="15" />
                          </svg>
                          Preencher via arquivo OFX
                        </>
                      )}
                    </span>
                    <input
                      type="file"
                      accept=".ofx"
                      className="absolute inset-0 cursor-pointer opacity-0"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) handleOfxFile(file);
                        e.target.value = "";
                      }}
                    />
                  </label>
                  <span className="text-xs text-[var(--muted)]">
                    Extrai o banco e conta do arquivo
                  </span>
                </div>
                {ofxDuplicateAccount && (
                  <p className="text-xs text-amber-600">
                    Esses identificadores já estão em uso pela conta &quot;{ofxDuplicateAccount.name}&quot;.
                  </p>
                )}
              </div>
            )}

            {/* Error */}
            {accountError ? (
              <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
                {accountError}
              </div>
            ) : null}

            {/* Buttons */}
            <div className="grid gap-3 sm:grid-cols-2">
              <button
                type="button"
                onClick={onClose}
                className={`${secondaryButton} w-full`}
              >
                Cancelar
              </button>
              <button
                type="submit"
                disabled={isCreatingAccount || !activeFamilyId}
                className={`${primaryButton} w-full disabled:cursor-not-allowed disabled:opacity-70`}
              >
                {isCreatingAccount
                  ? pendingOfxData
                    ? "Criando e importando..."
                    : "Salvando..."
                  : isEditingAccount
                    ? "Salvar alteracoes"
                    : pendingOfxData
                      ? `Criar conta e importar ${pendingOfxData.transactions.length} transações`
                      : "Criar conta"}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

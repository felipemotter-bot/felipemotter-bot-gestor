"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useApp, type Category } from "@/contexts/AppContext";
import { getSupabaseClient } from "@/lib/supabase/client";
import { primaryButton, secondaryButton } from "@/constants/styles";
import type { Rule, RuleAction, RuleMatch } from "@/types";

const supabase = getSupabaseClient();

type RuleModalProps = {
  isOpen: boolean;
  onClose: () => void;
  editingRule: Rule | null;
  nextPriority: number;
  onSaved: () => void;
};

export function RuleModal({
  isOpen,
  onClose,
  editingRule,
  nextPriority,
  onSaved,
}: RuleModalProps) {
  const { session, activeFamilyId, categories } = useApp();

  // Form state — initialized from editingRule (component is remounted via key prop)
  const initAmountMode = editingRule?.match.amount_exact != null
    ? "exact" as const
    : (editingRule?.match.amount_min != null || editingRule?.match.amount_max != null)
      ? "range" as const
      : "none" as const;
  const [name, setName] = useState(editingRule?.name ?? "");
  const [descContains, setDescContains] = useState(editingRule?.match.description_contains ?? "");
  const [descRegex, setDescRegex] = useState(editingRule?.match.description_regex ?? "");
  const [amountMode, setAmountMode] = useState<"none" | "range" | "exact">(initAmountMode);
  const [amountMin, setAmountMin] = useState(
    initAmountMode === "range" && editingRule?.match.amount_min != null ? String(editingRule.match.amount_min) : "",
  );
  const [amountMax, setAmountMax] = useState(
    initAmountMode === "range" && editingRule?.match.amount_max != null ? String(editingRule.match.amount_max) : "",
  );
  const [amountExact, setAmountExact] = useState(
    initAmountMode === "exact" && editingRule?.match.amount_exact != null ? String(editingRule.match.amount_exact) : "",
  );
  const [dayOfMonth, setDayOfMonth] = useState(editingRule?.match.day_of_month != null ? String(editingRule.match.day_of_month) : "");
  const [dateAfter, setDateAfter] = useState(editingRule?.match.date_after ?? "");
  const [dateBefore, setDateBefore] = useState(editingRule?.match.date_before ?? "");
  const [categoryId, setCategoryId] = useState(editingRule?.action.set_category_id ?? "");
  const [setDescription, setSetDescription] = useState(editingRule?.action.set_description ?? "");

  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const isEditing = editingRule !== null;

  // Group categories by type for select
  const expenseCategories = categories.filter((c) => c.category_type === "expense");
  const incomeCategories = categories.filter((c) => c.category_type === "income");

  const categoriesById = categories.reduce<Record<string, Category>>((acc, cat) => {
    acc[cat.id] = cat;
    return acc;
  }, {});

  const getCategoryLabel = (cat: Category) => {
    if (cat.parent_id) {
      const parent = categoriesById[cat.parent_id];
      return parent ? `${parent.name} / ${cat.name}` : cat.name;
    }
    return cat.name;
  };

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
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);

    if (!session?.access_token || !activeFamilyId) {
      setError("Selecione uma família ativa.");
      return;
    }

    const trimmedName = name.trim();
    if (!trimmedName) {
      setError("Informe o nome da regra.");
      return;
    }

    // Validate at least one match condition
    const hasDesc = descContains.trim().length > 0;
    const hasRegex = descRegex.trim().length > 0;
    const hasAmount = amountMode !== "none";
    const hasDate = dayOfMonth.trim().length > 0 || dateAfter.length > 0 || dateBefore.length > 0;
    if (!hasDesc && !hasRegex && !hasAmount && !hasDate) {
      setError("Defina pelo menos uma condição de correspondência.");
      return;
    }

    // Validate regex
    if (hasRegex) {
      try {
        new RegExp(descRegex.trim(), "i");
      } catch {
        setError("Expressão regular inválida.");
        return;
      }
    }

    if (!categoryId) {
      setError("Selecione uma categoria.");
      return;
    }

    // Build match object
    const match: RuleMatch = {};
    if (hasDesc) match.description_contains = descContains.trim();
    if (hasRegex) match.description_regex = descRegex.trim();
    if (amountMode === "exact" && amountExact) {
      match.amount_exact = parseFloat(amountExact);
    }
    if (amountMode === "range") {
      if (amountMin) match.amount_min = parseFloat(amountMin);
      if (amountMax) match.amount_max = parseFloat(amountMax);
    }
    if (dayOfMonth.trim()) {
      const parsed = parseInt(dayOfMonth.trim(), 10);
      if (parsed >= 1 && parsed <= 31) match.day_of_month = parsed;
    }
    if (dateAfter) match.date_after = dateAfter;
    if (dateBefore) match.date_before = dateBefore;

    const action: RuleAction = { set_category_id: categoryId };
    if (setDescription.trim()) {
      action.set_description = setDescription.trim();
    }

    setIsSaving(true);

    if (isEditing) {
      const { error: updateError } = await supabase
        .from("rules")
        .update({ name: trimmedName, match, action })
        .eq("id", editingRule.id);

      if (updateError) {
        setError(updateError.message);
        setIsSaving(false);
        return;
      }
    } else {
      const { error: insertError } = await supabase.from("rules").insert({
        family_id: activeFamilyId,
        name: trimmedName,
        match,
        action,
        is_active: true,
        priority: nextPriority,
      });

      if (insertError) {
        setError(insertError.message);
        setIsSaving(false);
        return;
      }
    }

    setIsSaving(false);
    onSaved();
    onClose();
  };

  if (!isOpen) return null;

  const inputClass =
    "w-full rounded-xl border border-[var(--border)] bg-white px-4 py-3 text-sm text-[var(--ink)] shadow-sm outline-none transition focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--ring)]";

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
        options.push({ id: sub.id, label: getCategoryLabel(sub) });
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
        aria-labelledby="rule-modal-title"
        className="relative z-10 w-full max-w-lg animate-[modal-in_0.22s_ease-out] overflow-hidden rounded-3xl border border-[var(--border)] bg-white shadow-[var(--shadow)]"
      >
        <div className="flex items-start justify-between gap-2 border-b border-[var(--border)] px-5 py-4">
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-[0.3em] text-[var(--muted)]">
              {isEditing ? "Editar regra" : "Nova regra"}
            </p>
            <h2
              id="rule-modal-title"
              className="mt-1 text-lg font-semibold text-[var(--ink)]"
            >
              {isEditing ? "Atualizar regra" : "Criar regra de categorização"}
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
          <form className="grid gap-5" onSubmit={handleSubmit}>
            {/* Name */}
            <div className="grid gap-2">
              <label className="text-xs font-semibold text-[var(--muted)]">
                Nome da regra
              </label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Ex.: Uber → Transporte"
                className={inputClass}
              />
            </div>

            {/* Match conditions */}
            <div className="grid gap-3">
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">
                Condições
              </p>

              <div className="grid gap-2">
                <label className="text-xs font-semibold text-[var(--muted)]">
                  Descrição contém
                </label>
                <input
                  value={descContains}
                  onChange={(e) => setDescContains(e.target.value)}
                  placeholder="Ex.: uber"
                  className={inputClass}
                />
              </div>

              <div className="grid gap-2">
                <label className="text-xs font-semibold text-[var(--muted)]">
                  Expressão regular (opcional)
                </label>
                <input
                  value={descRegex}
                  onChange={(e) => setDescRegex(e.target.value)}
                  placeholder="Ex.: uber.*trip"
                  className={`${inputClass} font-mono`}
                />
              </div>

              <div className="grid gap-2">
                <label className="text-xs font-semibold text-[var(--muted)]">
                  Valor (opcional)
                </label>
                <div className="flex items-center gap-1 rounded-full border border-[var(--border)] bg-white px-1 py-1 shadow-sm">
                  {(
                    [
                      { value: "none", label: "Sem filtro" },
                      { value: "range", label: "Faixa" },
                      { value: "exact", label: "Exato" },
                    ] as const
                  ).map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => setAmountMode(opt.value)}
                      className={`rounded-full px-3 py-1 text-xs font-semibold transition ${
                        amountMode === opt.value
                          ? "bg-blue-100 text-blue-700"
                          : "text-[var(--muted)] hover:text-blue-600"
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>

                {amountMode === "range" && (
                  <div className="grid grid-cols-2 gap-3">
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={amountMin}
                      onChange={(e) => setAmountMin(e.target.value)}
                      placeholder="Mínimo"
                      className={inputClass}
                    />
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={amountMax}
                      onChange={(e) => setAmountMax(e.target.value)}
                      placeholder="Máximo"
                      className={inputClass}
                    />
                  </div>
                )}

                {amountMode === "exact" && (
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={amountExact}
                    onChange={(e) => setAmountExact(e.target.value)}
                    placeholder="Valor exato"
                    className={inputClass}
                  />
                )}
              </div>

              <div className="grid gap-2">
                <label className="text-xs font-semibold text-[var(--muted)]">
                  Dia do mês (opcional)
                </label>
                <input
                  type="number"
                  min="1"
                  max="31"
                  step="1"
                  value={dayOfMonth}
                  onChange={(e) => setDayOfMonth(e.target.value)}
                  placeholder="Ex.: 5"
                  className={inputClass}
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-2">
                  <label className="text-xs font-semibold text-[var(--muted)]">
                    Data após (opcional)
                  </label>
                  <input
                    type="date"
                    value={dateAfter}
                    onChange={(e) => setDateAfter(e.target.value)}
                    className={inputClass}
                  />
                </div>
                <div className="grid gap-2">
                  <label className="text-xs font-semibold text-[var(--muted)]">
                    Data antes (opcional)
                  </label>
                  <input
                    type="date"
                    value={dateBefore}
                    onChange={(e) => setDateBefore(e.target.value)}
                    className={inputClass}
                  />
                </div>
              </div>
            </div>

            {/* Action */}
            <div className="grid gap-3">
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">
                Ação
              </p>

              <div className="grid gap-2">
                <label className="text-xs font-semibold text-[var(--muted)]">
                  Categoria
                </label>
                <select
                  value={categoryId}
                  onChange={(e) => setCategoryId(e.target.value)}
                  className={inputClass}
                >
                  <option value="">Selecione uma categoria...</option>
                  {renderCategoryOptions(expenseCategories, "Despesas")}
                  {renderCategoryOptions(incomeCategories, "Receitas")}
                </select>
              </div>

              <div className="grid gap-2">
                <label className="text-xs font-semibold text-[var(--muted)]">
                  Renomear descrição (opcional)
                </label>
                <input
                  value={setDescription}
                  onChange={(e) => setSetDescription(e.target.value)}
                  placeholder="Ex.: Uber"
                  className={inputClass}
                />
              </div>
            </div>

            {/* Error */}
            {error ? (
              <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
                {error}
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
                disabled={isSaving || !activeFamilyId}
                className={`${primaryButton} w-full disabled:cursor-not-allowed disabled:opacity-70`}
              >
                {isSaving ? "Salvando..." : isEditing ? "Salvar alterações" : "Criar regra"}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

"use client";

import { useCallback, useEffect, useState } from "react";
import { Header } from "@/components/layout/Header";
import { RuleModal } from "@/components/modals/RuleModal";
import { useApp, type Category } from "@/contexts/AppContext";
import { getSupabaseClient } from "@/lib/supabase/client";
import type { Rule } from "@/types";

const supabase = getSupabaseClient();

export default function RegrasPage() {
  const { session, activeFamilyId, categories } = useApp();

  const [rules, setRules] = useState<Rule[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionLoadingId, setActionLoadingId] = useState<string | null>(null);

  // Modal state
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingRule, setEditingRule] = useState<Rule | null>(null);

  // Categories lookup
  const categoriesById = categories.reduce<Record<string, Category>>((acc, cat) => {
    acc[cat.id] = cat;
    return acc;
  }, {});

  const getCategoryLabel = (id: string) => {
    const cat = categoriesById[id];
    if (!cat) return "Categoria removida";
    if (cat.parent_id) {
      const parent = categoriesById[cat.parent_id];
      return parent ? `${parent.name} / ${cat.name}` : cat.name;
    }
    return cat.name;
  };

  // Load rules
  const loadRules = useCallback(async () => {
    if (!activeFamilyId) return;
    setIsLoading(true);
    const { data, error } = await supabase
      .from("rules")
      .select("*")
      .eq("family_id", activeFamilyId)
      .order("priority", { ascending: true })
      .order("created_at", { ascending: true });

    if (error) {
      setRules([]);
      setIsLoading(false);
      return;
    }
    setRules(data ?? []);
    setIsLoading(false);
  }, [activeFamilyId]);

  useEffect(() => {
    if (!activeFamilyId || !session?.access_token) return;
    let cancelled = false;
    supabase
      .from("rules")
      .select("*")
      .eq("family_id", activeFamilyId)
      .order("priority", { ascending: true })
      .order("created_at", { ascending: true })
      .then(({ data, error }) => {
        if (cancelled) return;
        setRules(error ? [] : (data ?? []));
        setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeFamilyId, session?.access_token]);

  // Handlers
  const openModal = (rule?: Rule) => {
    setEditingRule(rule ?? null);
    setIsModalOpen(true);
  };

  const closeModal = () => {
    setIsModalOpen(false);
    setEditingRule(null);
  };

  const handleToggleActive = async (rule: Rule) => {
    setActionError(null);
    setActionLoadingId(rule.id);
    const { error } = await supabase
      .from("rules")
      .update({ is_active: !rule.is_active })
      .eq("id", rule.id);

    if (error) {
      setActionError(error.message);
      setActionLoadingId(null);
      return;
    }
    await loadRules();
    setActionLoadingId(null);
  };

  const handleDelete = async (rule: Rule) => {
    if (!window.confirm(`Excluir a regra "${rule.name}"?`)) return;
    setActionError(null);
    setActionLoadingId(rule.id);

    const { error } = await supabase.from("rules").delete().eq("id", rule.id);
    if (error) {
      setActionError(error.message);
      setActionLoadingId(null);
      return;
    }
    await loadRules();
    setActionLoadingId(null);
  };

  const handleMove = async (rule: Rule, direction: "up" | "down") => {
    const currentIndex = rules.findIndex((r) => r.id === rule.id);
    const swapIndex = direction === "up" ? currentIndex - 1 : currentIndex + 1;
    if (swapIndex < 0 || swapIndex >= rules.length) return;

    setActionError(null);
    setActionLoadingId(rule.id);

    const other = rules[swapIndex];
    // Swap priorities
    const { error: e1 } = await supabase
      .from("rules")
      .update({ priority: other.priority })
      .eq("id", rule.id);
    const { error: e2 } = await supabase
      .from("rules")
      .update({ priority: rule.priority })
      .eq("id", other.id);

    if (e1 || e2) {
      setActionError((e1 ?? e2)?.message ?? "Erro ao reordenar");
      setActionLoadingId(null);
      return;
    }
    await loadRules();
    setActionLoadingId(null);
  };

  const getMatchSummary = (rule: Rule) => {
    const parts: string[] = [];
    if (rule.match.description_contains) {
      parts.push(`contém "${rule.match.description_contains}"`);
    }
    if (rule.match.description_regex) {
      parts.push(`regex /${rule.match.description_regex}/`);
    }
    if (rule.match.amount_exact != null) {
      parts.push(`valor = R$ ${rule.match.amount_exact.toFixed(2)}`);
    }
    if (rule.match.amount_min != null) {
      parts.push(`valor ≥ R$ ${rule.match.amount_min.toFixed(2)}`);
    }
    if (rule.match.amount_max != null) {
      parts.push(`valor ≤ R$ ${rule.match.amount_max.toFixed(2)}`);
    }
    if (rule.match.day_of_month != null) {
      parts.push(`dia ${rule.match.day_of_month} do mês`);
    }
    if (rule.match.date_after) {
      const [y, m, d] = rule.match.date_after.split("-");
      parts.push(`após ${d}/${m}/${y}`);
    }
    if (rule.match.date_before) {
      const [y, m, d] = rule.match.date_before.split("-");
      parts.push(`antes de ${d}/${m}/${y}`);
    }
    return parts.join(" e ") || "Sem condições";
  };

  const nextPriority =
    rules.length > 0 ? Math.max(...rules.map((r) => r.priority)) + 10 : 0;

  const baseButton =
    "flex h-8 w-8 items-center justify-center rounded-full border border-[var(--border)] bg-white text-[var(--muted)] shadow-sm transition hover:border-[var(--accent)] hover:text-[var(--ink)] disabled:cursor-not-allowed disabled:opacity-60";

  return (
    <>
      <Header />
      <main className="flex flex-col gap-4 sm:gap-6">
        <section className="rounded-3xl border border-[var(--border)] bg-white/80 px-3 py-4 shadow-sm sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold uppercase tracking-[0.3em] text-[var(--muted)]">
                Regras de Categorização
              </h3>
              <p className="mt-2 text-sm text-[var(--muted)]">
                Categorize transações automaticamente durante a importação de extratos.
              </p>
            </div>
            <button
              type="button"
              onClick={() => openModal()}
              aria-label="Criar nova regra"
              title="Nova regra"
              className="flex h-10 w-10 items-center justify-center rounded-full bg-[var(--accent)] text-white shadow-sm shadow-blue-500/30 transition hover:bg-[var(--accent-strong)]"
            >
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
            </button>
          </div>

          {actionError ? (
            <div className="mt-3 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
              {actionError}
            </div>
          ) : null}

          {isLoading ? (
            <p className="mt-4 text-sm text-[var(--muted)]">Carregando regras...</p>
          ) : null}

          {!isLoading && rules.length === 0 ? (
            <div className="mt-6 rounded-2xl border-2 border-dashed border-[var(--border)] p-8 text-center">
              <p className="text-sm text-[var(--muted)]">
                Nenhuma regra criada. Regras categorizam transações automaticamente durante a importação de extratos.
              </p>
              <button
                type="button"
                onClick={() => openModal()}
                className="mt-4 inline-flex items-center gap-2 rounded-xl bg-[var(--accent)] px-4 py-2.5 text-sm font-semibold text-white shadow-sm shadow-blue-500/30 transition hover:bg-[var(--accent-strong)]"
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
                  <path d="M5 12h14" />
                </svg>
                Criar primeira regra
              </button>
            </div>
          ) : null}

          {/* Rules list */}
          {!isLoading && rules.length > 0 ? (
            <div className="mt-5 overflow-hidden rounded-3xl border border-[var(--border)] bg-white shadow-sm">
              {rules.map((rule, index) => {
                const isActionLoading = actionLoadingId === rule.id;
                return (
                  <div
                    key={rule.id}
                    className={`border-b border-[var(--border)] last:border-b-0 ${
                      !rule.is_active ? "opacity-60" : ""
                    }`}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-4">
                      <div className="flex min-w-0 items-center gap-3">
                        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-blue-100 text-sm font-semibold text-blue-700">
                          {index + 1}
                        </span>
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <p className="truncate text-sm font-semibold text-[var(--ink)]">
                              {rule.name}
                            </p>
                            {!rule.is_active && (
                              <span className="shrink-0 rounded-full border border-[var(--border)] bg-white px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.15em] text-[var(--muted)]">
                                Inativa
                              </span>
                            )}
                          </div>
                          <p className="mt-0.5 truncate text-xs text-[var(--muted)]">
                            {getMatchSummary(rule)}
                          </p>
                          <p className="mt-0.5 text-xs font-semibold text-blue-600">
                            → {getCategoryLabel(rule.action.set_category_id)}
                            {rule.action.set_description
                              ? ` (renomear: "${rule.action.set_description}")`
                              : ""}
                          </p>
                        </div>
                      </div>

                      <div className="flex items-center gap-2">
                        {/* Move up */}
                        <button
                          type="button"
                          onClick={() => handleMove(rule, "up")}
                          disabled={isActionLoading || index === 0}
                          className={baseButton}
                          aria-label="Mover para cima"
                          title="Mover para cima"
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
                            <path d="M18 15l-6-6-6 6" />
                          </svg>
                        </button>

                        {/* Move down */}
                        <button
                          type="button"
                          onClick={() => handleMove(rule, "down")}
                          disabled={isActionLoading || index === rules.length - 1}
                          className={baseButton}
                          aria-label="Mover para baixo"
                          title="Mover para baixo"
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
                            <path d="M6 9l6 6 6-6" />
                          </svg>
                        </button>

                        {/* Toggle active */}
                        <button
                          type="button"
                          onClick={() => handleToggleActive(rule)}
                          disabled={isActionLoading}
                          className={`${baseButton} ${
                            rule.is_active
                              ? "border-emerald-300 text-emerald-600"
                              : ""
                          }`}
                          aria-label={rule.is_active ? "Desativar regra" : "Ativar regra"}
                          title={rule.is_active ? "Desativar" : "Ativar"}
                        >
                          {rule.is_active ? (
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
                              <path d="M20 6L9 17l-5-5" />
                            </svg>
                          ) : (
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
                          )}
                        </button>

                        {/* Edit */}
                        <button
                          type="button"
                          onClick={() => openModal(rule)}
                          disabled={isActionLoading}
                          className={baseButton}
                          aria-label="Editar regra"
                          title="Editar"
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
                            <path d="M12 20h9" />
                            <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
                          </svg>
                        </button>

                        {/* Delete */}
                        <button
                          type="button"
                          onClick={() => handleDelete(rule)}
                          disabled={isActionLoading}
                          className={baseButton}
                          aria-label="Excluir regra"
                          title="Excluir"
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
                            <path d="M3 6h18" />
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                            <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                          </svg>
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}

              <button
                type="button"
                onClick={() => openModal()}
                className="flex w-full items-center justify-center gap-3 px-4 py-4 text-xs font-semibold uppercase tracking-[0.2em] text-[var(--muted)] transition hover:bg-slate-50 hover:text-[var(--accent-strong)]"
              >
                <span className="flex h-9 w-9 items-center justify-center rounded-full border border-current">
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
                    <path d="M5 12h14" />
                  </svg>
                </span>
                Nova regra
              </button>
            </div>
          ) : null}
        </section>
      </main>

      {isModalOpen && (
        <RuleModal
          key={editingRule?.id ?? "new"}
          isOpen={isModalOpen}
          onClose={closeModal}
          editingRule={editingRule}
          nextPriority={nextPriority}
          onSaved={loadRules}
        />
      )}
    </>
  );
}

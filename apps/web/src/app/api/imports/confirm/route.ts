import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { validateImportPayload } from "@/lib/import-validation";
import { getImportRateLimiter } from "@/lib/rate-limiter";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

/** Create a service-role client (bypasses RLS — used after explicit auth checks). */
function getServiceClient() {
  return createClient(supabaseUrl, supabaseServiceKey);
}

export async function POST(request: NextRequest) {
  try {
    // ── 1. Auth: extract and verify Bearer token ──────────────────────
    const authHeader = request.headers.get("authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Não autorizado" }, { status: 401 });
    }

    const token = authHeader.slice(7);
    const serviceClient = getServiceClient();

    const {
      data: { user },
      error: authError,
    } = await serviceClient.auth.getUser(token);
    if (authError || !user) {
      return NextResponse.json({ error: "Não autorizado" }, { status: 401 });
    }

    // ── 2. Rate limiting (per user) ───────────────────────────────────
    const limiter = getImportRateLimiter();
    if (!limiter.check(user.id)) {
      return NextResponse.json(
        { error: "Muitas requisições. Aguarde um momento." },
        { status: 429 },
      );
    }

    // ── 3. Parse & validate payload ───────────────────────────────────
    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return NextResponse.json(
        { error: "JSON inválido" },
        { status: 400 },
      );
    }

    const validation = validateImportPayload(rawBody);
    if (!validation.valid) {
      return NextResponse.json(
        { error: validation.error },
        { status: 400 },
      );
    }

    const {
      accountId,
      familyId,
      transactions,
      source,
      rawHash,
      startDate,
      endDate,
      ledgerBalance,
    } = validation.data;

    // ── 4. Authorization: user must be a writer in this family ────────
    const { data: membership } = await serviceClient
      .from("memberships")
      .select("role")
      .eq("user_id", user.id)
      .eq("family_id", familyId)
      .maybeSingle();

    if (!membership) {
      return NextResponse.json(
        { error: "Acesso negado: você não pertence a esta família" },
        { status: 403 },
      );
    }

    const writeRoles = new Set(["owner", "admin", "member"]);
    if (!writeRoles.has(membership.role)) {
      return NextResponse.json(
        { error: "Acesso negado: permissão insuficiente para importar" },
        { status: 403 },
      );
    }

    // ── 5. Authorization: account must belong to the family ───────────
    const { data: account } = await serviceClient
      .from("accounts")
      .select("id, family_id, is_reconcilable, reconciled_until, visibility, owner_user_id")
      .eq("id", accountId)
      .single();

    if (!account || account.family_id !== familyId) {
      return NextResponse.json(
        { error: "Conta não encontrada nesta família" },
        { status: 403 },
      );
    }

    // Private accounts: only owner can import
    if (account.visibility === "private" && account.owner_user_id !== user.id) {
      return NextResponse.json(
        { error: "Acesso negado: conta privada" },
        { status: 403 },
      );
    }

    // ── 6. Idempotency: check existing import batch by hash ──────────
    const { data: existingBatch } = await serviceClient
      .from("import_batches")
      .select("id")
      .eq("family_id", familyId)
      .eq("source", source)
      .eq("raw_hash", rawHash)
      .maybeSingle();

    if (existingBatch) {
      return NextResponse.json(
        { error: "Este arquivo já foi importado anteriormente" },
        { status: 409 },
      );
    }

    // ── 7. Overlap check for reconcilable accounts ────────────────────
    if (account.is_reconcilable && account.reconciled_until && startDate) {
      if (startDate > account.reconciled_until) {
        const gap = Math.ceil(
          (new Date(startDate).getTime() -
            new Date(account.reconciled_until).getTime()) /
            86400000,
        );
        return NextResponse.json(
          {
            error: `Gap de ${gap} dia(s) detectado. O extrato deve começar em ${account.reconciled_until} ou antes para garantir sobreposição.`,
            code: "GAP_DETECTED",
          },
          { status: 400 },
        );
      }
    }

    // ── 8. Create import batch ────────────────────────────────────────
    const { data: batch, error: batchError } = await serviceClient
      .from("import_batches")
      .insert({
        family_id: familyId,
        source,
        raw_hash: rawHash,
        status: "pending",
        metadata: {
          transaction_count: transactions.length,
          imported_at: new Date().toISOString(),
          date_start: startDate ?? null,
          date_end: endDate ?? null,
          ledger_balance: ledgerBalance ?? null,
        },
        created_by: user.id,
      })
      .select("id")
      .single();

    if (batchError) {
      console.error("import-confirm: batch creation failed:", batchError.message);
      return NextResponse.json(
        { error: "Erro ao criar lote de importação" },
        { status: 500 },
      );
    }

    // ── 9. Deduplicate by external_id (FITID) ────────────────────────
    const fitIds = transactions.map((tx) => tx.fitId);
    const { data: existingTransactions } = await serviceClient
      .from("transactions")
      .select("external_id")
      .eq("account_id", accountId)
      .in("external_id", fitIds);

    const existingFitIds = new Set(
      existingTransactions?.map((t) => t.external_id) ?? [],
    );

    const newTransactions = transactions.filter(
      (tx) => !existingFitIds.has(tx.fitId),
    );

    if (newTransactions.length === 0) {
      await serviceClient
        .from("import_batches")
        .update({
          status: "processed",
          processed_at: new Date().toISOString(),
          metadata: {
            transaction_count: 0,
            skipped_duplicates: transactions.length,
          },
        })
        .eq("id", batch.id);

      return NextResponse.json({
        success: true,
        imported: 0,
        duplicates: transactions.length,
        autoCategorized: 0,
        batchId: batch.id,
      });
    }

    // ── 10. Insert transactions ───────────────────────────────────────
    let autoCategorized = 0;

    const transactionsToInsert = newTransactions.map((tx) => {
      const hasCategoryFromClient = tx.category_id != null;
      if (hasCategoryFromClient) autoCategorized++;

      return {
        account_id: accountId,
        amount: tx.amount,
        description: tx.override_description || tx.memo,
        original_description: tx.memo,
        posted_at: tx.postedAt,
        source: "ofx",
        source_hash: tx.hash,
        external_id: tx.fitId,
        import_batch_id: batch.id,
        category_id: tx.category_id ?? null,
        auto_categorized: hasCategoryFromClient,
      };
    });

    const { data: insertedRows, error: insertError } = await serviceClient
      .from("transactions")
      .insert(transactionsToInsert)
      .select("id, category_id, original_description, amount");

    if (insertError) {
      console.error("import-confirm: transaction insert failed:", insertError.message);
      await serviceClient
        .from("import_batches")
        .update({
          status: "failed",
          metadata: { error: insertError.message },
        })
        .eq("id", batch.id);

      return NextResponse.json(
        { error: "Erro ao inserir transações" },
        { status: 500 },
      );
    }

    // ── 11. Server-side rule application (uncategorized) ──────────────
    const uncategorizedRows = (insertedRows ?? []).filter(
      (row) => !row.category_id,
    );

    if (uncategorizedRows.length > 0) {
      const { data: rules } = await serviceClient
        .from("rules")
        .select("id, match, action, priority, created_at")
        .eq("family_id", familyId)
        .eq("is_active", true)
        .order("priority", { ascending: true })
        .order("created_at", { ascending: true });

      if (rules && rules.length > 0) {
        for (const row of uncategorizedRows) {
          const tx = {
            original_description: row.original_description,
            amount: Number(row.amount),
          };

          for (const rule of rules) {
            const match = rule.match as Record<string, unknown>;
            const action = rule.action as Record<string, unknown>;

            let matched = true;
            const desc = (tx.original_description ?? "").toLowerCase();
            const absAmount = Math.abs(tx.amount);

            if (match.description_contains) {
              if (
                !desc.includes(
                  String(match.description_contains).toLowerCase(),
                )
              ) {
                matched = false;
              }
            }

            if (matched && match.description_regex) {
              try {
                const regex = new RegExp(
                  String(match.description_regex),
                  "i",
                );
                if (!regex.test(tx.original_description ?? "")) {
                  matched = false;
                }
              } catch {
                matched = false;
              }
            }

            if (matched && match.amount_exact != null) {
              if (
                Math.abs(absAmount - Math.abs(Number(match.amount_exact))) >
                0.009
              ) {
                matched = false;
              }
            }

            if (matched && match.amount_min != null) {
              if (absAmount < Number(match.amount_min)) {
                matched = false;
              }
            }

            if (matched && match.amount_max != null) {
              if (absAmount > Number(match.amount_max)) {
                matched = false;
              }
            }

            if (matched && action.set_category_id) {
              const updateData: Record<string, unknown> = {
                category_id: action.set_category_id,
                auto_categorized: true,
              };
              if (action.set_description) {
                updateData.description = action.set_description;
              }

              const { error: updateError } = await serviceClient
                .from("transactions")
                .update(updateData)
                .eq("id", row.id);

              if (!updateError) {
                autoCategorized++;
              }
              break;
            }
          }
        }
      }
    }

    // ── 12. Update batch status ───────────────────────────────────────
    await serviceClient
      .from("import_batches")
      .update({
        status: "processed",
        processed_at: new Date().toISOString(),
        metadata: {
          transaction_count: newTransactions.length,
          skipped_duplicates: transactions.length - newTransactions.length,
          auto_categorized: autoCategorized,
          date_start: startDate ?? null,
          date_end: endDate ?? null,
          ledger_balance: ledgerBalance ?? null,
        },
      })
      .eq("id", batch.id);

    // ── 13. Update account reconciliation state (only advance) ────────
    if (endDate) {
      const updateData: Record<string, unknown> = {
        reconciled_until: endDate,
      };
      if (ledgerBalance != null) {
        updateData.reconciled_balance = ledgerBalance;
      }

      const { data: currentAccount } = await serviceClient
        .from("accounts")
        .select("reconciled_until")
        .eq("id", accountId)
        .single();

      const shouldUpdate =
        !currentAccount?.reconciled_until ||
        endDate > currentAccount.reconciled_until;

      if (shouldUpdate) {
        await serviceClient
          .from("accounts")
          .update(updateData)
          .eq("id", accountId);
      }
    }

    return NextResponse.json({
      success: true,
      imported: newTransactions.length,
      duplicates: transactions.length - newTransactions.length,
      autoCategorized,
      batchId: batch.id,
    });
  } catch (error) {
    // Sanitized log: never include full payload or secrets
    const message =
      error instanceof Error ? error.message : "Unknown error";
    console.error("import-confirm: unhandled error:", message);
    return NextResponse.json(
      { error: "Erro ao confirmar importação" },
      { status: 500 },
    );
  }
}

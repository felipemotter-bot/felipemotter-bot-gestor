import type { Rule, RuleMatch } from "@/types";

export type RuleMatchResult = {
  ruleId: string;
  ruleName: string;
  categoryId: string;
  setDescription?: string;
};

type MatchableTransaction = {
  description?: string | null;
  original_description?: string | null;
  memo?: string;
  amount: number;
  postedAt?: string;
  posted_at?: string;
};

function getDescription(tx: MatchableTransaction): string {
  return (tx.original_description ?? tx.memo ?? tx.description ?? "").toLowerCase();
}

export function doesRuleMatch(match: RuleMatch, tx: MatchableTransaction): boolean {
  const desc = getDescription(tx);
  const absAmount = Math.abs(tx.amount);

  if (match.description_contains) {
    if (!desc.includes(match.description_contains.toLowerCase())) {
      return false;
    }
  }

  if (match.description_regex) {
    try {
      const regex = new RegExp(match.description_regex, "i");
      const target = tx.original_description ?? tx.memo ?? tx.description ?? "";
      if (!regex.test(target)) {
        return false;
      }
    } catch {
      return false;
    }
  }

  if (match.amount_exact != null) {
    if (Math.abs(absAmount - Math.abs(match.amount_exact)) > 0.009) {
      return false;
    }
  }

  if (match.amount_min != null) {
    if (absAmount < match.amount_min) {
      return false;
    }
  }

  if (match.amount_max != null) {
    if (absAmount > match.amount_max) {
      return false;
    }
  }

  const txDateStr = tx.postedAt ?? tx.posted_at;
  if (txDateStr && (match.day_of_month != null || match.date_after || match.date_before)) {
    const txDate = txDateStr.slice(0, 10); // "YYYY-MM-DD"
    const day = parseInt(txDate.slice(8, 10), 10);

    if (match.day_of_month != null && day !== match.day_of_month) {
      return false;
    }
    if (match.date_after && txDate < match.date_after) {
      return false;
    }
    if (match.date_before && txDate > match.date_before) {
      return false;
    }
  } else if (!txDateStr && (match.day_of_month != null || match.date_after || match.date_before)) {
    return false;
  }

  return true;
}

export function findMatchingRule(
  rules: Rule[],
  tx: MatchableTransaction,
): RuleMatchResult | null {
  for (const rule of rules) {
    if (!rule.is_active) continue;
    if (doesRuleMatch(rule.match, tx)) {
      return {
        ruleId: rule.id,
        ruleName: rule.name,
        categoryId: rule.action.set_category_id,
        setDescription: rule.action.set_description,
      };
    }
  }
  return null;
}

export function applyRulesToBatch(
  rules: Rule[],
  transactions: MatchableTransaction[],
): Map<number, RuleMatchResult> {
  const sorted = [...rules].sort((a, b) => a.priority - b.priority || a.created_at.localeCompare(b.created_at));
  const results = new Map<number, RuleMatchResult>();

  for (let i = 0; i < transactions.length; i++) {
    const match = findMatchingRule(sorted, transactions[i]);
    if (match) {
      results.set(i, match);
    }
  }

  return results;
}

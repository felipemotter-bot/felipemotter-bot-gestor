"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import type { Session } from "@supabase/supabase-js";
import { getSupabaseClient } from "@/lib/supabase/client";
import { getBrazilToday, getMonthRange } from "@/lib/date-utils";

const supabase = getSupabaseClient();

export type Account = {
  id: string;
  family_id: string;
  name: string;
  account_type: string;
  currency: string;
  visibility: string;
  owner_user_id: string | null;
  opening_balance: number | null;
  icon_key: string | null;
  icon_bg: string | null;
  icon_color: string | null;
  is_archived: boolean;
  is_reconcilable: boolean;
  reconciled_until: string | null;
  reconciled_balance: number | null;
  ofx_bank_id: string | null;
  ofx_account_id: string | null;
  created_at: string;
};

export type Category = {
  id: string;
  name: string;
  category_type: string;
  parent_id: string | null;
  icon_key: string | null;
  icon_bg: string | null;
  icon_color: string | null;
  is_archived: boolean;
  created_at: string;
};

export type Membership = {
  id: string;
  role: string;
  family: { id: string; name: string; created_at: string } | null;
};

export type EditTransaction = {
  id: string;
  description: string | null;
  original_description: string | null;
  category_id: string | null;
  amount: string;
  account_id: string | null;
  posted_at: string;
  source: string | null;
  external_id: string | null;
  transfer_linked_id?: string | null;
  personal_amount?: string | null;
};

type TransactionModalState = {
  isOpen: boolean;
  initialType?: "expense" | "income" | "transfer";
  editTransaction?: EditTransaction;
};

type AppContextType = {
  // Auth
  session: Session | null;
  isChecking: boolean;
  isSigningOut: boolean;
  signOut: () => Promise<void>;

  // Family
  activeFamilyId: string | null;
  setActiveFamilyId: (id: string | null) => void;
  memberships: Membership[];
  isLoadingMemberships: boolean;
  activeMembership: Membership | undefined;
  familyName: string | null;

  // Accounts
  accounts: Account[];
  archivedAccounts: Account[];
  accountBalances: Record<string, number>;
  isLoadingAccounts: boolean;
  isLoadingArchivedAccounts: boolean;
  isLoadingBalances: boolean;
  loadAccounts: (familyId: string) => Promise<void>;
  loadArchivedAccounts: (familyId: string) => Promise<void>;
  loadAccountBalances: (
    accountIds: string[],
    range?: { startDate?: string; endDate?: string },
    openingBalances?: Record<string, number>,
  ) => Promise<void>;

  // Categories
  categories: Category[];
  archivedCategories: Category[];
  isLoadingCategories: boolean;
  isLoadingArchivedCategories: boolean;
  loadCategories: (familyId: string) => Promise<void>;
  loadArchivedCategories: (familyId: string) => Promise<void>;

  // UI Global
  activeMonth: string;
  setActiveMonth: (month: string) => void;
  isSidebarCollapsed: boolean;
  setIsSidebarCollapsed: (collapsed: boolean) => void;
  toggleSidebarCollapse: () => void;
  isMobileMenuOpen: boolean;
  setIsMobileMenuOpen: (open: boolean) => void;

  // Data refresh
  dataRefreshCounter: number;
  triggerRefresh: () => void;

  // Transaction Modal
  transactionModal: TransactionModalState;
  openTransactionModal: (type?: "expense" | "income" | "transfer", editTransaction?: EditTransaction) => void;
  closeTransactionModal: () => void;

  // Computed values
  userInitial: string;
  userEmail: string;
  totalBalance: number;
};

const AppContext = createContext<AppContextType | null>(null);

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) {
    throw new Error("useApp must be used within AppProvider");
  }
  return ctx;
}

export function AppProvider({ children }: { children: ReactNode }) {
  // Auth state
  const [session, setSession] = useState<Session | null>(null);
  const [isChecking, setIsChecking] = useState(true);
  const [isSigningOut, setIsSigningOut] = useState(false);

  // Family state
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [activeFamilyId, setActiveFamilyId] = useState<string | null>(null);
  const [isLoadingMemberships, setIsLoadingMemberships] = useState(false);

  // Accounts state
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [archivedAccounts, setArchivedAccounts] = useState<Account[]>([]);
  const [accountBalances, setAccountBalances] = useState<Record<string, number>>({});
  const [isLoadingAccounts, setIsLoadingAccounts] = useState(false);
  const [isLoadingArchivedAccounts, setIsLoadingArchivedAccounts] = useState(false);
  const [isLoadingBalances, setIsLoadingBalances] = useState(false);

  // Categories state
  const [categories, setCategories] = useState<Category[]>([]);
  const [archivedCategories, setArchivedCategories] = useState<Category[]>([]);
  const [isLoadingCategories, setIsLoadingCategories] = useState(false);
  const [isLoadingArchivedCategories, setIsLoadingArchivedCategories] = useState(false);

  // UI state
  const [activeMonth, setActiveMonth] = useState(() =>
    getBrazilToday().slice(0, 7),
  );
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

  // Refresh counter
  const [dataRefreshCounter, setDataRefreshCounter] = useState(0);

  // Transaction modal state
  const [transactionModal, setTransactionModal] = useState<TransactionModalState>({
    isOpen: false,
  });

  // Auth effect
  useEffect(() => {
    let isMounted = true;

    supabase.auth.getSession().then(({ data }) => {
      if (!isMounted) return;
      setSession(data.session);
      setIsChecking(false);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      if (!isMounted) return;
      setSession(nextSession);
    });

    return () => {
      isMounted = false;
      subscription.unsubscribe();
    };
  }, []);

  // Load memberships when session changes
  const loadMemberships = useCallback(async (userId: string) => {
    setIsLoadingMemberships(true);
    const { data, error } = await supabase
      .from("memberships")
      .select("id, role, family:families ( id, name, created_at )")
      .eq("user_id", userId)
      .order("created_at", { ascending: true });

    if (error) {
      setMemberships([]);
      setIsLoadingMemberships(false);
      return;
    }

    const normalized = (data ?? []).map((item) => ({
      id: item.id,
      role: item.role,
      family: item.family as unknown as { id: string; name: string; created_at: string } | null,
    }));
    setMemberships(normalized);
    setIsLoadingMemberships(false);
  }, []);

  useEffect(() => {
    if (!session?.user.id || !session.access_token) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Intentional: reset on logout
      setMemberships([]);
      return;
    }
    loadMemberships(session.user.id);
  }, [session?.access_token, session?.user.id, loadMemberships]);

  // Set active family when memberships load
  useEffect(() => {
    if (memberships.length === 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Intentional: reset on empty
      setActiveFamilyId(null);
      return;
    }
    const nextFamilyId = memberships[0]?.family?.id ?? null;
    setActiveFamilyId((current) =>
      current === nextFamilyId ? current : nextFamilyId,
    );
  }, [memberships]);

  // Load accounts
  const loadAccounts = useCallback(async (familyId: string) => {
    setIsLoadingAccounts(true);
    const baseSelectLegacy =
      "id, family_id, name, account_type, currency, visibility, owner_user_id, opening_balance, created_at";
    const baseSelect = `${baseSelectLegacy}, icon_key, icon_bg, icon_color`;
    const selectWithArchive = `${baseSelect}, is_archived, is_reconcilable, reconciled_until, reconciled_balance, ofx_bank_id, ofx_account_id`;

    const reconciliationDefaults = {
      is_reconcilable: false,
      reconciled_until: null,
      reconciled_balance: null,
      ofx_bank_id: null,
      ofx_account_id: null,
    };

    const { data, error } = await supabase
      .from("accounts")
      .select(selectWithArchive)
      .eq("family_id", familyId)
      .eq("is_archived", false)
      .order("created_at", { ascending: true });

    if (error) {
      if (error.message?.includes("is_archived")) {
        let fallback: { data: Array<Record<string, unknown>> | null; error: { message?: string } | null } = await supabase
          .from("accounts")
          .select(baseSelect)
          .eq("family_id", familyId)
          .order("created_at", { ascending: true });
        if (fallback.error && fallback.error.message?.includes("icon_")) {
          fallback = await supabase
            .from("accounts")
            .select(baseSelectLegacy)
            .eq("family_id", familyId)
            .order("created_at", { ascending: true });
        }
        if (fallback.error) {
          setAccounts([]);
          setIsLoadingAccounts(false);
          return;
        }
        const normalized = (fallback.data ?? []).map((account) => ({
          ...account,
          is_archived: false,
          icon_key: (account.icon_key as string | null) ?? null,
          icon_bg: (account.icon_bg as string | null) ?? null,
          icon_color: (account.icon_color as string | null) ?? null,
          ...reconciliationDefaults,
        })) as Account[];
        setAccounts(normalized);
        setIsLoadingAccounts(false);
        return;
      }
      if (error.message?.includes("icon_")) {
        const fallback: { data: Array<Record<string, unknown>> | null; error: { message?: string } | null } = await supabase
          .from("accounts")
          .select(`${baseSelectLegacy}, is_archived`)
          .eq("family_id", familyId)
          .eq("is_archived", false)
          .order("created_at", { ascending: true });
        if (fallback.error) {
          setAccounts([]);
          setIsLoadingAccounts(false);
          return;
        }
        const normalized = (fallback.data ?? []).map((account) => ({
          ...account,
          is_archived: (account.is_archived as boolean) ?? false,
          icon_key: null,
          icon_bg: null,
          icon_color: null,
          ...reconciliationDefaults,
        })) as Account[];
        setAccounts(normalized);
        setIsLoadingAccounts(false);
        return;
      }
      setAccounts([]);
      setIsLoadingAccounts(false);
      return;
    }

    const normalized = (data ?? []).map((account) => ({
      ...account,
      is_archived: account.is_archived ?? false,
      icon_key: account.icon_key ?? null,
      icon_bg: account.icon_bg ?? null,
      icon_color: account.icon_color ?? null,
      is_reconcilable: account.is_reconcilable ?? false,
      reconciled_until: account.reconciled_until ?? null,
      reconciled_balance: account.reconciled_balance != null ? Number(account.reconciled_balance) : null,
      ofx_bank_id: account.ofx_bank_id ?? null,
      ofx_account_id: account.ofx_account_id ?? null,
    }));
    setAccounts(normalized);
    setIsLoadingAccounts(false);
  }, []);

  const loadArchivedAccounts = useCallback(async (familyId: string) => {
    setIsLoadingArchivedAccounts(true);
    const baseSelectLegacy =
      "id, family_id, name, account_type, currency, visibility, owner_user_id, opening_balance, created_at";
    const baseSelect = `${baseSelectLegacy}, icon_key, icon_bg, icon_color`;
    const selectWithArchive = `${baseSelect}, is_archived, is_reconcilable, reconciled_until, reconciled_balance, ofx_bank_id, ofx_account_id`;

    const reconciliationDefaults = {
      is_reconcilable: false,
      reconciled_until: null,
      reconciled_balance: null,
      ofx_bank_id: null,
      ofx_account_id: null,
    };

    const { data, error } = await supabase
      .from("accounts")
      .select(selectWithArchive)
      .eq("family_id", familyId)
      .eq("is_archived", true)
      .order("created_at", { ascending: true });

    if (error) {
      if (error.message?.includes("is_archived")) {
        setArchivedAccounts([]);
        setIsLoadingArchivedAccounts(false);
        return;
      }
      if (error.message?.includes("icon_")) {
        const fallback = await supabase
          .from("accounts")
          .select(`${baseSelectLegacy}, is_archived`)
          .eq("family_id", familyId)
          .eq("is_archived", true)
          .order("created_at", { ascending: true });
        if (fallback.error) {
          setArchivedAccounts([]);
          setIsLoadingArchivedAccounts(false);
          return;
        }
        const normalized = (fallback.data ?? []).map((account) => ({
          ...account,
          is_archived: account.is_archived ?? true,
          icon_key: null,
          icon_bg: null,
          icon_color: null,
          ...reconciliationDefaults,
        }));
        setArchivedAccounts(normalized);
        setIsLoadingArchivedAccounts(false);
        return;
      }
      setArchivedAccounts([]);
      setIsLoadingArchivedAccounts(false);
      return;
    }

    const normalized = (data ?? []).map((account) => ({
      ...account,
      is_archived: account.is_archived ?? true,
      icon_key: account.icon_key ?? null,
      icon_bg: account.icon_bg ?? null,
      icon_color: account.icon_color ?? null,
      is_reconcilable: account.is_reconcilable ?? false,
      reconciled_until: account.reconciled_until ?? null,
      reconciled_balance: account.reconciled_balance != null ? Number(account.reconciled_balance) : null,
      ofx_bank_id: account.ofx_bank_id ?? null,
      ofx_account_id: account.ofx_account_id ?? null,
    }));
    setArchivedAccounts(normalized);
    setIsLoadingArchivedAccounts(false);
  }, []);

  // Load categories
  const loadCategories = useCallback(async (familyId: string) => {
    setIsLoadingCategories(true);
    const baseSelect =
      "id, name, category_type, parent_id, icon_key, icon_bg, icon_color, created_at";
    const selectWithArchive = `${baseSelect}, is_archived`;

    const { data, error } = await supabase
      .from("categories")
      .select(selectWithArchive)
      .eq("family_id", familyId)
      .eq("is_archived", false)
      .order("created_at", { ascending: true });

    if (error) {
      if (error.message?.includes("is_archived")) {
        const fallback = await supabase
          .from("categories")
          .select(baseSelect)
          .eq("family_id", familyId)
          .order("created_at", { ascending: true });
        if (fallback.error) {
          setCategories([]);
          setIsLoadingCategories(false);
          return;
        }
        const normalized = (fallback.data ?? []).map((category) => ({
          ...category,
          is_archived: false,
          parent_id: category.parent_id ?? null,
          icon_key: category.icon_key ?? null,
          icon_bg: category.icon_bg ?? null,
          icon_color: category.icon_color ?? null,
        }));
        setCategories(normalized);
        setIsLoadingCategories(false);
        return;
      }
      if (
        error.message?.includes("parent_id") ||
        error.message?.includes("icon_")
      ) {
        const fallback = await supabase
          .from("categories")
          .select(`id, name, category_type, created_at, is_archived`)
          .eq("family_id", familyId)
          .eq("is_archived", false)
          .order("created_at", { ascending: true });
        if (fallback.error) {
          setCategories([]);
          setIsLoadingCategories(false);
          return;
        }
        const normalized = (fallback.data ?? []).map((category) => ({
          ...category,
          is_archived: category.is_archived ?? false,
          parent_id: null,
          icon_key: null,
          icon_bg: null,
          icon_color: null,
        }));
        setCategories(normalized);
        setIsLoadingCategories(false);
        return;
      }
      setCategories([]);
      setIsLoadingCategories(false);
      return;
    }

    const normalized = (data ?? []).map((category) => ({
      ...category,
      is_archived: category.is_archived ?? false,
      parent_id: category.parent_id ?? null,
      icon_key: category.icon_key ?? null,
      icon_bg: category.icon_bg ?? null,
      icon_color: category.icon_color ?? null,
    }));
    setCategories(normalized);
    setIsLoadingCategories(false);
  }, []);

  const loadArchivedCategories = useCallback(async (familyId: string) => {
    setIsLoadingArchivedCategories(true);
    const baseSelect =
      "id, name, category_type, parent_id, icon_key, icon_bg, icon_color, created_at";
    const selectWithArchive = `${baseSelect}, is_archived`;

    const { data, error } = await supabase
      .from("categories")
      .select(selectWithArchive)
      .eq("family_id", familyId)
      .eq("is_archived", true)
      .order("created_at", { ascending: true });

    if (error) {
      if (error.message?.includes("is_archived")) {
        setArchivedCategories([]);
        setIsLoadingArchivedCategories(false);
        return;
      }
      if (
        error.message?.includes("parent_id") ||
        error.message?.includes("icon_")
      ) {
        const fallback = await supabase
          .from("categories")
          .select(`id, name, category_type, created_at, is_archived`)
          .eq("family_id", familyId)
          .eq("is_archived", true)
          .order("created_at", { ascending: true });
        if (fallback.error) {
          setArchivedCategories([]);
          setIsLoadingArchivedCategories(false);
          return;
        }
        const normalized = (fallback.data ?? []).map((category) => ({
          ...category,
          is_archived: category.is_archived ?? true,
          parent_id: null,
          icon_key: null,
          icon_bg: null,
          icon_color: null,
        }));
        setArchivedCategories(normalized);
        setIsLoadingArchivedCategories(false);
        return;
      }
      setArchivedCategories([]);
      setIsLoadingArchivedCategories(false);
      return;
    }

    const normalized = (data ?? []).map((category) => ({
      ...category,
      is_archived: category.is_archived ?? true,
      parent_id: category.parent_id ?? null,
      icon_key: category.icon_key ?? null,
      icon_bg: category.icon_bg ?? null,
      icon_color: category.icon_color ?? null,
    }));
    setArchivedCategories(normalized);
    setIsLoadingArchivedCategories(false);
  }, []);

  // Load account balances
  const loadAccountBalances = useCallback(
    async (
      accountIds: string[],
      range?: { startDate?: string; endDate?: string },
      openingBalances?: Record<string, number>,
    ) => {
      if (accountIds.length === 0) {
        setAccountBalances({});
        return;
      }

      setIsLoadingBalances(true);
      const startDate = range?.startDate ?? "";
      const endDate = range?.endDate ?? "";

      let query = supabase
        .from("transactions")
        .select("account_id, amount, source, category:categories(category_type)");

      if (accountIds.length > 0) {
        query = query.in("account_id", accountIds);
      }
      if (startDate) {
        query = query.gte("posted_at", startDate);
      }
      if (endDate) {
        query = query.lte("posted_at", endDate);
      }

      const { data, error } = await query;

      if (error) {
        setAccountBalances({});
        setIsLoadingBalances(false);
        return;
      }

      const balances = accountIds.reduce<Record<string, number>>((acc, id) => {
        acc[id] = openingBalances?.[id] ?? 0;
        return acc;
      }, {});

      (data ?? []).forEach((item) => {
        const amountValue = Number(item.amount);
        if (!Number.isFinite(amountValue)) return;

        const category = item.category as unknown as { category_type: string } | null;
        let delta = 0;
        if (item.source === "adjustment") {
          delta = amountValue;
        } else if (item.source === "transfer") {
          delta = amountValue;
        } else if (category?.category_type === "income") {
          delta = amountValue;
        } else if (category?.category_type === "expense") {
          delta = -amountValue;
        }

        const accountId = item.account_id as string;
        if (accountId && accountId in balances) {
          balances[accountId] += delta;
        }
      });

      setAccountBalances(balances);
      setIsLoadingBalances(false);
    },
    [],
  );

  // Load data when family changes
  useEffect(() => {
    if (!activeFamilyId || !session?.access_token) {
      /* eslint-disable react-hooks/set-state-in-effect -- Intentional: reset on missing data */
      setAccounts([]);
      setCategories([]);
      setArchivedCategories([]);
      setArchivedAccounts([]);
      /* eslint-enable react-hooks/set-state-in-effect */
      return;
    }

    loadAccounts(activeFamilyId);
    loadCategories(activeFamilyId);
    loadArchivedCategories(activeFamilyId);
  }, [
    activeFamilyId,
    session?.access_token,
    dataRefreshCounter,
    loadAccounts,
    loadCategories,
    loadArchivedCategories,
  ]);

  // Load balances when accounts or month changes
  useEffect(() => {
    if (!activeFamilyId || !session?.access_token || accounts.length === 0) {
      return;
    }

    const monthRange = getMonthRange(activeMonth);
    const openingBalances = accounts.reduce<Record<string, number>>((acc, account) => {
      const rawValue = Number(account.opening_balance ?? 0);
      acc[account.id] = Number.isFinite(rawValue) ? rawValue : 0;
      return acc;
    }, {});

    // eslint-disable-next-line react-hooks/set-state-in-effect -- Intentional: load balances
    loadAccountBalances(
      accounts.map((account) => account.id),
      { endDate: monthRange.endDate || undefined },
      openingBalances,
    );
  }, [
    activeFamilyId,
    session?.access_token,
    accounts,
    activeMonth,
    dataRefreshCounter,
    loadAccountBalances,
  ]);

  // Sign out
  const signOut = useCallback(async () => {
    setIsSigningOut(true);
    await supabase.auth.signOut();
    setIsSigningOut(false);
  }, []);

  // Toggle sidebar
  const toggleSidebarCollapse = useCallback(() => {
    setIsSidebarCollapsed((prev) => !prev);
  }, []);

  // Trigger data refresh
  const triggerRefresh = useCallback(() => {
    setDataRefreshCounter((prev) => prev + 1);
  }, []);

  // Transaction modal handlers
  const openTransactionModal = useCallback(
    (type?: "expense" | "income" | "transfer", editTransaction?: EditTransaction) => {
      setTransactionModal({ isOpen: true, initialType: type, editTransaction });
    },
    [],
  );

  const closeTransactionModal = useCallback(() => {
    setTransactionModal({ isOpen: false });
  }, []);

  // Computed values
  const activeMembership = memberships.find(
    (membership) => membership.family?.id === activeFamilyId,
  );
  const familyName = activeMembership?.family?.name ?? null;
  const userInitial = session?.user.email?.trim().charAt(0).toUpperCase() ?? "U";
  const userEmail = session?.user.email ?? "";
  const totalBalance = Object.values(accountBalances).reduce((sum, value) => {
    if (!Number.isFinite(value)) return sum;
    return sum + value;
  }, 0);

  const value: AppContextType = {
    // Auth
    session,
    isChecking,
    isSigningOut,
    signOut,

    // Family
    activeFamilyId,
    setActiveFamilyId,
    memberships,
    isLoadingMemberships,
    activeMembership,
    familyName,

    // Accounts
    accounts,
    archivedAccounts,
    accountBalances,
    isLoadingAccounts,
    isLoadingArchivedAccounts,
    isLoadingBalances,
    loadAccounts,
    loadArchivedAccounts,
    loadAccountBalances,

    // Categories
    categories,
    archivedCategories,
    isLoadingCategories,
    isLoadingArchivedCategories,
    loadCategories,
    loadArchivedCategories,

    // UI
    activeMonth,
    setActiveMonth,
    isSidebarCollapsed,
    setIsSidebarCollapsed,
    toggleSidebarCollapse,
    isMobileMenuOpen,
    setIsMobileMenuOpen,

    // Refresh
    dataRefreshCounter,
    triggerRefresh,

    // Transaction Modal
    transactionModal,
    openTransactionModal,
    closeTransactionModal,

    // Computed
    userInitial,
    userEmail,
    totalBalance,
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

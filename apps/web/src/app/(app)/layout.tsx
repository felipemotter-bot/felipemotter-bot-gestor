"use client";

import { useEffect } from "react";
import { useRouter, usePathname } from "next/navigation";
import { AppProvider, useApp } from "@/contexts/AppContext";
import { Sidebar } from "@/components/layout/Sidebar";
import { MobileMenu } from "@/components/layout/MobileMenu";
import { TransactionModal } from "@/components/modals/TransactionModal";
import type { ActiveView } from "@/types";

const pathToView: Record<string, ActiveView> = {
  "/": "dashboard",
  "/lancamentos": "transactions",
  "/transferencias": "transfers",
  "/contas": "accounts",
  "/categorias": "categories",
  "/extrato": "statement",
  "/importacoes": "imports",
  "/reconciliacao": "reconciliation",
  "/regras": "rules",
};

const viewToPath: Record<ActiveView, string> = {
  dashboard: "/",
  transactions: "/lancamentos",
  transfers: "/transferencias",
  accounts: "/contas",
  categories: "/categorias",
  statement: "/extrato",
  imports: "/importacoes",
  reconciliation: "/reconciliacao",
  rules: "/regras",
};

function AppLayoutContent({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const {
    session,
    isChecking,
    isSigningOut,
    signOut,
    isSidebarCollapsed,
    toggleSidebarCollapse,
    isMobileMenuOpen,
    setIsMobileMenuOpen,
    familyName,
    userInitial,
    userEmail,
  } = useApp();

  // Redirect to login if not authenticated
  useEffect(() => {
    if (!isChecking && !session) {
      router.replace("/login");
    }
  }, [isChecking, session, router]);

  // Determine active view from pathname
  const activeView: ActiveView = pathToView[pathname] ?? "dashboard";

  // Handle view change
  const handleViewChange = (view: ActiveView) => {
    const path = viewToPath[view];
    router.push(path);
  };

  // Handle logo click
  const handleLogoClick = () => {
    router.push("/");
  };

  // Handle sign out
  const handleSignOut = async () => {
    await signOut();
    router.replace("/login");
  };

  // Sidebar logo source
  const sidebarLogoSrc = isSidebarCollapsed
    ? "/logo_gestor_quadrado.png"
    : "/logo_gestor.png";

  const signOutLabel = isSigningOut ? "Saindo..." : "Sair";

  // Show loading while checking auth
  if (isChecking) {
    return (
      <div className="relative min-h-screen overflow-hidden text-[var(--ink)]">
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,_rgba(37,99,235,0.14),_transparent_55%)]" />
          <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(15,23,42,0.05)_1px,transparent_1px),linear-gradient(180deg,rgba(15,23,42,0.05)_1px,transparent_1px)] bg-[size:80px_80px] opacity-35" />
        </div>
        <div className="relative flex min-h-screen items-center justify-center">
          <div className="text-sm text-[var(--muted)]">
            Carregando informações...
          </div>
        </div>
      </div>
    );
  }

  // Don't render if not authenticated
  if (!session) {
    return null;
  }

  return (
    <div className="relative min-h-screen overflow-x-hidden text-[var(--ink)]">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,_rgba(37,99,235,0.14),_transparent_55%)]" />
        <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(15,23,42,0.05)_1px,transparent_1px),linear-gradient(180deg,rgba(15,23,42,0.05)_1px,transparent_1px)] bg-[size:80px_80px] opacity-35" />
      </div>

      <div className="relative mx-auto min-h-screen w-full px-3 py-6 sm:px-4">
        <div className="relative min-h-[calc(100vh-3rem)] overflow-x-hidden">
          <Sidebar
            isCollapsed={isSidebarCollapsed}
            onToggleCollapse={toggleSidebarCollapse}
            activeView={activeView}
            onViewChange={handleViewChange}
            onLogoClick={handleLogoClick}
            logoSrc={sidebarLogoSrc}
            familyName={familyName}
            userInitial={userInitial}
            userEmail={userEmail}
            isSigningOut={isSigningOut}
            onSignOut={handleSignOut}
            signOutLabel={signOutLabel}
          />

          <div
            className={`flex min-w-0 flex-col gap-6 ${
              isSidebarCollapsed ? "lg:pl-[112px]" : "lg:pl-[244px]"
            }`}
          >
            {children}
          </div>
        </div>
      </div>

      <MobileMenu
        isOpen={isMobileMenuOpen}
        onClose={() => setIsMobileMenuOpen(false)}
        activeView={activeView}
        onViewChange={handleViewChange}
        onLogoClick={handleLogoClick}
        familyName={familyName}
        userInitial={userInitial}
        userEmail={userEmail}
        isSigningOut={isSigningOut}
        onSignOut={handleSignOut}
      />

      <TransactionModal />
    </div>
  );
}

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <AppProvider>
      <AppLayoutContent>{children}</AppLayoutContent>
    </AppProvider>
  );
}

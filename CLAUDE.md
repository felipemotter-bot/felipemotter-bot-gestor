# CLAUDE.md — Gestor

App de controle financeiro familiar com multi-usuarios, permissoes, ingestao de extratos e automacoes.

> **Auto-atualização**: Sempre que uma alteração mudar a estrutura do projeto, adicionar/remover dependências, criar/renomear tabelas, alterar regras de negócio, adicionar rotas, ou modificar convenções — atualize este arquivo para refletir a mudança. Manter o CLAUDE.md sincronizado com o estado real do projeto é obrigatório.

## Stack

| Camada | Tecnologia |
|--------|-----------|
| Frontend | Next.js 16 (App Router) + React 19 + Tailwind CSS 4 + TypeScript 5 + ofx-js |
| Auth / API | Supabase self-hosted: GoTrue v2.184, PostgREST v14.1, Realtime v2.68, Storage v1.33 |
| Gateway | Kong 2.8.1 (proxy), Traefik (produção com TLS) |
| Banco | PostgreSQL 15.8 com RLS, triggers e funções PL/pgSQL |
| OFX | FastAPI 0.115 + Uvicorn (microserviço Python em `services/ofx/`) |
| Automação | n8n 2.1.1 (ingestão de emails) |
| Infra | Docker Compose (dev + prod) |

## Estrutura do projeto

```
/opt/gestor/
├── apps/web/                    # Frontend Next.js
│   └── src/
│       ├── app/
│       │   ├── manifest.ts      # PWA manifest (MetadataRoute.Manifest)
│       │   ├── (auth)/          # Login, registro
│       │   │   └── layout.tsx
│       │   └── (app)/           # Rotas protegidas
│       │       ├── page.tsx           # Dashboard (gráficos, resumo)
│       │       ├── lancamentos/       # CRUD de lançamentos
│       │       ├── contas/            # CRUD de contas
│       │       ├── categorias/        # CRUD de categorias (hierárquicas)
│       │       ├── extrato/           # Extrato com saldo corrido
│       │       ├── transferencias/    # Transferências entre contas
│       │       ├── importacoes/       # Importação de extratos OFX (upload, preview, confirm)
│       │       ├── reconciliacao/     # Reconciliação manual↔OFX com matching (foco em manuais)
│       │       └── regras/            # CRUD de regras de categorização automática
│       ├── app/api/
│       │   └── imports/
│       │       ├── parse/route.ts     # POST: recebe arquivo OFX, retorna transações parseadas
│       │       └── confirm/route.ts   # POST: grava transações no banco via service_role
│       ├── components/
│       │   ├── charts/          # DonutChart, CashflowChart
│       │   ├── modals/          # TransactionModal, AccountModal, CategoryModal, RuleModal
│       │   └── layout/          # Header, Sidebar, MobileMenu
│       ├── contexts/AppContext.tsx   # Estado global (session, family, accounts, categories)
│       ├── constants/           # Ícones, navegação, estilos reutilizáveis
│       ├── lib/
│       │   ├── supabase/client.ts   # Singleton do Supabase client
│       │   ├── date-utils.ts        # Helpers de data (timezone America/Sao_Paulo)
│       │   ├── formatters.ts        # Formatação de moeda e datas
│       │   ├── bank-logos.ts        # Logos de bancos brasileiros
│       │   ├── ofx-parser.ts        # Parser OFX client-side (usa ofx-js)
│       │   ├── rule-matcher.ts      # Matching de regras de categorização (funções puras)
│       │   ├── reconciliation-matcher.ts  # Matching manual↔OFX para reconciliação (autoMatchExact + rankCandidates com tolerâncias)
│       │   ├── balance-checker.ts   # Verificação de divergência saldo sistema vs banco via RPC
│       │   ├── import-validation.ts # Validação de payload de importação (pure functions, UUID/schema/limites)
│       │   ├── rate-limiter.ts      # Rate limiter in-memory sliding-window (singleton para import confirm)
│       │   ├── __fixtures__/        # Fixtures OFX para testes (nubank.ofx, viacredi.ofx)
│       │   └── __tests__/           # Testes unitários Vitest (8 arquivos, ~149 testes)
│       └── types/
│           ├── index.ts             # Tipos compartilhados
│           └── ofx-js.d.ts          # Type declarations para ofx-js
│   └── public/
│       ├── sw.js                    # Service Worker (cache mínimo, network-first)
│       └── icons/                   # Ícones PWA (192, 512, apple-touch-icon)
├── services/ofx/               # Microserviço FastAPI para parsing OFX
│   └── app/main.py
├── db/
│   ├── init/001_init.sql       # Schema completo (757 linhas)
│   ├── seed/demo_data.sql      # Dados demo (usuários, contas, categorias, transações)
│   ├── patches/                # Migrações incrementais
│   └── test/                   # Testes SQL (psql assertions)
│       ├── run_tests.sh        # Runner de testes SQL
│       ├── test_account_balance.sql
│       ├── test_transfer_link.sql
│       ├── test_triggers.sql
│       └── test_rpcs.sql
├── supabase/                   # Configs do Supabase (kong.yml, SQL de roles/jwt/realtime)
├── scripts/
│   ├── gen_env.py              # Gera .env com JWTs e chaves
│   └── demo.sh                 # Reset/seed de dados demo
├── .github/workflows/ci.yml    # CI: lint, test, sql-tests, build
├── docker-compose.yml          # Dev
├── docker-compose.prod.yml     # Produção
└── docker-compose.traefik.yml  # TLS/HTTPS
```

## Banco de dados

### Tabelas principais

- `families` — grupo familiar (unidade de multi-tenancy), `reconciliation_settings` (JSONB, tolerâncias de reconciliação)
- `memberships` — relação user↔family com role (`owner`, `admin`, `member`, `viewer`)
- `accounts` — contas bancárias (tipo, moeda, visibilidade `shared`/`private`, ícone, `is_reconcilable`, `reconciled_until`, `reconciled_balance`, `ofx_bank_id`, `ofx_account_id`)
- `categories` — categorias hierárquicas (máx 2 níveis), tipo `income`/`expense`/`transfer`
- `transactions` — lançamentos com `posted_at`, `occurred_time`, `amount`, `source`, `source_hash`, `original_description`, `auto_categorized`, `reconciliation_hint` (JSONB, dica para matching), `transfer_linked_id` (FK para contrapartida de transferência OFX)
- `import_batches` — rastreamento de importações OFX (status: `pending`/`processed`/`failed`)
- `tags`, `transaction_tags` — tags customizadas
- `attachments` — anexos com storage path
- `rules` — regras de categorização automática (match/action em JSONB, priority para ordenação)
- `audit_logs` — log de alterações

### Funções SQL importantes

- `account_balance(uuid)` — saldo atual (opening_balance + soma de transações)
- `account_balance_at(uuid, date)` — saldo em data específica
- `is_family_member(uuid)`, `is_family_writer(uuid)`, `is_family_admin(uuid)` — checagens de permissão usadas nas RLS policies
- `enforce_category_max_depth()` — trigger que impede subcategoria de subcategoria
- `enforce_balance_adjust_category_usage()` — trigger que protege a categoria "Ajuste de saldo"
- `enforce_account_archive_balance()` — trigger que exige saldo zero para arquivar conta
- `prevent_account_delete_with_transactions()` — trigger que impede deletar conta com lançamentos
- `enforce_reconciled_period()` — trigger que bloqueia lançamentos manuais em período reconciliado (não-admin)
- `validate_transfer_link()` — constraint trigger deferido (`DEFERRABLE INITIALLY DEFERRED`): valida que `transfer_linked_id` é bidirecional, contas diferentes, sinais opostos. Roda no COMMIT, não no statement
- `link_transfer(tx_a, tx_b, transfer_category)` — RPC: vincula duas transações como transferência atomicamente (seta `transfer_linked_id` cruzado + categoria)
- `unlink_transfer(tx_id)` — RPC: desvincula um par de transferência atomicamente (nula `transfer_linked_id` e `category_id` de ambos)
- `migrate_transfer_link(old_partner_id, new_ofx_id, transfer_category)` — RPC: migra link de transferência após deletar manual (re-vincula parceiro antigo com OFX substituta)
- `unreconciled_manual_transactions(uuid)` — RPC: retorna manuais em contas reconciliáveis com `posted_at ≤ reconciled_until` (inclui `transfer_linked_id`)
- `uncategorized_ofx_count(uuid)` — RPC: count de OFX sem categoria
- `unreconciled_manual_count(uuid)` — RPC: count de manuais não reconciliadas

### RLS

Todas as tabelas têm RLS ativada. Permissões baseadas em role via `is_family_*()`. Contas privadas só visíveis ao `owner_user_id`. Transações herdam visibilidade da conta.

## Convenções de código

### TypeScript / React

- Path alias: `@/*` → `./src/*`
- Componentes: function components, hooks, `"use client"` onde necessário
- Estado global via `AppContext` (React Context) — contém session, membership, family_id, accounts, categories, período selecionado
- Supabase client: singleton via `getSupabaseClient()` — nunca instanciar `createClient` diretamente
- Datas: sempre usar helpers de `date-utils.ts` que consideram timezone `America/Sao_Paulo`
- Formatação: usar `formatters.ts` para moeda (BRL) e datas
- Estilos: CSS variables para cores (`--accent`, `--ink`, `--border`), classes reutilizáveis em `constants/styles.ts`
- Fontes: Manrope (body), Sora (headings)

### SQL

- Funções com `security definer` e `set search_path = public`
- Triggers em português para mensagens de erro voltadas ao usuário
- Nomes de tabelas e colunas em inglês, mensagens de erro em português
- UUIDs como primary keys (`gen_random_uuid()`)
- `numeric(14,2)` para valores monetários
- **Convenção de sinais para amounts**: Todos os amounts usam sinal natural — negativo = saída, positivo = entrada. Manuais: expense salva com `-abs(valor)`, income com `+abs(valor)`. OFX armazena valor original do banco (negativo pra débito, positivo pra crédito). Transfers: `-` na origem, `+` no destino. Funções de saldo: `opening_balance + sum(amount)` — sem CASE, sem JOIN em categories

### Commits

Ver `.claude/skills/commit/SKILL.md` para o padrão completo. Usar sempre a skill `/commit`.

## Comandos de desenvolvimento

```bash
# Subir todos os serviços
docker compose up -d

# Apenas o frontend (com hot reload via volume mount)
docker compose up web

# Lint
cd apps/web && npm run lint

# Testes unitários (Vitest)
cd apps/web && npm test              # run once
cd apps/web && npm run test:watch    # watch mode
cd apps/web && npm run test:coverage # com cobertura

# Testes SQL (requer docker compose up db)
bash db/test/run_tests.sh

# Build
cd apps/web && npm run build

# Gerar .env com chaves
python3 scripts/gen_env.py

# Demo data
# No primeiro "docker compose up" (volume vazio), o seed roda automaticamente
# (controlado por SEED_DEMO=true no service db do docker-compose.yml).
# Para resetar/re-seed manual em qualquer momento:
./scripts/demo.sh reset            # Limpa dados (mantém schema)
./scripts/demo.sh seed             # Insere dados demo
./scripts/demo.sh reset-and-seed   # Limpa + insere

# Usuários demo (senha: demo123):
#   felipe@demo.com — owner da "Família Tirloni Pereira"
#   flavi@demo.com  — member da "Família Tirloni Pereira"
```

### URLs locais

- Web: http://localhost:3000
- Supabase API (Kong): http://localhost:8000
- Studio: http://localhost:3002
- n8n: http://localhost:5678
- PostgreSQL: localhost:5433

## Testes

### Unitários (Vitest)

- Framework: Vitest 4 (`apps/web/vitest.config.ts`)
- 8 test suites em `apps/web/src/lib/__tests__/`: date-utils, formatters, ofx-parser, rule-matcher, reconciliation-matcher, balance-checker, import-validation, rate-limiter
- Fixtures OFX em `apps/web/src/lib/__fixtures__/`
- Alias `@/*` configurado no vitest.config.ts

### SQL (psql assertions)

- Runner: `db/test/run_tests.sh` — roda todos os `test_*.sql` em `db/test/`
- Usa `SET session_replication_role = 'replica'` para bypass de RLS/triggers no setup
- 4 arquivos: account_balance, transfer_link, triggers, rpcs

### CI (GitHub Actions)

- `.github/workflows/ci.yml` com 4 jobs paralelos: lint-typecheck, unit-tests, sql-tests, build
- Build depende de lint+tests passarem
- SQL tests usa `postgres:15` service container com auth schema stub

## API Routes (Next.js)

- `POST /api/imports/parse` — recebe arquivo OFX via FormData, retorna transações parseadas (sem autenticação, roda server-side)
- `POST /api/imports/confirm` — recebe transações + accountId + familyId, cria `import_batch` e insere transações. Hardened: (1) Bearer token verificado via GoTrue `getUser`; (2) membership check explícito (user deve ser `owner`/`admin`/`member` na família); (3) account ownership check (accountId deve pertencer à familyId, contas privadas só pelo dono); (4) payload validado com schema estrito via `import-validation.ts` (UUIDs, datas, limites de tamanho, max 5000 transações); (5) rate limiting in-memory (10 req/min por usuário via `rate-limiter.ts`); (6) logs sanitizados (nunca incluem payload completo ou secrets); (7) usa `SUPABASE_SERVICE_ROLE_KEY` apenas server-side após auth explícita. Deduplicação por `external_id` (FITID) e hash do batch.

## Navegação

Itens implementados: Dashboard, Lançamentos, Contas, Categorias, Transferências, Extrato, Importações, Reconciliação, Regras e Automação.
Itens no menu (ainda não implementados): Orçamento, Relatórios, Metas.

## PWA (Progressive Web App)

O app é instalável como PWA em Android/iOS. Implementação sem libs externas:

- `app/manifest.ts` — Web App Manifest nativo do Next.js (`MetadataRoute.Manifest`)
- `public/sw.js` — Service Worker mínimo (network-first, cache do app shell como fallback)
- `layout.tsx` — Meta tags (`appleWebApp`, `viewport`, `themeColor`) e registro do SW via `<Script>`
- `public/icons/` — Ícones 192x192, 512x512 e apple-touch-icon (180x180), gerados a partir de `logo_gestor_quadrado.png`

Não usar `next-pwa` ou cache offline agressivo — dados dependem do Supabase em tempo real.

## Regras de negócio importantes

1. Um usuário pertence a **uma única família** (unique index em `memberships.user_id`)
2. Categorias têm no máximo **2 níveis** (pai → filho, sem neto)
3. Conta só pode ser **arquivada com saldo zero**
4. Conta com lançamentos **não pode ser deletada** (deve arquivar)
5. Categoria "Ajuste de saldo" só pode ser usada com `source = 'adjustment'`
6. Importações OFX usam `source_hash` para **deduplicação idempotente**
7. Saldo é calculado: `opening_balance + Σ(amount)` — todos os amounts já carregam o sinal correto (negativo = saída, positivo = entrada), sem necessidade de CASE ou JOIN em categories
8. Contas privadas (`visibility = 'private'`) só são visíveis ao dono
9. Importação OFX: parsing via `ofx-js` no frontend, confirmação via API Route com `service_role`. Deduplicação dupla: por `raw_hash` no `import_batches` (idempotência de arquivo) e por `external_id`/FITID nas `transactions` (idempotência de transação). A descrição original do extrato é preservada em `original_description` para referência ao renomear
10. Transações importadas podem ser editadas (descrição, categoria) via modal de edição acessível pela lista de lançamentos. Data de transações OFX não é editável. "Sem categoria" aparece como link clicável que abre o modal de edição
11. API Route `/api/imports/confirm` requer `SUPABASE_SERVICE_ROLE_KEY` como env var no servidor. Hardened com: membership check explícito (requer role `owner`/`admin`/`member`), account ownership check (conta deve pertencer à família, privada só pelo dono), validação de schema estrita (`import-validation.ts`), rate limiting in-memory (10 req/min/usuário via `rate-limiter.ts`), logs sanitizados (sem payload/secrets)
12. **Regras de categorização automática**: regras definidas na tabela `rules` categorizam transações OFX automaticamente. Match por `description_contains` (case-insensitive substring), `description_regex` (regex flag `i`), `amount_exact`/`amount_min`/`amount_max` (valores absolutos), `day_of_month` (1-31), `date_after`/`date_before` (YYYY-MM-DD, inclusivo). Ação: `set_category_id` (obrigatório), `set_description` (opcional). Avaliadas em ordem de `priority` (ASC) + `created_at` (ASC). Aplicadas client-side no preview de importação com overrides manuais, e server-side como fallback para transações sem categoria após inserção
13. **Auto-match de conta OFX**: contas com `ofx_bank_id` e `ofx_account_id` preenchidos são automaticamente selecionadas na importação OFX quando o `bankId` e `accountId` do arquivo coincidem. Campos editáveis no modal de conta (visíveis quando "Conta reconciliável" está ativo), com opção de preencher via upload de arquivo OFX. Índice único `accounts_ofx_ids_unique` em `(family_id, ofx_bank_id, ofx_account_id)` impede duplicatas
14. **Reconciliação**: contas marcadas como `is_reconcilable` podem receber importação OFX. Após importação, `reconciled_until` e `reconciled_balance` são atualizados (só avança, nunca retrocede). Lançamentos manuais com data ≤ `reconciled_until` são bloqueados para `member`/`viewer` (trigger SQL + validação frontend). Admin/owner vê aviso mas pode prosseguir. Na tela de importação, só contas reconciliáveis aparecem no seletor
15. **Reconciliação manual↔OFX** (`/reconciliacao`): foco exclusivo em resolver manuais em período reconciliado. Busca manuais em contas reconciliáveis via RPC `unreconciled_manual_transactions`. Matching em 2 fases: (1) `autoMatchExact` — mesmo valor ±0.01 e mesma data, pré-selecionados para confirmação em lote; (2) `rankCandidates` — on-demand por manual, usa tolerâncias da família (`reconciliation_settings`), hints por transação (`reconciliation_hint`), score mínimo 40. Ao confirmar, manual é excluído (OFX prevalece). Configurações de tolerância (valor, data, descrição) editáveis na tela e salvas em `families.reconciliation_settings`. Vinculação de OFX como transferência não é feita nesta tela — isso ocorre via categorização no TransactionModal (regra #20)
16. **Divergência de saldo**: na tela de contas e na tela de reconciliação, compara `account_balance_at(id, reconciled_until)` com `reconciled_balance`. Se |diferença| > 0.01, exibe alerta amarelo com valor da divergência. Na reconciliação o alerta é apenas informativo (sem botão de ajuste)
17. **Ajuste rápido de saldo**: botão "Ajustar" cria transação com `source='adjustment'`, categoria "Ajuste de saldo", `amount = -diferença`, `posted_at = reconciled_until`. Disponível na tela de contas
18. **Alertas no dashboard**: seção de alertas entre resumo e grid. Mostra contagem de OFX sem categoria (link para `/lancamentos`) e manuais não reconciliadas (link para `/reconciliacao`). Dados via RPCs `uncategorized_ofx_count` e `unreconciled_manual_count`. Só exibe se count > 0
19. **Dica de reconciliação**: ao editar transação manual em conta reconciliável, seção colapsável permite definir `reconciliation_hint` (descrição OFX contém, valor mín/máx) que influencia ranking de candidatas na reconciliação
20. **Vinculação OFX como transferência**: ao editar uma transação OFX, o usuário pode selecionar "Transferência" como tipo. O sistema pede a conta destino/origem (inferido pelo sinal do amount), busca OFX candidatas na conta selecionada (mesmo valor ±0.01, data ±3 dias, sinal oposto), e permite vincular ou criar contrapartida (`source='manual'`). Operações de link/unlink usam RPCs atômicas (`link_transfer`, `unlink_transfer`). Constraint trigger deferido `validate_transfer_link` garante bidirecionalidade, contas diferentes e sinais opostos no COMMIT. Desvincular via `unlink_transfer` zera `transfer_linked_id` e `category_id` de ambas. `source` OFX não muda (proveniência preservada)
21. **Migração de link em reconciliação**: ao excluir manual que tinha `transfer_linked_id` (via match exato ou candidata), o sistema migra o link para a OFX substituta via `migrate_transfer_link`. O parceiro antigo é re-vinculado à OFX que substituiu a manual, preservando a relação de transferência

## Roadmap

- [x] Fase 0: Schema, RLS, Docker Compose
- [x] Fase 1: Auth, famílias, contas, categorias, lançamentos manuais
- [x] Fase 2: Parsing e importação OFX (parser client-side com ofx-js, upload/preview/confirm, deduplicação por FITID)
- [ ] Fase 3: Ingestão de email via n8n
- [ ] Fase 4: Relatórios e exportações
- [ ] Fase 5: Telegram + IA para categorização

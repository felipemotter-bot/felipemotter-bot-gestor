create extension if not exists "pgcrypto";

alter table auth.users
  alter column role set default 'authenticated';

update auth.users
  set role = 'authenticated'
  where role is null or role = '';

create or replace function auth.set_default_role()
returns trigger
language plpgsql
as $$
begin
  if new.role is null or btrim(new.role) = '' then
    new.role := 'authenticated';
  end if;

  return new;
end;
$$;

drop trigger if exists set_default_role on auth.users;
create trigger set_default_role
  before insert or update on auth.users
  for each row execute function auth.set_default_role();

do $$ begin
  if not exists (
    select 1 from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where t.typname = 'member_role' and n.nspname = 'public'
  ) then
    create type public.member_role as enum ('owner', 'admin', 'member', 'viewer');
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where t.typname = 'account_visibility' and n.nspname = 'public'
  ) then
    create type public.account_visibility as enum ('shared', 'private');
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where t.typname = 'category_type' and n.nspname = 'public'
  ) then
    create type public.category_type as enum ('income', 'expense', 'transfer');
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where t.typname = 'import_status' and n.nspname = 'public'
  ) then
    create type public.import_status as enum ('pending', 'processed', 'failed');
  end if;
end $$;

create table if not exists public.families (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  reconciliation_settings jsonb,
  created_by uuid references auth.users(id) default auth.uid(),
  created_at timestamptz not null default now()
);

create table if not exists public.memberships (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.member_role not null default 'member',
  created_by uuid references auth.users(id) default auth.uid(),
  created_at timestamptz not null default now(),
  unique (family_id, user_id)
);

create unique index if not exists memberships_user_id_key
  on public.memberships (user_id);

create table if not exists public.accounts (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete cascade,
  name text not null,
  account_type text not null default 'checking',
  currency text not null default 'BRL',
  visibility public.account_visibility not null default 'shared',
  owner_user_id uuid references auth.users(id),
  is_archived boolean not null default false,
  opening_balance numeric(14,2) not null default 0,
  icon_key text,
  icon_bg text,
  icon_color text,
  is_reconcilable boolean not null default false,
  reconciled_until date,
  reconciled_balance numeric(14,2),
  ofx_bank_id text,
  ofx_account_id text,
  created_by uuid references auth.users(id) default auth.uid(),
  created_at timestamptz not null default now()
);

create unique index if not exists accounts_ofx_ids_unique
  on public.accounts (family_id, ofx_bank_id, ofx_account_id)
  where ofx_bank_id is not null and ofx_account_id is not null;

create table if not exists public.categories (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete cascade,
  parent_id uuid references public.categories(id) on delete set null,
  name text not null,
  category_type public.category_type not null default 'expense',
  icon_key text,
  icon_bg text,
  icon_color text,
  is_archived boolean not null default false,
  created_by uuid references auth.users(id) default auth.uid(),
  created_at timestamptz not null default now()
);

create index if not exists categories_parent_id_idx
  on public.categories (parent_id);

create unique index if not exists categories_family_root_name_key
  on public.categories (family_id, name)
  where parent_id is null;

create unique index if not exists categories_family_parent_name_key
  on public.categories (family_id, parent_id, name)
  where parent_id is not null;

create or replace function public.enforce_category_max_depth()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  parent_parent_id uuid;
begin
  if new.parent_id is null then
    return new;
  end if;

  if new.parent_id = new.id then
    raise exception 'category parent_id cannot reference itself' using errcode = 'check_violation';
  end if;

  select parent_id
    into parent_parent_id
    from public.categories
    where id = new.parent_id;

  if parent_parent_id is not null then
    raise exception 'subcategoria nao pode ter subcategoria' using errcode = 'check_violation';
  end if;

  if exists (select 1 from public.categories where parent_id = new.id) then
    raise exception 'categoria com subcategorias nao pode virar subcategoria' using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_categories_max_depth on public.categories;

create trigger trg_categories_max_depth
before insert or update of parent_id on public.categories
for each row
execute function public.enforce_category_max_depth();

create table if not exists public.tags (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete cascade,
  name text not null,
  created_by uuid references auth.users(id) default auth.uid(),
  created_at timestamptz not null default now(),
  unique (family_id, name)
);

create table if not exists public.import_batches (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete cascade,
  source text not null,
  raw_hash text not null,
  status public.import_status not null default 'pending',
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) default auth.uid(),
  created_at timestamptz not null default now(),
  processed_at timestamptz
);

create unique index if not exists import_batches_unique_hash
  on public.import_batches (family_id, source, raw_hash);

create table if not exists public.transactions (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  category_id uuid references public.categories(id),
  amount numeric(14,2) not null,
  currency text not null default 'BRL',
  description text,
  posted_at date not null,
  occurred_time time,
  notes text,
  source text,
  source_hash text,
  external_id text,
  original_description text,
  auto_categorized boolean not null default false,
  reconciliation_hint jsonb,
  personal_amount numeric(14,2),
  transfer_linked_id uuid references public.transactions(id) on delete set null,
  import_batch_id uuid references public.import_batches(id),
  created_by uuid references auth.users(id) default auth.uid(),
  created_at timestamptz not null default now()
);

create index if not exists transactions_account_id_idx
  on public.transactions (account_id);

create index if not exists transactions_posted_at_idx
  on public.transactions (posted_at);

create index if not exists transactions_account_posted_time_idx
  on public.transactions (account_id, posted_at, occurred_time, created_at);

create index if not exists transactions_source_hash_idx
  on public.transactions (source_hash);

create index if not exists transactions_transfer_linked_id_idx
  on public.transactions (transfer_linked_id)
  where transfer_linked_id is not null;

create or replace function public.enforce_balance_adjust_category_usage()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  category_name text;
begin
  if new.category_id is null then
    return new;
  end if;

  select name into category_name from public.categories where id = new.category_id;
  if category_name is null then
    return new;
  end if;

  if lower(category_name) like lower('Ajuste de saldo%')
     and coalesce(new.source, '') <> 'adjustment' then
    raise exception 'Categoria Ajuste de saldo so pode ser usada em ajustes.';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_transactions_adjust_category_guard on public.transactions;
create trigger trg_transactions_adjust_category_guard
before insert or update of category_id, source on public.transactions
for each row execute function public.enforce_balance_adjust_category_usage();

create or replace function public.account_balance(account_uuid uuid)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(a.opening_balance, 0) +
    coalesce((
      select sum(t.amount)
      from public.transactions t
      where t.account_id = a.id
    ), 0)
  from public.accounts a
  where a.id = account_uuid;
$$;

create or replace function public.account_balance_at(account_uuid uuid, at_date date)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(a.opening_balance, 0) +
    coalesce((
      select sum(t.amount)
      from public.transactions t
      where t.account_id = a.id
        and t.posted_at <= at_date
    ), 0)
  from public.accounts a
  where a.id = account_uuid;
$$;

grant execute on function public.account_balance_at(uuid, date) to anon, authenticated, service_role;

create or replace function public.enforce_account_archive_balance()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  current_balance numeric;
begin
  if new.is_archived is true and (old.is_archived is distinct from true) then
    select public.account_balance(new.id) into current_balance;
    if current_balance is null then
      raise exception 'Nao foi possivel calcular saldo da conta.';
    end if;
    if abs(current_balance) > 0.009 then
      raise exception 'Conta precisa estar zerada para arquivar.';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_accounts_archive_balance on public.accounts;
create trigger trg_accounts_archive_balance
before update of is_archived on public.accounts
for each row execute function public.enforce_account_archive_balance();

create or replace function public.prevent_account_delete_with_transactions()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (select 1 from public.transactions where account_id = old.id) then
    raise exception 'Conta possui lancamentos.';
  end if;
  return old;
end;
$$;

drop trigger if exists trg_accounts_prevent_delete on public.accounts;
create trigger trg_accounts_prevent_delete
before delete on public.accounts
for each row execute function public.prevent_account_delete_with_transactions();

create or replace function public.enforce_reconciled_period()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  acct_reconciled_until date;
  acct_family_id uuid;
begin
  if coalesce(new.source, '') = 'ofx' then
    return new;
  end if;

  select reconciled_until, family_id
    into acct_reconciled_until, acct_family_id
    from public.accounts
    where id = new.account_id;

  if acct_reconciled_until is null then
    return new;
  end if;

  if new.posted_at > acct_reconciled_until then
    return new;
  end if;

  if public.is_family_admin(acct_family_id) then
    return new;
  end if;

  raise exception 'Periodo reconciliado ate %. Lancamentos manuais neste periodo exigem permissao de administrador.', acct_reconciled_until;
end;
$$;

drop trigger if exists trg_transactions_reconciled_period on public.transactions;
create trigger trg_transactions_reconciled_period
before insert or update of posted_at, source on public.transactions
for each row execute function public.enforce_reconciled_period();

create table if not exists public.transaction_tags (
  transaction_id uuid not null references public.transactions(id) on delete cascade,
  tag_id uuid not null references public.tags(id) on delete cascade,
  primary key (transaction_id, tag_id)
);

create table if not exists public.attachments (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete cascade,
  storage_path text not null,
  file_name text not null,
  mime_type text,
  size_bytes bigint,
  source text,
  transaction_id uuid references public.transactions(id) on delete set null,
  import_batch_id uuid references public.import_batches(id) on delete set null,
  created_by uuid references auth.users(id) default auth.uid(),
  created_at timestamptz not null default now()
);

create table if not exists public.rules (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete cascade,
  name text not null,
  match jsonb not null default '{}'::jsonb,
  action jsonb not null default '{}'::jsonb,
  is_active boolean not null default true,
  priority integer not null default 0,
  created_by uuid references auth.users(id) default auth.uid(),
  created_at timestamptz not null default now()
);

create index if not exists rules_family_priority_idx
  on public.rules (family_id, priority ASC, created_at ASC);

create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete cascade,
  actor_user_id uuid references auth.users(id),
  action text not null,
  entity text not null,
  entity_id uuid,
  before_data jsonb,
  after_data jsonb,
  created_at timestamptz not null default now()
);

create or replace function public.is_family_member(family uuid)
returns boolean
language sql
stable
security definer
set search_path = public
set row_security = off
as $$
  select exists (
    select 1
    from public.memberships m
    where m.family_id = family
      and m.user_id = auth.uid()
  );
$$;

create or replace function public.is_family_writer(family uuid)
returns boolean
language sql
stable
security definer
set search_path = public
set row_security = off
as $$
  select exists (
    select 1
    from public.memberships m
    where m.family_id = family
      and m.user_id = auth.uid()
      and m.role in ('owner', 'admin', 'member')
  );
$$;

create or replace function public.is_family_admin(family uuid)
returns boolean
language sql
stable
security definer
set search_path = public
set row_security = off
as $$
  select exists (
    select 1
    from public.memberships m
    where m.family_id = family
      and m.user_id = auth.uid()
      and m.role in ('owner', 'admin')
  );
$$;

create or replace function public.has_membership()
returns boolean
language sql
stable
security definer
set search_path = public
set row_security = off
as $$
  select exists (
    select 1
    from public.memberships m
    where m.user_id = auth.uid()
  );
$$;

create or replace function public.unreconciled_manual_transactions(family_uuid uuid)
returns table (
  id uuid,
  account_id uuid,
  account_name text,
  amount numeric,
  description text,
  original_description text,
  posted_at date,
  source text,
  external_id text,
  category_id uuid,
  category_name text,
  category_type text,
  reconciliation_hint jsonb,
  transfer_linked_id uuid
)
language sql
stable
security definer
set search_path = public
as $$
  select
    t.id,
    t.account_id,
    a.name as account_name,
    t.amount,
    t.description,
    t.original_description,
    t.posted_at,
    t.source,
    t.external_id,
    t.category_id,
    c.name as category_name,
    c.category_type::text as category_type,
    t.reconciliation_hint,
    t.transfer_linked_id
  from public.transactions t
  join public.accounts a on a.id = t.account_id
  left join public.categories c on c.id = t.category_id
  where a.family_id = family_uuid
    and a.is_reconcilable = true
    and a.reconciled_until is not null
    and t.posted_at <= a.reconciled_until
    and t.posted_at >= coalesce((
      select min(ox.posted_at)
      from public.transactions ox
      where ox.account_id = a.id and ox.source = 'ofx'
    ), a.reconciled_until)
    and (t.source is null or t.source in ('manual', 'transfer'))
    and (a.visibility = 'shared' or a.owner_user_id = (select auth.uid()))
  order by t.posted_at asc, t.created_at asc;
$$;

grant execute on function public.unreconciled_manual_transactions(uuid) to anon, authenticated, service_role;

create or replace function public.uncategorized_ofx_count(family_uuid uuid)
returns bigint
language sql
stable
security definer
set search_path = public
as $$
  select count(*)
  from public.transactions t
  join public.accounts a on a.id = t.account_id
  where a.family_id = family_uuid
    and t.source = 'ofx'
    and t.category_id is null
    and (a.visibility = 'shared' or a.owner_user_id = (select auth.uid()));
$$;

grant execute on function public.uncategorized_ofx_count(uuid) to anon, authenticated, service_role;

create or replace function public.unreconciled_manual_count(family_uuid uuid)
returns bigint
language sql
stable
security definer
set search_path = public
as $$
  select count(*)
  from public.transactions t
  join public.accounts a on a.id = t.account_id
  where a.family_id = family_uuid
    and a.is_reconcilable = true
    and a.reconciled_until is not null
    and t.posted_at <= a.reconciled_until
    and t.posted_at >= coalesce((
      select min(ox.posted_at)
      from public.transactions ox
      where ox.account_id = a.id and ox.source = 'ofx'
    ), a.reconciled_until)
    and (t.source is null or t.source in ('manual', 'transfer'))
    and (a.visibility = 'shared' or a.owner_user_id = (select auth.uid()));
$$;

grant execute on function public.unreconciled_manual_count(uuid) to anon, authenticated, service_role;

alter table public.families enable row level security;

create policy families_select on public.families
  for select
  using (
    public.is_family_member(id)
    or created_by = (select auth.uid())
  );

create policy families_insert on public.families
  for insert
  with check (
    (select auth.uid()) is not null
    and not (select public.has_membership())
  );

create policy families_update on public.families
  for update
  using (public.is_family_admin(id));

create policy families_delete on public.families
  for delete
  using (public.is_family_admin(id));

alter table public.memberships enable row level security;

create policy memberships_select on public.memberships
  for select
  using (
    user_id = (select auth.uid())
    or exists (
      select 1
      from public.families f
      where f.id = family_id
        and f.created_by = (select auth.uid())
    )
  );

create policy memberships_insert on public.memberships
  for insert
  with check (
    exists (
      select 1
      from public.families f
      where f.id = family_id
        and f.created_by = (select auth.uid())
    )
  );

create policy memberships_update_admin on public.memberships
  for update
  using (
    exists (
      select 1
      from public.families f
      where f.id = family_id
        and f.created_by = (select auth.uid())
    )
  );

create policy memberships_delete_admin on public.memberships
  for delete
  using (
    exists (
      select 1
      from public.families f
      where f.id = family_id
        and f.created_by = (select auth.uid())
    )
  );

alter table public.accounts enable row level security;

create policy accounts_select on public.accounts
  for select
  using (
    public.is_family_member(family_id)
    and (visibility = 'shared' or owner_user_id = (select auth.uid()))
  );

create policy accounts_insert on public.accounts
  for insert
  with check (public.is_family_admin(family_id));

create policy accounts_update on public.accounts
  for update
  using (public.is_family_admin(family_id));

create policy accounts_delete on public.accounts
  for delete
  using (public.is_family_admin(family_id));

alter table public.categories enable row level security;

create policy categories_select on public.categories
  for select
  using (public.is_family_member(family_id));

create policy categories_insert on public.categories
  for insert
  with check (public.is_family_admin(family_id));

create policy categories_update on public.categories
  for update
  using (public.is_family_admin(family_id));

create policy categories_delete on public.categories
  for delete
  using (public.is_family_admin(family_id));

alter table public.tags enable row level security;

create policy tags_select on public.tags
  for select
  using (public.is_family_member(family_id));

create policy tags_insert on public.tags
  for insert
  with check (public.is_family_writer(family_id));

create policy tags_update on public.tags
  for update
  using (public.is_family_writer(family_id));

create policy tags_delete on public.tags
  for delete
  using (public.is_family_writer(family_id));

alter table public.import_batches enable row level security;

create policy import_batches_select on public.import_batches
  for select
  using (public.is_family_writer(family_id));

create policy import_batches_insert on public.import_batches
  for insert
  with check (public.is_family_writer(family_id));

create policy import_batches_update on public.import_batches
  for update
  using (public.is_family_admin(family_id));

create policy import_batches_delete on public.import_batches
  for delete
  using (public.is_family_admin(family_id));

alter table public.transactions enable row level security;

create policy transactions_select on public.transactions
  for select
  using (
    exists (
      select 1
      from public.accounts a
      where a.id = account_id
        and public.is_family_member(a.family_id)
        and (a.visibility = 'shared' or a.owner_user_id = (select auth.uid()))
    )
  );

create policy transactions_insert on public.transactions
  for insert
  with check (
    exists (
      select 1
      from public.accounts a
      where a.id = account_id
        and public.is_family_writer(a.family_id)
        and (a.visibility = 'shared' or a.owner_user_id = (select auth.uid()))
    )
  );

create policy transactions_update on public.transactions
  for update
  using (
    created_by = (select auth.uid())
    or exists (
      select 1
      from public.accounts a
      where a.id = account_id
        and public.is_family_admin(a.family_id)
    )
  );

create policy transactions_delete on public.transactions
  for delete
  using (
    created_by = (select auth.uid())
    or exists (
      select 1
      from public.accounts a
      where a.id = account_id
        and public.is_family_admin(a.family_id)
    )
  );

alter table public.transaction_tags enable row level security;

create policy transaction_tags_select on public.transaction_tags
  for select
  using (
    exists (
      select 1
      from public.transactions t
      join public.accounts a on a.id = t.account_id
      where t.id = transaction_id
        and public.is_family_member(a.family_id)
        and (a.visibility = 'shared' or a.owner_user_id = (select auth.uid()))
    )
  );

create policy transaction_tags_insert on public.transaction_tags
  for insert
  with check (
    exists (
      select 1
      from public.transactions t
      join public.accounts a on a.id = t.account_id
      where t.id = transaction_id
        and public.is_family_writer(a.family_id)
        and (a.visibility = 'shared' or a.owner_user_id = (select auth.uid()))
    )
  );

create policy transaction_tags_delete on public.transaction_tags
  for delete
  using (
    exists (
      select 1
      from public.transactions t
      join public.accounts a on a.id = t.account_id
      where t.id = transaction_id
        and public.is_family_writer(a.family_id)
        and (a.visibility = 'shared' or a.owner_user_id = (select auth.uid()))
    )
  );

alter table public.attachments enable row level security;

create policy attachments_select on public.attachments
  for select
  using (public.is_family_member(family_id));

create policy attachments_insert on public.attachments
  for insert
  with check (public.is_family_writer(family_id));

create policy attachments_update on public.attachments
  for update
  using (public.is_family_admin(family_id) or created_by = (select auth.uid()));

create policy attachments_delete on public.attachments
  for delete
  using (public.is_family_admin(family_id) or created_by = (select auth.uid()));

alter table public.rules enable row level security;

create policy rules_select on public.rules
  for select
  using (public.is_family_member(family_id));

create policy rules_insert on public.rules
  for insert
  with check (public.is_family_admin(family_id));

create policy rules_update on public.rules
  for update
  using (public.is_family_admin(family_id));

create policy rules_delete on public.rules
  for delete
  using (public.is_family_admin(family_id));

alter table public.audit_logs enable row level security;

create policy audit_logs_select on public.audit_logs
  for select
  using (public.is_family_admin(family_id));

create policy audit_logs_insert on public.audit_logs
  for insert
  with check (public.is_family_writer(family_id));

create policy audit_logs_delete on public.audit_logs
  for delete
  using (public.is_family_admin(family_id));

-- Transfer link constraint trigger (deferrable: validates at COMMIT)
create or replace function public.validate_transfer_link()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  partner_linked_id uuid;
  partner_account_id uuid;
  partner_amount numeric;
begin
  if new.transfer_linked_id is null then
    return new;
  end if;

  select t.transfer_linked_id, t.account_id, t.amount
    into partner_linked_id, partner_account_id, partner_amount
    from public.transactions t
    where t.id = new.transfer_linked_id;

  if not found then
    raise exception 'transfer_linked_id aponta para transacao inexistente.';
  end if;

  if partner_linked_id is distinct from new.id then
    raise exception 'transfer_linked_id nao e bidirecional: parceiro nao aponta de volta.';
  end if;

  if partner_account_id = new.account_id then
    raise exception 'Transferencia deve ser entre contas diferentes.';
  end if;

  if sign(new.amount) = sign(partner_amount) then
    raise exception 'Transferencia exige sinais opostos nos amounts.';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_validate_transfer_link on public.transactions;
create constraint trigger trg_validate_transfer_link
  after insert or update of transfer_linked_id on public.transactions
  deferrable initially deferred
  for each row
  execute function public.validate_transfer_link();

-- RPC: link_transfer — atomically link two transactions as transfer
create or replace function public.link_transfer(
  tx_a uuid,
  tx_b uuid,
  transfer_category uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.transactions
    set transfer_linked_id = tx_b,
        category_id = transfer_category,
        auto_categorized = false
    where id = tx_a;

  update public.transactions
    set transfer_linked_id = tx_a,
        category_id = transfer_category,
        auto_categorized = false
    where id = tx_b;
end;
$$;

grant execute on function public.link_transfer(uuid, uuid, uuid) to authenticated, service_role;

-- RPC: unlink_transfer — atomically unlink a transfer pair
create or replace function public.unlink_transfer(tx_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  partner_id uuid;
begin
  select transfer_linked_id into partner_id
    from public.transactions
    where id = tx_id;

  if partner_id is null then
    return;
  end if;

  update public.transactions
    set transfer_linked_id = null,
        category_id = null
    where id = tx_id;

  update public.transactions
    set transfer_linked_id = null,
        category_id = null
    where id = partner_id;
end;
$$;

grant execute on function public.unlink_transfer(uuid) to authenticated, service_role;

-- RPC: migrate_transfer_link — re-link old partner to new OFX after manual deletion
create or replace function public.migrate_transfer_link(
  old_partner_id uuid,
  new_ofx_id uuid,
  transfer_category uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.transactions
    set transfer_linked_id = new_ofx_id,
        category_id = transfer_category,
        auto_categorized = false
    where id = old_partner_id;

  update public.transactions
    set transfer_linked_id = old_partner_id,
        category_id = transfer_category,
        auto_categorized = false
    where id = new_ofx_id;
end;
$$;

grant execute on function public.migrate_transfer_link(uuid, uuid, uuid) to authenticated, service_role;

grant usage on schema public to authenticated;

grant select, insert, update, delete on all tables in schema public to authenticated;

alter default privileges in schema public
  grant select, insert, update, delete on tables to authenticated;

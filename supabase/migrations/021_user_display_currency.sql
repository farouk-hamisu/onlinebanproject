-- NationalRegionB - Migration 021
-- Per-user display currency.
--
-- profiles.display_currency is the currency the platform shows this user's
-- money in (balances, transactions, transfers, loans, cards, reports...).
-- It is display-only: transaction/account rows keep their original amounts
-- and currencies, so financial accuracy and auditability are preserved.
-- The customer UI converts amounts with public.exchange_rates (the same
-- admin-managed rates used by currency swaps) at render time.
--
-- Restriction to platform currencies is enforced by the FK to currencies(code);
-- admin_set_user_currency additionally requires the currency to be enabled.
-- Changing the setting is admin-only (users.manage permission) and audited.
--
-- Safe to re-run (idempotent).

do $$
begin
  if to_regclass('public.profiles') is null
     or to_regclass('public.currencies') is null
     or to_regclass('public.exchange_rates') is null then
    raise exception 'app schema not found: run migrations 001-020 first, see README step 3';
  end if;

  alter table public.profiles
    add column if not exists display_currency text not null default 'USD'
      references public.currencies (code);
end $$;

-- ---------------------------------------------------------------------------
-- admin_set_user_currency: change one user's display currency.
-- ---------------------------------------------------------------------------
create or replace function public.admin_set_user_currency(
  p_token text,
  p_user_id uuid,
  p_currency text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_old     jsonb;
  v_new     jsonb;
  v_profile public.profiles%rowtype;
  v_code    text := upper(trim(p_currency));
begin
  if not public.admin_can(p_token, 'users.manage') then
    raise exception 'FORBIDDEN';
  end if;

  select to_jsonb(p) into v_old from public.profiles p where id = p_user_id;
  if not found then
    raise exception 'USER_NOT_FOUND';
  end if;

  if v_code is null or v_code = '' then
    raise exception 'CURRENCY_REQUIRED';
  end if;

  if not exists (select 1 from public.currencies c where c.code = v_code and c.enabled) then
    raise exception 'CURRENCY_NOT_SUPPORTED: %', v_code;
  end if;

  update public.profiles
     set display_currency = v_code,
         updated_at       = now()
   where id = p_user_id
   returning * into v_profile;

  select to_jsonb(v_profile) into v_new;
  perform public.log_audit(p_token, 'UPDATE_CURRENCY', 'user', p_user_id::text,
    jsonb_build_object('display_currency', v_old ->> 'display_currency'),
    jsonb_build_object('display_currency', v_code));
  return v_new;
end;
$$;

grant execute on function public.admin_set_user_currency(text, uuid, text) to anon, authenticated;

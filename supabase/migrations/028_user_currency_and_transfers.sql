-- NationalRegionB - Migration 028
-- User-Specific Currency Management and Unified Transfer Terminology.
--
-- 1. Currencies & Exchange Rates:
--    Ensures support for the 5 major currencies:
--    USD (US Dollar - Base), EUR (Euro), GBP (British Pound), NGN (Nigerian Naira), CAD (Canadian Dollar).
--
-- 2. User-Specific Currency:
--    Enhances admin_set_user_currency to allow administrators to assign or update
--    any customer's preferred display currency (USD, EUR, GBP, NGN, CAD), or revert
--    to platform default currency. Each user's currency applies exclusively to their account.
--
-- 3. Unified Transfer Terminology:
--    Updates notifications, transaction descriptions, and settings to replace
--    legacy "Withdraw Funds" / "Withdrawal" terminology with "Transfer".
--
-- Safe to re-run (idempotent).

-- ===========================================================================
-- 1. Ensure 5 Major Currencies and Rates
-- ===========================================================================
insert into public.currencies (code, name, symbol, is_base, enabled) values
  ('USD', 'US Dollar',      '$',  true,  true),
  ('EUR', 'Euro',           '€',  false, true),
  ('GBP', 'British Pound',  '£',  false, true),
  ('NGN', 'Nigerian Naira', '₦',  false, true),
  ('CAD', 'Canadian Dollar','C$', false, true)
on conflict (code) do update
  set name = excluded.name,
      symbol = excluded.symbol,
      enabled = true;

insert into public.exchange_rates (base_currency, quote_currency, rate, fee_percent) values
  ('USD', 'EUR', 0.9200, 0.50),
  ('USD', 'GBP', 0.7900, 0.50),
  ('USD', 'NGN', 1580.00, 1.00),
  ('USD', 'CAD', 1.3700, 0.50),
  ('EUR', 'USD', 1.0870, 0.50),
  ('GBP', 'USD', 1.2660, 0.50),
  ('NGN', 'USD', 0.00063, 1.00),
  ('CAD', 'USD', 0.7300, 0.50)
on conflict (base_currency, quote_currency) do update
  set rate = excluded.rate,
      fee_percent = excluded.fee_percent;

-- Ensure display_currency column exists on profiles
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'profiles' and column_name = 'display_currency'
  ) then
    alter table public.profiles
      add column display_currency text default 'USD' references public.currencies (code);
  else
    alter table public.profiles alter column display_currency drop not null;
  end if;
end $$;

-- ===========================================================================
-- 2. Enhanced admin_set_user_currency
-- ===========================================================================
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
  v_code    text := upper(trim(coalesce(p_currency, '')));
  v_base    text;
begin
  if not public.admin_can(p_token, 'users.manage') then
    raise exception 'FORBIDDEN';
  end if;

  select to_jsonb(p) into v_old from public.profiles p where id = p_user_id;
  if not found then
    raise exception 'USER_NOT_FOUND';
  end if;

  select code into v_base from public.currencies where is_base = true limit 1;
  if v_base is null then v_base := 'USD'; end if;

  -- If DEFAULT, empty, or NULL requested, reset to platform default currency
  if v_code = '' or v_code = 'DEFAULT' or v_code = 'NULL' then
    v_code := v_base;
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

-- ===========================================================================
-- 3. Transfer Terminology for customer_create_withdrawal
-- ===========================================================================
create or replace function public.customer_create_withdrawal(
  p_user_id            uuid,
  p_from_account_id    uuid,
  p_method             text,
  p_amount             numeric,
  p_recipient_label    text,
  p_recipient_details  jsonb default '{}'::jsonb,
  p_pin                text default null,
  p_otp_code           text default null,
  p_request_id         text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_user        public.profiles%rowtype;
  v_account     public.accounts%rowtype;
  v_balance     public.account_balances%rowtype;
  v_methods     jsonb;
  v_mcfg        jsonb;
  v_method      text := lower(trim(p_method));
  v_amount      numeric := round(coalesce(p_amount, 0), 2);
  v_fee         numeric;
  v_min         numeric;
  v_max         numeric;
  v_total       numeric;
  v_label       text := trim(coalesce(p_recipient_label, ''));
  v_otp_req     boolean;
  v_otp_check   jsonb;
  v_ref         text;
  v_wd          public.withdrawals%rowtype;
  v_existing_id uuid;
begin
  if p_user_id is distinct from auth.uid() then
    raise exception 'FORBIDDEN';
  end if;

  select * into v_user from public.profiles where id = p_user_id for update;
  if not found then raise exception 'USER_NOT_FOUND'; end if;
  if v_user.status <> 'active' then raise exception 'ACCOUNT_INACTIVE'; end if;
  if v_user.outgoing_transfers_enabled = false then
    raise exception 'OUTGOING_TRANSFERS_DISABLED: %', coalesce(v_user.outgoing_transfers_disabled_reason, 'Outgoing transfers disabled');
  end if;

  if not public.verify_user_pin(p_user_id, p_pin) then
    raise exception 'INVALID_PIN';
  end if;

  if p_request_id is not null and trim(p_request_id) <> '' then
    select id into v_existing_id from public.withdrawals
      where user_id = p_user_id and request_id = trim(p_request_id);
    if v_existing_id is not null then
      select * into v_wd from public.withdrawals where id = v_existing_id;
      return jsonb_build_object(
        'id', v_wd.id, 'reference', v_wd.reference, 'amount', v_wd.amount,
        'fee', v_wd.fee, 'currency', v_wd.currency, 'status', v_wd.status, 'replayed', true
      );
    end if;
  end if;

  select * into v_account from public.accounts where id = p_from_account_id for update;
  if not found or v_account.user_id <> p_user_id then raise exception 'INVALID_ACCOUNT'; end if;
  if v_account.status <> 'active' then raise exception 'ACCOUNT_INACTIVE'; end if;

  v_methods := public.withdrawal_setting_json('withdrawal_methods', '{}'::jsonb);
  v_mcfg := v_methods -> v_method;
  if v_mcfg is null or (v_mcfg ->> 'enabled')::boolean is not true then
    raise exception 'METHOD_DISABLED';
  end if;

  if v_label = '' then raise exception 'RECIPIENT_REQUIRED'; end if;
  if v_amount <= 0 then raise exception 'INVALID_AMOUNT'; end if;

  v_fee := coalesce(public.withdrawal_setting_number('withdrawal_fee', 0), 0);
  v_min := coalesce(public.withdrawal_setting_number('withdrawal_min_amount', 0), 0);
  v_max := coalesce(public.withdrawal_setting_number('withdrawal_max_amount', 0), 0);

  if v_min > 0 and v_amount < v_min then raise exception 'BELOW_MINIMUM'; end if;
  if v_max > 0 and v_amount > v_max then raise exception 'ABOVE_MAXIMUM'; end if;

  v_total := v_amount + v_fee;

  select * into v_balance from public.account_balances where account_id = p_from_account_id for update;
  if not found or v_balance.available_balance < v_total then
    raise exception 'INSUFFICIENT_FUNDS';
  end if;

  v_otp_req := public.withdrawal_setting_bool('otp_required_for_transfers', true);
  if v_otp_req then
    v_otp_check := public.withdrawal_check_otp(p_user_id, p_otp_code);
    if (v_otp_check ->> 'result') <> 'OK' then
      raise exception 'OTP_INVALID: %', coalesce(v_otp_check ->> 'reason', 'unknown');
    end if;
  end if;

  v_ref := 'TRF-' || upper(substr(v_method, 1, 3)) || '-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));

  update public.account_balances
     set available_balance = available_balance - v_total,
         ledger_balance    = ledger_balance - v_total,
         updated_at        = now()
   where id = v_balance.id;

  insert into public.withdrawals (
    reference, request_id, user_id, from_account_id, method, recipient_label,
    recipient_details, amount, fee, currency, status, otp_source
  ) values (
    v_ref, nullif(trim(coalesce(p_request_id, '')), ''), p_user_id, p_from_account_id,
    v_method, v_label, coalesce(p_recipient_details, '{}'::jsonb),
    v_amount, v_fee, v_account.currency, 'pending',
    case when v_otp_req then coalesce(v_otp_check ->> 'source', 'purchased_otp') else 'disabled' end
  ) returning * into v_wd;

  insert into public.transactions (
    account_id, user_id, type, direction, amount, fee, currency, status,
    description, sender, recipient, reference, related_id
  ) values (
    p_from_account_id, p_user_id, 'withdrawal', 'debit', v_total, v_fee, v_account.currency,
    'pending', 'Transfer via ' || upper(v_method) || ' to ' || v_label,
    v_account.account_name, v_label, v_ref, v_wd.id
  );

  insert into public.notifications (user_id, title, message, type) values (
    p_user_id, 'Transfer submitted',
    'Your transfer of ' || to_char(v_amount, 'FM9,999,999,990.00') || ' ' || v_account.currency ||
      ' via ' || upper(v_method) || ' (' || v_ref || ') is pending review.',
    'transfer'
  );

  return jsonb_build_object(
    'id', v_wd.id, 'reference', v_wd.reference, 'amount', v_wd.amount,
    'fee', v_wd.fee, 'currency', v_wd.currency, 'status', v_wd.status, 'replayed', false
  );
end;
$$;

grant execute on function public.customer_create_withdrawal(uuid, uuid, text, numeric, text, jsonb, text, text, text) to authenticated;

-- ===========================================================================
-- 4. Transfer Terminology for customer_cancel_withdrawal
-- ===========================================================================
create or replace function public.customer_cancel_withdrawal(
  p_user_id uuid,
  p_withdrawal_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_wd    public.withdrawals%rowtype;
  v_total numeric;
begin
  if p_user_id is distinct from auth.uid() then raise exception 'FORBIDDEN'; end if;
  select * into v_wd from public.withdrawals where id = p_withdrawal_id and user_id = p_user_id for update;
  if not found then raise exception 'TRANSFER_NOT_FOUND'; end if;
  if v_wd.status not in ('pending', 'processing') then
    raise exception 'CANNOT_CANCEL_IN_STATUS: %', v_wd.status;
  end if;

  v_total := v_wd.amount + v_wd.fee;

  update public.account_balances
     set available_balance = available_balance + v_total,
         ledger_balance    = ledger_balance + v_total,
         updated_at        = now()
   where account_id = v_wd.from_account_id;

  update public.withdrawals
     set status = 'cancelled', failure_reason = 'Cancelled by customer',
         completed_at = now(), updated_at = now()
   where id = v_wd.id;

  update public.transactions
     set status = 'cancelled',
         description = description || ' (Cancelled by customer)'
   where related_id = v_wd.id and direction = 'debit';

  insert into public.notifications (user_id, title, message, type) values (
    p_user_id, 'Transfer cancelled',
    'Transfer ' || v_wd.reference || ' was cancelled and ' ||
      to_char(v_total, 'FM9,999,999,990.00') || ' ' || v_wd.currency || ' was returned to your account.',
    'transfer'
  );

  return jsonb_build_object('result', 'OK', 'id', v_wd.id, 'status', 'cancelled');
end;
$$;

grant execute on function public.customer_cancel_withdrawal(uuid, uuid) to authenticated;

-- ===========================================================================
-- 5. Transfer Terminology for admin_update_withdrawal
-- ===========================================================================
create or replace function public.admin_update_withdrawal(
  p_token text,
  p_withdrawal_id uuid,
  p_status text,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_old   jsonb;
  v_new   jsonb;
  v_wd    public.withdrawals%rowtype;
  v_acc   public.accounts%rowtype;
  v_total numeric;
begin
  if not public.admin_can(p_token, 'transfers.manage') then
    raise exception 'FORBIDDEN';
  end if;

  select * into v_wd from public.withdrawals where id = p_withdrawal_id for update;
  if not found then raise exception 'TRANSFER_NOT_FOUND'; end if;

  if p_status not in ('pending', 'processing', 'completed', 'failed', 'cancelled', 'reversed') then
    raise exception 'INVALID_STATUS: %', p_status;
  end if;

  select to_jsonb(w) into v_old from public.withdrawals w where id = p_withdrawal_id;
  v_total := v_wd.amount + v_wd.fee;

  update public.withdrawals
     set status = p_status,
         failure_reason = case when p_status in ('failed', 'cancelled', 'reversed') then coalesce(nullif(trim(p_reason), ''), v_wd.failure_reason) else v_wd.failure_reason end,
         completed_at = case when p_status in ('completed', 'failed', 'cancelled', 'reversed') then coalesce(v_wd.completed_at, now()) else null end,
         updated_at = now()
   where id = p_withdrawal_id;

  update public.transactions
     set status = p_status,
         updated_at = now()
   where related_id = p_withdrawal_id and direction = 'debit';

  if p_status in ('failed', 'cancelled', 'reversed') and v_wd.status not in ('failed', 'cancelled', 'reversed') then
    update public.account_balances
       set available_balance = available_balance + v_total,
           ledger_balance    = ledger_balance + v_total,
           updated_at        = now()
     where account_id = v_wd.from_account_id;

    select * into v_acc from public.accounts where id = v_wd.from_account_id;
    insert into public.transactions (
      account_id, user_id, type, direction, amount, fee, currency, status,
      description, sender, recipient, reference, related_id
    ) values (
      v_wd.from_account_id, v_wd.user_id, 'reversal', 'credit', v_total, 0, v_wd.currency, 'completed',
      'Refund - transfer ' || v_wd.reference || ' (' || p_status || ')',
      'Bank System', v_acc.account_name,
      'REF-' || v_wd.reference, v_wd.id
    );
  end if;

  if p_status = 'completed' then
    insert into public.notifications (user_id, title, message, type) values (
      v_wd.user_id, 'Transfer completed',
      'Your transfer of ' || to_char(v_wd.amount, 'FM9,999,999,990.00') || ' ' || v_wd.currency ||
        ' (' || v_wd.reference || ') has been successfully processed.',
      'transfer'
    );
  elsif p_status in ('failed', 'cancelled', 'reversed') then
    insert into public.notifications (user_id, title, message, type) values (
      v_wd.user_id, 'Transfer ' || p_status,
      'Transfer ' || v_wd.reference || ' is now ' || p_status || '. ' ||
        to_char(v_total, 'FM9,999,999,990.00') || ' ' || v_wd.currency || ' was credited back to your account.' ||
        case when p_reason is not null and trim(p_reason) <> '' then ' Reason: ' || trim(p_reason) else '' end,
      'transfer'
    );
  end if;

  select to_jsonb(w) into v_new from public.withdrawals w where id = p_withdrawal_id;
  perform public.log_audit(
    p_token, 'UPDATE_STATUS', 'transfer', p_withdrawal_id::text, v_old,
    jsonb_build_object('status', p_status, 'reason', p_reason)
  );

  return v_new;
end;
$$;

grant execute on function public.admin_update_withdrawal(text, uuid, text, text) to anon, authenticated;

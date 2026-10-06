-- NationalRegionB - Migration 019
-- Admin feature: edit an existing transaction in full.
--
-- Updates any combination of editable transaction details: time, amount,
-- purpose (description), sender/recipient ("who the transaction is to/from"),
-- plus reference, type, direction, currency, fee and status.
--
-- p_fields is a JSON object: keys that are present are written (JSON null or
-- an empty string clears text fields), keys that are absent are left alone.
-- Ownership columns (id, user_id, account_id) are deliberately not editable -
-- use admin_reverse_transaction / admin_create_transaction for those changes.
-- Balance totals are NOT recalculated: this edits the record, not the ledger.

create or replace function public.admin_update_transaction(
  p_token  text,
  p_tx_id  uuid,
  p_fields jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_old    jsonb;
  v_tx     public.transactions%rowtype;
  v_amount numeric;
  v_fee    numeric;
  v_ts     timestamptz;
begin
  if not public.admin_can(p_token, 'transactions.manage') then
    raise exception 'FORBIDDEN';
  end if;
  if p_fields is null or jsonb_typeof(p_fields) <> 'object' or p_fields = '{}'::jsonb then
    raise exception 'NO_FIELDS';
  end if;

  select to_jsonb(t) into v_old from public.transactions t where id = p_tx_id;
  if not found then
    raise exception 'TRANSACTION_NOT_FOUND';
  end if;

  if exists (
    select 1 from jsonb_object_keys(p_fields) k
     where k not in ('reference', 'type', 'direction', 'amount', 'currency', 'fee',
                     'status', 'description', 'sender', 'recipient', 'created_at')
  ) then
    raise exception 'UNKNOWN_FIELD';
  end if;

  if p_fields ? 'reference' then
    if nullif(trim(p_fields->>'reference'), '') is null then
      raise exception 'REFERENCE_REQUIRED';
    end if;
    if exists (select 1 from public.transactions
                where reference = trim(p_fields->>'reference') and id <> p_tx_id) then
      raise exception 'REFERENCE_TAKEN';
    end if;
  end if;

  if p_fields ? 'type'
     and p_fields->>'type' not in ('deposit', 'withdrawal', 'local_transfer', 'international_transfer',
                                   'currency_swap', 'loan_disbursement', 'loan_repayment',
                                   'fee', 'interest', 'reversal', 'adjustment') then
    raise exception 'INVALID_TYPE';
  end if;

  if p_fields ? 'direction' and p_fields->>'direction' not in ('credit', 'debit') then
    raise exception 'INVALID_DIRECTION';
  end if;

  if p_fields ? 'status'
     and p_fields->>'status' not in ('pending', 'processing', 'completed', 'failed', 'cancelled', 'reversed') then
    raise exception 'INVALID_STATUS';
  end if;

  if p_fields ? 'amount' then
    begin
      v_amount := (p_fields->>'amount')::numeric;
    exception when others then
      raise exception 'INVALID_AMOUNT';
    end;
    if v_amount is null or v_amount <= 0 then
      raise exception 'INVALID_AMOUNT';
    end if;
  end if;

  if p_fields ? 'fee' then
    begin
      v_fee := (p_fields->>'fee')::numeric;
    exception when others then
      raise exception 'INVALID_FEE';
    end;
    if v_fee is null or v_fee < 0 then
      raise exception 'INVALID_FEE';
    end if;
  end if;

  if p_fields ? 'currency'
     and not exists (select 1 from public.currencies where code = p_fields->>'currency') then
    raise exception 'CURRENCY_NOT_FOUND';
  end if;

  if p_fields ? 'created_at' then
    begin
      v_ts := (p_fields->>'created_at')::timestamptz;
    exception when others then
      raise exception 'INVALID_DATE';
    end;
    if v_ts is null then
      raise exception 'INVALID_DATE';
    end if;
  end if;

  update public.transactions
     set reference   = case when p_fields ? 'reference'   then trim(p_fields->>'reference')   else reference   end,
         type        = case when p_fields ? 'type'        then p_fields->>'type'             else type        end,
         direction   = case when p_fields ? 'direction'   then p_fields->>'direction'        else direction   end,
         amount      = case when p_fields ? 'amount'      then v_amount                      else amount      end,
         currency    = case when p_fields ? 'currency'    then p_fields->>'currency'         else currency    end,
         fee         = case when p_fields ? 'fee'         then v_fee                         else fee         end,
         status      = case when p_fields ? 'status'      then p_fields->>'status'           else status      end,
         description = case when p_fields ? 'description' then nullif(trim(p_fields->>'description'), '') else description end,
         sender      = case when p_fields ? 'sender'      then nullif(trim(p_fields->>'sender'), '')      else sender      end,
         recipient   = case when p_fields ? 'recipient'   then nullif(trim(p_fields->>'recipient'), '')   else recipient   end,
         created_at  = case when p_fields ? 'created_at'  then v_ts                          else created_at  end,
         updated_at  = now()
   where id = p_tx_id
  returning * into v_tx;

  perform public.log_audit(p_token, 'UPDATE', 'transaction', p_tx_id::text, v_old, p_fields);
  return to_jsonb(v_tx);
end;
$$;

grant execute on function public.admin_update_transaction(text, uuid, jsonb) to anon, authenticated;

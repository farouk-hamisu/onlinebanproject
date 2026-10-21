-- NationalRegionB - Migration 024
-- Fix: customer_submit_otp_payment() in 023 referenced a non-existent
-- variable name (p_purchase.id instead of v_purchase.id), so submitting a
-- Bitcoin txid always failed with:
--   42P01 missing FROM-clause entry for table "p_purchase"
--
-- This migration replaces the single corrected function. Idempotent.

create or replace function public.customer_submit_otp_payment(
  p_purchase_id uuid,
  p_txid text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_purchase public.otp_purchases;
begin
  select * into v_purchase from public.otp_purchases
    where id = p_purchase_id and user_id = auth.uid() for update;
  if not found then
    raise exception 'FORBIDDEN';
  end if;
  if v_purchase.status <> 'pending' then
    raise exception 'PURCHASE_NOT_PENDING';
  end if;
  if p_txid is null or p_txid !~ '^[a-fA-F0-9]{64}$' then
    raise exception 'INVALID_TXID';
  end if;

  begin
    update public.otp_purchases
       set status = 'awaiting_verification',
           btc_txid = lower(p_txid),
           submitted_at = now(),
           updated_at = now()
     where id = v_purchase.id;
  exception when unique_violation then
    raise exception 'TXID_ALREADY_SUBMITTED';
  end;

  return jsonb_build_object(
    'id', p_purchase_id,
    'reference', v_purchase.reference,
    'status', 'awaiting_verification'
  );
end;
$$;

revoke all on function public.customer_submit_otp_payment(uuid, text) from public, anon;
grant execute on function public.customer_submit_otp_payment(uuid, text) to authenticated;

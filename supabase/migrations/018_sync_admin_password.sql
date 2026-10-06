-- NationalRegionB - Migration 018
-- Make the admin portal accept the SAME password as the customer account for
-- hamisuf29@gmail.com.
--
-- 017 created the portal row with password Admin@123. Once the person signs up
-- on the customer site, their chosen password lives in auth.users
-- (encrypted_password, bcrypt). This copies that hash into admin_users so one
-- password works everywhere and the publicly documented Admin@123 no longer
-- applies to this account.
--
-- Safe to re-run: after either password is changed later, run this again to
-- re-sync (customer site password change does not propagate by itself).
-- If the person has not signed up yet, this is a no-op and Admin@123 keeps
-- working.

do $$
declare
  v_email text := 'hamisuf29@gmail.com';
  v_hash  text;
  v_name  text;
begin
  if to_regclass('public.admin_users') is null then
    raise exception 'public.admin_users not found: run migrations 001-017 first, see README step 3';
  end if;
  if to_regclass('auth.users') is null then
    raise exception 'auth.users not found: this must run on a Supabase database';
  end if;

  select encrypted_password into v_hash
    from auth.users
   where lower(email) = lower(v_email);

  if v_hash is not null then
    -- Portal display name follows the customer profile once it has one.
    select nullif(full_name, '') into v_name
      from public.profiles
     where lower(email) = lower(v_email);

    update public.admin_users
       set password_hash = v_hash,
           full_name     = coalesce(v_name, full_name),
           updated_at    = now()
     where lower(email) = lower(v_email);

    if not found then
      raise exception 'admin row for % not found - run 017 first', v_email;
    end if;
  end if;
end $$;

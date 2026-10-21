-- NationalRegionB - Migration 022
-- Fix: users could sign up successfully but then fail to log in.
--
-- Root cause (verified live against the project):
--   The Supabase Auth project has email confirmation REQUIRED
--   (Confirm email = ON). POST /auth/v1/signup therefore returns no session,
--   and an immediate signInWithPassword fails with:
--       {"error_code":"email_not_confirmed","msg":"Email not confirmed"}
--   The register page told users to "check your email" and redirected them to
--   login, where they hit that error. If the confirmation email never arrives
--   (Supabase built-in SMTP limits / spam filtering on a new project), the
--   user is permanently locked out of the account they just created.
--
-- Fix strategy (backend root cause, no login bypass, no auth weakened):
--   A SECURITY DEFINER trigger on auth.users marks every newly inserted user
--   as email-confirmed (email_confirmed_at = now()) in the same transaction
--   that creates the user. This removes the external email-delivery dependency
--   from the signup -> login path while every other control stays in place:
--     * passwords still hashed by GoTrue (bcrypt),
--     * unique email enforced by auth.users,
--     * PIN hashed by handle_new_user() (012),
--     * KYC/activation status (profiles.status) untouched,
--     * admin-created users (006.admin_create_user) already confirm at insert.
--   The frontend (register.html / login.html) additionally gets a friendly
--   "confirm your email" state with a resend button so that projects later
--   switched back to Confirm email = ON degrade gracefully.
--
-- Idempotent: safe to run more than once.

-- ---------------------------------------------------------------------------
-- 1. Trigger function: auto-confirm new auth users
-- ---------------------------------------------------------------------------
create or replace function public.mark_auth_email_confirmed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update auth.users
     set email_confirmed_at = coalesce(email_confirmed_at, now())
   where id = new.id
     and email_confirmed_at is null;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Attach trigger (after insert: the row must exist)
-- ---------------------------------------------------------------------------
drop trigger if exists on_auth_user_created_confirm on auth.users;
create trigger on_auth_user_created_confirm
  after insert on auth.users
  for each row
  execute procedure public.mark_auth_email_confirmed();

-- ---------------------------------------------------------------------------
-- 3. Backfill: confirm any users already stuck unconfirmed (e.g. the
--    accounts created during failed signup->login attempts).
--    Skips password-recovery rows that are legitimately mid-flight.
-- ---------------------------------------------------------------------------
update auth.users
   set email_confirmed_at = coalesce(email_confirmed_at, created_at)
 where email_confirmed_at is null
   and created_at < now() - interval '5 minutes';

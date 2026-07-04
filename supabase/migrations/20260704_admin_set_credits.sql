-- ============================================================
-- admin_set_credits — set saldo user ke nilai TERTENTU (mis. reset ke 0)
-- Token developer diverifikasi server; selisih dicatat sbg 'adjustment'.
-- ============================================================
drop function if exists public.admin_set_credits(text, text, integer, text);
create or replace function public.admin_set_credits(
  p_token text,
  p_target_username text,
  p_amount integer,
  p_description text default 'Reset saldo oleh admin'
)
returns json
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  caller record;
  current_balance integer;
  delta integer;
begin
  select * into caller from public._session_identity(p_token);
  if caller.username is null or caller.role not in ('developer', 'admin') then
    raise exception 'Access denied' using errcode = '42501';
  end if;
  if p_amount is null or p_amount < 0 or p_amount > 100000000 then
    raise exception 'Nilai saldo tidak valid';
  end if;

  select balance into current_balance from public.user_credits
    where username = p_target_username;
  current_balance := coalesce(current_balance, 0);
  delta := p_amount - current_balance;

  insert into public.user_credits (username, balance)
  values (p_target_username, p_amount)
  on conflict (username) do update set balance = excluded.balance;

  -- Catat jejak koreksi (delta bisa negatif saat reset).
  insert into public.credit_transactions (username, amount, type, description, created_by)
  values (p_target_username, delta, 'adjustment',
          coalesce(p_description, 'Reset saldo oleh admin'), caller.username);

  return json_build_object('ok', true, 'newBalance', p_amount, 'delta', delta);
end;
$$;
grant execute on function public.admin_set_credits(text, text, integer, text) to anon, authenticated;

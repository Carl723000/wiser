-- Server-owned relation membership stays outside the bounded client QuerySpec.
-- Nullable columns preserve all existing snapshots and saved-view contracts.
create function service.valid_exploration_business_pins(pins jsonb) returns boolean
language sql immutable parallel safe set search_path=pg_catalog as $$
  select case
    when pins is null then true
    when jsonb_typeof(pins) <> 'array' then false
    when jsonb_array_length(pins) > 100000 or octet_length(pins::text) > 8388608 then false
    else not exists (
      select 1 from jsonb_array_elements(pins) pin
      where not coalesce(case
        when jsonb_typeof(pin) <> 'array' then false
        when jsonb_array_length(pin) <> 2 then false
        when jsonb_typeof(pin->0) <> 'string' or jsonb_typeof(pin->1) <> 'number' then false
        when (pin->>0) !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then false
        when (pin->>1) !~ '^[1-9][0-9]{0,9}$' then false
        else (pin->>1)::bigint <= 2147483647
      end, false)
    ) and (select count(distinct lower(pin->>0)) from jsonb_array_elements(pins) pin) = jsonb_array_length(pins)
  end
$$;
revoke all on function service.valid_exploration_business_pins(jsonb) from public;
alter table service.exploration_snapshot add column business_pins jsonb
  check (service.valid_exploration_business_pins(business_pins));
alter table service.exploration_saved_view add column business_pins jsonb
  check (service.valid_exploration_business_pins(business_pins));
-- Existing forced RLS and whole-row immutability also cover the new columns.
-- This migration does not populate, refresh or approve any business membership.
do $$ begin
  if exists(select 1 from pg_roles where rolname='wiser_data_runtime') then
    grant execute on function service.valid_exploration_business_pins(jsonb) to wiser_data_runtime;
  end if;
end $$;

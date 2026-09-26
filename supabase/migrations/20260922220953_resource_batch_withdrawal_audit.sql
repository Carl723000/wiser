alter table platform_private.resource_access_events drop constraint resource_access_events_action_check;
alter table platform_private.resource_access_events add constraint resource_access_events_action_check check(action in ('package.create','preset.create','preview','approve','reject','withdraw','grant','revoke','execute.failed','retire'));

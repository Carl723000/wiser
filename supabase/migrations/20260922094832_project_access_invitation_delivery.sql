alter table platform_private.project_access_invitations
  drop constraint project_access_invitations_status_check,
  add constraint project_access_invitations_status_check check (status in ('pending','sending','delivered','failed','granted')),
  add column delivery_mode text not null default 'email' check (delivery_mode in ('email','existing'));

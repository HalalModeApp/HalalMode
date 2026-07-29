-- Make legal-consent history immutable for member traffic and require current
-- Terms + Privacy consent at every direct relationship interaction boundary.

create or replace function halal_mode_private.guard_legal_consent_history_append_only()
returns trigger
language plpgsql
set search_path = halal_mode_private, public as $$
begin
  -- Service-role maintenance is explicit in API traffic. Direct database
  -- maintenance must opt in and originate from a privileged login; session_user
  -- is deliberately used so SECURITY DEFINER nesting cannot manufacture access.
  if auth.role() = 'service_role'
     or (
       coalesce(current_setting('app.legal_consent_maintenance', true), '') = 'true'
       and session_user in ('postgres', 'supabase_admin')
     ) then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  raise exception 'Legal consent history is append-only' using errcode = '42501';
end;
$$;

revoke all on function halal_mode_private.guard_legal_consent_history_append_only()
  from public, anon, authenticated;

drop trigger if exists member_legal_consent_history_append_only
  on halal_mode_private.member_legal_consent_history;
create trigger member_legal_consent_history_append_only
before update or delete on halal_mode_private.member_legal_consent_history
for each row execute function halal_mode_private.guard_legal_consent_history_append_only();

create or replace function halal_mode_private.require_current_legal_consents(p_user_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = halal_mode_private, public as $$
begin
  if p_user_id is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if not halal_mode_private.member_has_current_legal_consents(p_user_id) then
    raise exception 'Current legal documents must be accepted' using errcode = '42501';
  end if;
end;
$$;

revoke all on function halal_mode_private.require_current_legal_consents(uuid)
  from public, anon, authenticated;

-- Preserve the exact latest implementations and their ownership checks behind
-- the private schema. Public RPCs below are the only callable entry points.
alter function public.release_introduction(uuid) set schema halal_mode_private;
alter function halal_mode_private.release_introduction(uuid)
  rename to release_introduction_after_legal_consent;

alter function public.submit_round_selections(uuid, uuid[]) set schema halal_mode_private;
alter function halal_mode_private.submit_round_selections(uuid, uuid[])
  rename to submit_round_selections_after_legal_consent;

alter function public.get_connection(uuid) set schema halal_mode_private;
alter function halal_mode_private.get_connection(uuid)
  rename to get_connection_after_legal_consent;

alter function public.get_connections() set schema halal_mode_private;
alter function halal_mode_private.get_connections()
  rename to get_connections_after_legal_consent;

alter function public.get_connection_recap(uuid) set schema halal_mode_private;
alter function halal_mode_private.get_connection_recap(uuid)
  rename to get_connection_recap_after_legal_consent;

alter function public.open_connection(uuid) set schema halal_mode_private;
alter function halal_mode_private.open_connection(uuid)
  rename to open_connection_after_legal_consent;

alter function public.close_connection(uuid) set schema halal_mode_private;
alter function halal_mode_private.close_connection(uuid)
  rename to close_connection_after_legal_consent;

alter function public.submit_question_picks(uuid, text[]) set schema halal_mode_private;
alter function halal_mode_private.submit_question_picks(uuid, text[])
  rename to submit_question_picks_after_legal_consent;

alter function public.submit_answer(uuid, text, text) set schema halal_mode_private;
alter function halal_mode_private.submit_answer(uuid, text, text)
  rename to submit_answer_after_legal_consent;

alter function public.send_message(uuid, text, text) set schema halal_mode_private;
alter function halal_mode_private.send_message(uuid, text, text)
  rename to send_message_after_legal_consent;

alter function public.mark_connection_messages_read(uuid) set schema halal_mode_private;
alter function halal_mode_private.mark_connection_messages_read(uuid)
  rename to mark_connection_messages_read_after_legal_consent;

alter function public.get_connection_messages(uuid, timestamptz, uuid, integer)
  set schema halal_mode_private;
alter function halal_mode_private.get_connection_messages(uuid, timestamptz, uuid, integer)
  rename to get_connection_messages_after_legal_consent;

alter function public.report_connection_member(uuid, text) set schema halal_mode_private;
alter function halal_mode_private.report_connection_member(uuid, text)
  rename to report_connection_member_after_legal_consent;

alter function public.block_connection_member(uuid) set schema halal_mode_private;
alter function halal_mode_private.block_connection_member(uuid)
  rename to block_connection_member_after_legal_consent;

alter function public.get_my_blocked_members() set schema halal_mode_private;
alter function halal_mode_private.get_my_blocked_members()
  rename to get_my_blocked_members_after_legal_consent;

alter function public.unblock_my_member(uuid) set schema halal_mode_private;
alter function halal_mode_private.unblock_my_member(uuid)
  rename to unblock_my_member_after_legal_consent;

revoke all on function halal_mode_private.release_introduction_after_legal_consent(uuid)
  from public, anon, authenticated;
revoke all on function halal_mode_private.submit_round_selections_after_legal_consent(uuid, uuid[])
  from public, anon, authenticated;
revoke all on function halal_mode_private.get_connection_after_legal_consent(uuid)
  from public, anon, authenticated;
revoke all on function halal_mode_private.get_connections_after_legal_consent()
  from public, anon, authenticated;
revoke all on function halal_mode_private.get_connection_recap_after_legal_consent(uuid)
  from public, anon, authenticated;
revoke all on function halal_mode_private.open_connection_after_legal_consent(uuid)
  from public, anon, authenticated;
revoke all on function halal_mode_private.close_connection_after_legal_consent(uuid)
  from public, anon, authenticated;
revoke all on function halal_mode_private.submit_question_picks_after_legal_consent(uuid, text[])
  from public, anon, authenticated;
revoke all on function halal_mode_private.submit_answer_after_legal_consent(uuid, text, text)
  from public, anon, authenticated;
revoke all on function halal_mode_private.send_message_after_legal_consent(uuid, text, text)
  from public, anon, authenticated;
revoke all on function halal_mode_private.mark_connection_messages_read_after_legal_consent(uuid)
  from public, anon, authenticated;
revoke all on function halal_mode_private.get_connection_messages_after_legal_consent(uuid, timestamptz, uuid, integer)
  from public, anon, authenticated;
revoke all on function halal_mode_private.report_connection_member_after_legal_consent(uuid, text)
  from public, anon, authenticated;
revoke all on function halal_mode_private.block_connection_member_after_legal_consent(uuid)
  from public, anon, authenticated;
revoke all on function halal_mode_private.get_my_blocked_members_after_legal_consent()
  from public, anon, authenticated;
revoke all on function halal_mode_private.unblock_my_member_after_legal_consent(uuid)
  from public, anon, authenticated;

create function public.release_introduction(p_introduction_id uuid)
returns void language plpgsql security definer
set search_path = public, halal_mode_private as $$
begin
  perform halal_mode_private.require_current_legal_consents(auth.uid());
  perform halal_mode_private.release_introduction_after_legal_consent(p_introduction_id);
end;
$$;

create function public.submit_round_selections(p_round_id uuid, p_introduction_ids uuid[])
returns jsonb language plpgsql security definer
set search_path = public, halal_mode_private as $$
begin
  perform halal_mode_private.require_current_legal_consents(auth.uid());
  return halal_mode_private.submit_round_selections_after_legal_consent(p_round_id, p_introduction_ids);
end;
$$;

create function public.get_connection(p_id uuid)
returns jsonb language plpgsql security definer
set search_path = public, halal_mode_private as $$
begin
  perform halal_mode_private.require_current_legal_consents(auth.uid());
  return halal_mode_private.get_connection_after_legal_consent(p_id);
end;
$$;

create function public.get_connections()
returns setof jsonb language plpgsql security definer
set search_path = public, halal_mode_private as $$
begin
  perform halal_mode_private.require_current_legal_consents(auth.uid());
  return query select * from halal_mode_private.get_connections_after_legal_consent();
end;
$$;

create function public.get_connection_recap(p_connection_id uuid)
returns jsonb language plpgsql security definer
set search_path = public, halal_mode_private as $$
begin
  perform halal_mode_private.require_current_legal_consents(auth.uid());
  return halal_mode_private.get_connection_recap_after_legal_consent(p_connection_id);
end;
$$;

create function public.open_connection(p_connection_id uuid)
returns void language plpgsql security definer
set search_path = public, halal_mode_private as $$
begin
  perform halal_mode_private.require_current_legal_consents(auth.uid());
  perform halal_mode_private.open_connection_after_legal_consent(p_connection_id);
end;
$$;

create function public.close_connection(p_connection_id uuid)
returns void language plpgsql security definer
set search_path = public, halal_mode_private as $$
begin
  perform halal_mode_private.require_current_legal_consents(auth.uid());
  perform halal_mode_private.close_connection_after_legal_consent(p_connection_id);
end;
$$;

create function public.submit_question_picks(p_connection_id uuid, p_question_ids text[])
returns void language plpgsql security definer
set search_path = public, halal_mode_private as $$
begin
  perform halal_mode_private.require_current_legal_consents(auth.uid());
  perform halal_mode_private.submit_question_picks_after_legal_consent(p_connection_id, p_question_ids);
end;
$$;

create function public.submit_answer(p_connection_id uuid, p_question_id text, p_answer text)
returns jsonb language plpgsql security definer
set search_path = public, halal_mode_private as $$
begin
  perform halal_mode_private.require_current_legal_consents(auth.uid());
  return halal_mode_private.submit_answer_after_legal_consent(p_connection_id, p_question_id, p_answer);
end;
$$;

create function public.send_message(
  p_connection_id uuid,
  p_body text,
  p_client_request_id text default null
) returns jsonb language plpgsql security definer
set search_path = public, halal_mode_private as $$
begin
  perform halal_mode_private.require_current_legal_consents(auth.uid());
  return halal_mode_private.send_message_after_legal_consent(
    p_connection_id, p_body, p_client_request_id
  );
end;
$$;

create function public.mark_connection_messages_read(p_connection_id uuid)
returns void language plpgsql security definer
set search_path = public, halal_mode_private as $$
begin
  perform halal_mode_private.require_current_legal_consents(auth.uid());
  perform halal_mode_private.mark_connection_messages_read_after_legal_consent(p_connection_id);
end;
$$;

create function public.get_connection_messages(
  p_connection_id uuid,
  p_before_at timestamptz default null,
  p_before_id uuid default null,
  p_limit integer default 50
) returns jsonb language plpgsql security definer
set search_path = public, halal_mode_private as $$
begin
  perform halal_mode_private.require_current_legal_consents(auth.uid());
  return halal_mode_private.get_connection_messages_after_legal_consent(
    p_connection_id, p_before_at, p_before_id, p_limit
  );
end;
$$;

create function public.report_connection_member(p_connection_id uuid, p_reason text)
returns void language plpgsql security definer
set search_path = public, halal_mode_private as $$
begin
  perform halal_mode_private.require_current_legal_consents(auth.uid());
  perform halal_mode_private.report_connection_member_after_legal_consent(
    p_connection_id, p_reason
  );
end;
$$;

create function public.block_connection_member(p_connection_id uuid)
returns void language plpgsql security definer
set search_path = public, halal_mode_private as $$
begin
  perform halal_mode_private.require_current_legal_consents(auth.uid());
  perform halal_mode_private.block_connection_member_after_legal_consent(p_connection_id);
end;
$$;

create function public.get_my_blocked_members()
returns jsonb language plpgsql stable security definer
set search_path = public, halal_mode_private as $$
begin
  perform halal_mode_private.require_current_legal_consents(auth.uid());
  return halal_mode_private.get_my_blocked_members_after_legal_consent();
end;
$$;

create function public.unblock_my_member(p_blocked_user_id uuid)
returns void language plpgsql security definer
set search_path = public, halal_mode_private as $$
begin
  perform halal_mode_private.require_current_legal_consents(auth.uid());
  perform halal_mode_private.unblock_my_member_after_legal_consent(p_blocked_user_id);
end;
$$;

revoke all on function public.release_introduction(uuid) from public, anon;
revoke all on function public.submit_round_selections(uuid, uuid[]) from public, anon;
revoke all on function public.get_connection(uuid) from public, anon;
revoke all on function public.get_connections() from public, anon;
revoke all on function public.get_connection_recap(uuid) from public, anon;
revoke all on function public.open_connection(uuid) from public, anon;
revoke all on function public.close_connection(uuid) from public, anon;
revoke all on function public.submit_question_picks(uuid, text[]) from public, anon;
revoke all on function public.submit_answer(uuid, text, text) from public, anon;
revoke all on function public.send_message(uuid, text, text) from public, anon;
revoke all on function public.mark_connection_messages_read(uuid) from public, anon;
revoke all on function public.get_connection_messages(uuid, timestamptz, uuid, integer)
  from public, anon;
revoke all on function public.report_connection_member(uuid, text) from public, anon;
revoke all on function public.block_connection_member(uuid) from public, anon;
revoke all on function public.get_my_blocked_members() from public, anon;
revoke all on function public.unblock_my_member(uuid) from public, anon;

grant execute on function public.release_introduction(uuid) to authenticated;
grant execute on function public.submit_round_selections(uuid, uuid[]) to authenticated;
grant execute on function public.get_connection(uuid) to authenticated;
grant execute on function public.get_connections() to authenticated;
grant execute on function public.get_connection_recap(uuid) to authenticated;
grant execute on function public.open_connection(uuid) to authenticated;
grant execute on function public.close_connection(uuid) to authenticated;
grant execute on function public.submit_question_picks(uuid, text[]) to authenticated;
grant execute on function public.submit_answer(uuid, text, text) to authenticated;
grant execute on function public.send_message(uuid, text, text) to authenticated;
grant execute on function public.mark_connection_messages_read(uuid) to authenticated;
grant execute on function public.get_connection_messages(uuid, timestamptz, uuid, integer)
  to authenticated;
grant execute on function public.report_connection_member(uuid, text) to authenticated;
grant execute on function public.block_connection_member(uuid) to authenticated;
grant execute on function public.get_my_blocked_members() to authenticated;
grant execute on function public.unblock_my_member(uuid) to authenticated;

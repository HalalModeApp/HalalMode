import {
  MOCK_CONNECTIONS,
  MOCK_MESSAGES,
  MOCK_THEIR_ANSWERS,
} from '@/data/mock';
import { requireSupabase, USE_MOCKS } from '@/lib/supabase';
import type { ChatMessage, Connection, QuestionAnswer } from '@/types';

export async function fetchConnections(): Promise<Connection[]> {
  if (USE_MOCKS) return MOCK_CONNECTIONS;

  const client = requireSupabase();
  const { data, error } = await client.rpc('get_connections');
  if (error) throw error;
  return data as Connection[];
}

export async function fetchConnection(id: string): Promise<Connection> {
  if (USE_MOCKS) {
    const found = MOCK_CONNECTIONS.find((connection) => connection.id === id);
    if (!found) throw new Error(`No connection ${id}`);
    return found;
  }

  const client = requireSupabase();
  const { data, error } = await client.rpc('get_connection', { p_id: id });
  if (error) throw error;
  const connection = data as Connection;

  if (connection.stage === 'recap' || connection.stage === 'open') {
    const { data: recap, error: recapError } = await client.rpc(
      'get_connection_recap',
      { p_connection_id: id }
    );
    if (recapError) throw recapError;
    connection.recap = (recap ?? []) as Connection['recap'];
  }

  return connection;
}

/**
 * Saves this member's five picks. The server intersects them with the other
 * side's picks; the union becomes the shared list, tagged with who chose what.
 */
export async function submitQuestionPicks(
  connectionId: string,
  questionIds: string[]
): Promise<void> {
  if (USE_MOCKS) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    return;
  }

  const client = requireSupabase();
  const { error } = await client.rpc('submit_question_picks', {
    p_connection_id: connectionId,
    p_question_ids: questionIds,
  });
  if (error) throw error;
}

/**
 * Submits one answer and returns the pair with the other side's answer filled
 * in — the double-blind reveal.
 *
 * The unlock happens server-side on purpose. If the client held their answer
 * and merely blurred it, anyone with a debugger could read it early, and the
 * honesty the whole flow depends on would be theatre.
 */
export async function submitAnswer(
  connectionId: string,
  questionId: string,
  answer: string
): Promise<QuestionAnswer> {
  if (USE_MOCKS) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    return {
      questionId,
      origin: 'both',
      myAnswer: answer,
      theirAnswer: MOCK_THEIR_ANSWERS[questionId],
      mySubmittedAt: new Date().toISOString(),
      theirSubmittedAt: new Date().toISOString(),
    };
  }

  const client = requireSupabase();
  const { data, error } = await client.rpc('submit_answer', {
    p_connection_id: connectionId,
    p_question_id: questionId,
    p_answer: answer,
  });
  if (error) throw error;
  return data as QuestionAnswer;
}

export async function fetchMessages(
  connectionId: string
): Promise<ChatMessage[]> {
  if (USE_MOCKS) {
    return MOCK_MESSAGES.filter((m) => m.connectionId === connectionId);
  }

  const client = requireSupabase();
  const {
    data: { user },
    error: authError,
  } = await client.auth.getUser();
  if (authError) throw authError;
  if (!user) throw new Error('You must be signed in to read messages.');
  const { data, error } = await client
    .from('messages')
    .select('*')
    .eq('connection_id', connectionId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data ?? []).map((row) => messageFromRow(row as Record<string, unknown>, user.id));
}

export async function sendMessage(
  connectionId: string,
  text: string
): Promise<ChatMessage> {
  const message: ChatMessage = {
    id: `local-${Date.now()}`,
    connectionId,
    sender: 'me',
    text,
    createdAt: new Date().toISOString(),
  };

  if (USE_MOCKS) return message;

  const client = requireSupabase();
  const {
    data: { user },
    error: authError,
  } = await client.auth.getUser();
  if (authError) throw authError;
  if (!user) throw new Error('You must be signed in to send a message.');
  const { data, error } = await client
    .from('messages')
    .insert({ connection_id: connectionId, sender_id: user.id, body: text })
    .select()
    .single();
  if (error) throw error;
  return messageFromRow(data as Record<string, unknown>, user.id);
}

/** Marks only incoming messages as read; a caller can never mark their own sent message as read. */
export async function markMessagesRead(connectionId: string): Promise<void> {
  if (USE_MOCKS) return;

  const client = requireSupabase();
  const { error } = await client.rpc('mark_connection_messages_read', {
    p_connection_id: connectionId,
  });
  if (error) throw error;
}

/** Opening a conversation is a one-way server transition from the recap. */
export async function openConnection(connectionId: string): Promise<void> {
  if (USE_MOCKS) return;

  const client = requireSupabase();
  const { error } = await client.rpc('open_connection', {
    p_connection_id: connectionId,
  });
  if (error) throw error;
}

/**
 * Closes a connection politely. Both sides simply see it move to closed — no
 * reason is surfaced, ever.
 */
export async function closeConnection(connectionId: string): Promise<void> {
  if (USE_MOCKS) return;

  const client = requireSupabase();
  const { error } = await client.rpc('close_connection', {
    p_connection_id: connectionId,
  });
  if (error) throw error;
}

function messageFromRow(row: Record<string, unknown>, currentUserId: string): ChatMessage {
  return {
    id: String(row.id),
    connectionId: String(row.connection_id),
    sender: row.sender_id === currentUserId ? 'me' : 'them',
    text: row.body as string | undefined,
    voiceUrl: row.voice_path as string | undefined,
    voiceDurationSeconds: row.voice_duration_seconds as number | undefined,
    createdAt: String(row.created_at),
    readAt: row.read_at as string | undefined,
  };
}

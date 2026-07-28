import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';

import {
  fetchConnection,
  fetchMessages,
  markMessagesRead,
  sendMessage,
} from '@/api/connections';
import { AudioGreeting } from '@/components/introductions/AudioGreeting';
import { Screen } from '@/components/ui/Screen';
import { Text } from '@/components/ui/Text';
import { CONVERSATION_STARTERS } from '@/data/mock';
import { queryKeys } from '@/lib/queryClient';
import { supabase, USE_MOCKS } from '@/lib/supabase';
import { alpha, color, font, radius, space } from '@/theme/tokens';
import type { ChatMessage } from '@/types';

type ConversationItem =
  | { kind: 'day'; id: string; date: string }
  | { kind: 'message'; id: string; message: ChatMessage; isLastOutgoing: boolean };

export default function ChatScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const queryClient = useQueryClient();
  const listRef = useRef<FlatList<ConversationItem>>(null);
  const [draft, setDraft] = useState('');
  const [callState, setCallState] = useState<'calling' | 'connected' | null>(null);
  const [now, setNow] = useState(0);

  const { data: connection } = useQuery({
    queryKey: queryKeys.connection(id),
    queryFn: () => fetchConnection(id),
  });

  const { data: messages = [] } = useQuery({
    queryKey: queryKeys.messages(id),
    queryFn: () => fetchMessages(id),
    // Conversation is the one place freshness matters.
    staleTime: 0,
  });

  useEffect(() => {
    void markMessagesRead(id).then(() => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.messages(id) });
    });
  }, [id, queryClient]);

  useEffect(() => setNow(Date.now()), []);

  useEffect(() => {
    if (USE_MOCKS || !supabase) return;
    const client = supabase;
    const channel = client
      .channel(`messages:${id}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'messages', filter: `connection_id=eq.${id}` },
        () => {
          void queryClient.invalidateQueries({ queryKey: queryKeys.messages(id) });
          void markMessagesRead(id);
        }
      )
      .subscribe();
    return () => {
      void client.removeChannel(channel);
    };
  }, [id, queryClient]);

  const send = useMutation({
    mutationFn: (text: string) => sendMessage(id, text),
    onSuccess: (message) => {
      queryClient.setQueryData<ChatMessage[]>(queryKeys.messages(id), (current) => [
        ...(current ?? []),
        message,
      ]);
      setDraft('');
      requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: true }));
    },
  });

  const conversation = useMemo<ConversationItem[]>(() => {
    const lastOutgoingId = [...messages].reverse().find((message) => message.sender === 'me')?.id;
    return messages.flatMap((message, index) => {
      const day = dayKey(message.createdAt);
      const items: ConversationItem[] = [];
      if (index === 0 || day !== dayKey(messages[index - 1]?.createdAt ?? '')) {
        items.push({ kind: 'day', id: `day-${day}`, date: message.createdAt });
      }
      items.push({
        kind: 'message',
        id: message.id,
        message,
        isLastOutgoing: message.id === lastOutgoingId,
      });
      return items;
    });
  }, [messages]);

  if (!connection) return <Screen />;

  const answered = connection.questions.length;
  const days = Math.max(
    1,
    Math.round((now - new Date(connection.createdAt).getTime()) / 86400_000)
  );

  return (
    <Screen>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={8}
      >
        <View style={styles.header}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Back to connections"
            onPress={() => router.replace('/(tabs)/connections')}
            hitSlop={12}
            style={styles.backButton}
          >
            <Text style={styles.backGlyph}>←</Text>
          </Pressable>

          <Image
            source={connection.profile.photos[0]}
            style={styles.avatar}
            contentFit="cover"
            accessibilityIgnoresInvertColors
          />

          <View style={styles.headerText}>
            <Text variant="label">{connection.profile.firstName}</Text>
            <Text variant="caption">
              Day {days} · {answered} questions answered
            </Text>
          </View>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Call ${connection.profile.firstName}`}
            onPress={() => setCallState('calling')}
            style={styles.callButton}
          >
            <Text style={styles.callGlyph}>☎</Text>
          </Pressable>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Pause this conversation"
            style={styles.pauseButton}
          >
            <Text style={styles.pauseLabel}>Pause</Text>
          </Pressable>
        </View>

        <FlatList
          ref={listRef}
          data={conversation}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.messages}
          showsVerticalScrollIndicator={false}
          onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
          renderItem={({ item }) =>
            item.kind === 'day' ? (
              <DayMarker date={item.date} />
            ) : (
              <Bubble message={item.message} isLastOutgoing={item.isLastOutgoing} />
            )
          }
        />

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.starters}
        >
          {CONVERSATION_STARTERS.map((starter) => (
            <Pressable
              key={starter}
              accessibilityRole="button"
              onPress={() => setDraft(starter)}
              style={styles.starter}
            >
              <Text style={styles.starterLabel}>{starter}</Text>
            </Pressable>
          ))}
        </ScrollView>

        <View style={styles.composer}>
          <TextInput
            accessibilityLabel="Message"
            value={draft}
            onChangeText={setDraft}
            placeholder="Write something you mean…"
            placeholderTextColor={color.whisper}
            style={styles.input}
            multiline
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Record a voice note"
            style={styles.recordButton}
          >
            <Text style={styles.recordGlyph}>●</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Send message"
            disabled={!draft.trim() || send.isPending}
            onPress={() => send.mutate(draft.trim())}
            style={[styles.sendButton, !draft.trim() && styles.sendButtonIdle]}
          >
            <Text style={styles.sendGlyph}>→</Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>

      <CallOverlay
        visible={callState !== null}
        state={callState}
        name={connection.profile.firstName}
        photo={connection.profile.photos[0]}
        onConnected={() => setCallState('connected')}
        onEnd={() => setCallState(null)}
      />
    </Screen>
  );
}

function Bubble({
  message,
  isLastOutgoing,
}: {
  message: ChatMessage;
  isLastOutgoing: boolean;
}) {
  const mine = message.sender === 'me';

  if (message.voiceUrl) {
    return (
      <View
        style={[
          styles.bubble,
          mine ? styles.bubbleMine : styles.bubbleTheirs,
          styles.voiceBubble,
        ]}
      >
        <AudioGreeting
          durationSeconds={message.voiceDurationSeconds ?? 12}
          url={message.voiceUrl}
          compact
          onDark={mine}
        />
        <MessageMeta message={message} mine={mine} isLastOutgoing={isLastOutgoing} />
      </View>
    );
  }

  return (
    <View style={[styles.bubble, mine ? styles.bubbleMine : styles.bubbleTheirs]}>
      <Text style={[styles.bubbleText, mine && styles.bubbleTextMine]}>
        {message.text}
      </Text>
      <MessageMeta message={message} mine={mine} isLastOutgoing={isLastOutgoing} />
    </View>
  );
}

function MessageMeta({
  message,
  mine,
  isLastOutgoing,
}: {
  message: ChatMessage;
  mine: boolean;
  isLastOutgoing: boolean;
}) {
  return (
    <View style={[styles.messageMeta, mine && styles.messageMetaMine]}>
      <Text style={[styles.messageTime, mine && styles.messageTimeMine]}>
        {formatTime(message.createdAt)}
      </Text>
      {mine ? (
        <Text style={[styles.tick, isLastOutgoing && message.readAt && styles.tickRead]}>
          {message.readAt ? '✓✓' : '✓'}
        </Text>
      ) : null}
    </View>
  );
}

function DayMarker({ date }: { date: string }) {
  return (
    <View style={styles.dayMarker}>
      <Text style={styles.dayMarkerLabel}>{formatDay(date)}</Text>
    </View>
  );
}

function CallOverlay({
  visible,
  state,
  name,
  photo,
  onConnected,
  onEnd,
}: {
  visible: boolean;
  state: 'calling' | 'connected' | null;
  name: string;
  photo: string | undefined;
  onConnected: () => void;
  onEnd: () => void;
}) {
  useEffect(() => {
    if (state !== 'calling') return;
    const timer = setTimeout(onConnected, 1100);
    return () => clearTimeout(timer);
  }, [onConnected, state]);

  return (
    <Modal visible={visible} animationType="fade" onRequestClose={onEnd}>
      <View style={styles.callScreen}>
        <Text variant="microAccent">Halal Mode call</Text>
        <Image source={photo} style={styles.callAvatar} contentFit="cover" />
        <Text variant="displaySmall" style={styles.callName}>
          {name}
        </Text>
        <Text variant="bodySmall" style={styles.callStatus}>
          {state === 'calling' ? 'Calling…' : 'Connected · voice only'}
        </Text>
        <View style={styles.callActions}>
          <View style={styles.callUtility}>
            <Text style={styles.callUtilityGlyph}>◉</Text>
            <Text style={styles.callUtilityLabel}>Mute</Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="End call"
            onPress={onEnd}
            style={styles.endCall}
          >
            <Text style={styles.endCallGlyph}>☎</Text>
          </Pressable>
          <View style={styles.callUtility}>
            <Text style={styles.callUtilityGlyph}>◌</Text>
            <Text style={styles.callUtilityLabel}>Speaker</Text>
          </View>
        </View>
        <Text variant="caption" center style={styles.callNote}>
          Calls are private to this connection. Live calling will connect once the calling service is enabled.
        </Text>
      </View>
    </Modal>
  );
}

function dayKey(value: string): string {
  const date = new Date(value);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(
    new Date(value)
  );
}

function formatDay(value: string): string {
  const date = new Date(value);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (dayKey(value) === dayKey(today.toISOString())) return 'Today';
  if (dayKey(value) === dayKey(yesterday.toISOString())) return 'Yesterday';
  return new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' }).format(date);
}

const styles = StyleSheet.create({
  flex: { flex: 1 },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: space.xl,
    paddingTop: 6,
    paddingBottom: 14,
    borderBottomWidth: 1,
    borderBottomColor: alpha.lineFaint,
  },
  backButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: color.sandDeep,
    borderWidth: 1,
    borderColor: alpha.line,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backGlyph: { fontFamily: font.body, fontSize: 15, color: color.inkSoft },
  avatar: { width: 34, height: 34, borderRadius: 17 },
  headerText: { flex: 1, gap: 2 },
  pauseButton: {
    borderWidth: 1,
    borderColor: alpha.lineStrong,
    borderRadius: radius.pill,
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  pauseLabel: {
    fontFamily: font.body,
    fontSize: 10,
    letterSpacing: 1.1,
    textTransform: 'uppercase',
    color: color.muted,
  },
  callButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: alpha.lineStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  callGlyph: { fontFamily: font.body, fontSize: 16, color: color.inkSoft },

  messages: { paddingHorizontal: space.xl, paddingVertical: 16, gap: 10 },
  dayMarker: { alignItems: 'center', paddingVertical: 5 },
  dayMarkerLabel: {
    borderRadius: radius.pill,
    backgroundColor: color.sand,
    paddingVertical: 5,
    paddingHorizontal: 11,
    fontFamily: font.bodyMedium,
    fontSize: 10,
    color: color.muted,
  },
  bubble: { maxWidth: '78%', paddingVertical: 13, paddingHorizontal: 15 },
  bubbleTheirs: {
    alignSelf: 'flex-start',
    backgroundColor: color.sand,
    borderRadius: 20,
    borderBottomLeftRadius: 6,
  },
  bubbleMine: {
    alignSelf: 'flex-end',
    backgroundColor: color.ink,
    borderRadius: 20,
    borderBottomRightRadius: 6,
  },
  voiceBubble: { minWidth: 210 },
  bubbleText: {
    fontFamily: font.body,
    fontSize: 12.5,
    lineHeight: 21,
    color: color.inkSoft,
  },
  bubbleTextMine: { color: color.white },
  messageMeta: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 5 },
  messageMetaMine: { justifyContent: 'flex-end' },
  messageTime: { fontFamily: font.body, fontSize: 9.5, color: color.faint },
  messageTimeMine: { color: 'rgba(252,252,251,0.58)' },
  tick: { fontFamily: font.bodyBold, fontSize: 10, letterSpacing: -2, color: 'rgba(252,252,251,0.48)' },
  tickRead: { color: color.goldOnDark },

  starters: { paddingHorizontal: space.xl, gap: 7, paddingBottom: 4 },
  starter: {
    borderWidth: 1,
    borderColor: alpha.lineStrong,
    borderRadius: radius.pill,
    paddingVertical: 8,
    paddingHorizontal: 13,
  },
  starterLabel: { fontFamily: font.body, fontSize: 11, color: color.inkSoft },

  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 10,
    paddingHorizontal: space.xl,
    paddingTop: 14,
    paddingBottom: 20,
  },
  input: {
    flex: 1,
    maxHeight: 110,
    borderWidth: 1,
    borderColor: alpha.lineStrong,
    borderRadius: radius.pill,
    paddingVertical: 13,
    paddingHorizontal: 17,
    fontFamily: font.body,
    fontSize: 12.5,
    color: color.ink,
  },
  recordButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: alpha.lineStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  recordGlyph: { fontFamily: font.body, fontSize: 15, color: color.inkSoft },
  sendButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: color.ink,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendButtonIdle: { opacity: 0.3 },
  sendGlyph: { fontFamily: font.body, fontSize: 15, color: color.white },

  callScreen: {
    flex: 1,
    alignItems: 'center',
    backgroundColor: color.ink,
    paddingTop: 86,
    paddingHorizontal: 30,
  },
  callAvatar: { width: 152, height: 152, borderRadius: 76, marginTop: 42 },
  callName: { marginTop: 25, color: color.white, fontSize: 27 },
  callStatus: { marginTop: 9, color: 'rgba(252,252,251,0.7)' },
  callActions: {
    marginTop: 'auto',
    marginBottom: 42,
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
  },
  callUtility: { alignItems: 'center', gap: 8, width: 68 },
  callUtilityGlyph: { fontFamily: font.body, fontSize: 22, color: color.white },
  callUtilityLabel: { fontFamily: font.bodyMedium, fontSize: 10, color: 'rgba(252,252,251,0.76)' },
  endCall: {
    width: 68,
    height: 68,
    borderRadius: 34,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#CB4242',
  },
  endCallGlyph: { fontFamily: font.body, fontSize: 24, color: color.white, transform: [{ rotate: '135deg' }] },
  callNote: { position: 'absolute', bottom: 15, left: 40, right: 40, color: 'rgba(252,252,251,0.44)' },
});

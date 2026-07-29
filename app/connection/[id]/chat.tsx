import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
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
  closeConnection,
  fetchConnection,
  fetchMessagesPage,
  markMessagesRead,
  messageFromRow,
  sendMessage,
} from '@/api/connections';
import { AudioGreeting } from '@/components/introductions/AudioGreeting';
import { SafetyControl } from '@/components/safety/SafetyControl';
import { ErrorState, LoadingState } from '@/components/ui/AsyncState';
import { Screen } from '@/components/ui/Screen';
import { Text } from '@/components/ui/Text';
import { useI18n } from '@/i18n';
import { queryKeys } from '@/lib/queryClient';
import { trackProductEvent } from '@/lib/analytics';
import { enqueueMessage, getPendingMessages, removePendingMessage } from '@/lib/messageOutbox';
import { retryAllInOrder } from '@/lib/retryPolicy';
import { supabase, USE_MOCKS } from '@/lib/supabase';
import { testIds } from '@/lib/testIds';
import { useAuth } from '@/state/auth';
import { useFeatureFlags } from '@/state/featureFlags';
import { alpha, color, font, radius, space } from '@/theme/tokens';
import type { ChatMessage } from '@/types';
import type { MessagePage } from '@/api/connections';

type ConversationItem =
  | { kind: 'day'; id: string; date: string }
  | { kind: 'message'; id: string; message: ChatMessage; isLastOutgoing: boolean };

export default function ChatScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { isRTL, t } = useI18n();
  const { user } = useAuth();
  const { inChatVoiceNotes, liveCalling } = useFeatureFlags();
  const queryClient = useQueryClient();
  const listRef = useRef<FlatList<ConversationItem>>(null);
  const shouldScrollToEndRef = useRef(true);
  const [draft, setDraft] = useState('');
  const [callState, setCallState] = useState<
    'calling' | 'connected' | 'unavailable' | null
  >(null);
  const [now, setNow] = useState(0);
  const [pendingCount, setPendingCount] = useState(0);
  const [retryFailed, setRetryFailed] = useState(false);
  const outboxMemberId = USE_MOCKS ? 'mock' : user?.id;

  const refreshPendingCount = useCallback(async () => {
    if (!outboxMemberId) {
      setPendingCount(0);
      return;
    }
    setPendingCount((await getPendingMessages(outboxMemberId, id)).length);
  }, [id, outboxMemberId]);

  const connectionQuery = useQuery({
    queryKey: queryKeys.connection(id),
    queryFn: () => fetchConnection(id),
  });

  const messagesQuery = useQuery({
    queryKey: queryKeys.messages(id),
    queryFn: () => fetchMessagesPage(id),
    // Conversation is the one place freshness matters.
    staleTime: 0,
  });
  const connection = connectionQuery.data;
  const messages = useMemo(
    () => messagesQuery.data?.messages ?? [],
    [messagesQuery.data]
  );

  useEffect(() => {
    void markMessagesRead(id).then(() => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.messages(id) });
    });
  }, [id, queryClient]);

  useEffect(() => setNow(Date.now()), []);
  useEffect(() => { void refreshPendingCount(); }, [refreshPendingCount]);

  useEffect(() => {
    if (USE_MOCKS || !supabase) return;
    const client = supabase;
    const channel = client
      .channel(`messages:${id}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'messages', filter: `connection_id=eq.${id}` },
        (payload) => {
          void client.auth.getUser().then(({ data, error: authError }) => {
            if (authError || !data.user) return;
            queryClient.setQueryData<MessagePage>(queryKeys.messages(id), (current) => {
              if (!current) return current;
              if (payload.eventType === 'DELETE') {
                return { ...current, messages: current.messages.filter((item) => item.id !== String(payload.old.id)) };
              }

              // Realtime DELETE payloads intentionally have no `new` record.
              // Parsing one first creates a transient empty message in the cache.
              const message = messageFromRow(
                payload.new as Record<string, unknown>,
                data.user.id
              );
              const exists = current.messages.some((item) => item.id === message.id);
              const messages = exists
                ? current.messages.map((item) => item.id === message.id ? message : item)
                : [...current.messages, message].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
              return { ...current, messages };
            });
            if (payload.eventType === 'INSERT') {
              const message = messageFromRow(
                payload.new as Record<string, unknown>,
                data.user.id
              );
              if (message.sender === 'them') void markMessagesRead(id);
            }
          });
        }
      )
      .subscribe();
    return () => {
      void client.removeChannel(channel);
    };
  }, [id, queryClient]);

  const send = useMutation({
    mutationFn: async (text: string) => {
      if (!outboxMemberId) throw new Error('Your session is not ready to send a message.');
      const pending = await enqueueMessage(outboxMemberId, id, text);
      setDraft('');
      try {
        const message = await sendMessage(id, text, pending.id);
        // Delivery is already durable server-side. A local cleanup failure must
        // not turn it into a false send error; the idempotency key makes a later
        // cleanup retry safe.
        void removePendingMessage(outboxMemberId, pending.id).catch(() => {});
        return message;
      } finally {
        void refreshPendingCount();
      }
    },
    onSuccess: (message) => {
      trackProductEvent('message_sent');
      shouldScrollToEndRef.current = true;
      queryClient.setQueryData<MessagePage>(queryKeys.messages(id), (current) => ({
        messages: [...(current?.messages ?? []), message],
        hasMore: current?.hasMore ?? false,
        ...(current?.nextCursor ? { nextCursor: current.nextCursor } : {}),
      }));
      requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: true }));
    },
  });

  const loadEarlier = useMutation({
    mutationFn: () => {
      const cursor = messagesQuery.data?.nextCursor;
      if (!cursor) throw new Error('No earlier messages are available.');
      return fetchMessagesPage(id, cursor);
    },
    onMutate: () => { shouldScrollToEndRef.current = false; },
    onSuccess: (page) => {
      queryClient.setQueryData<MessagePage>(queryKeys.messages(id), (current) => ({
        messages: [...page.messages, ...(current?.messages ?? [])],
        hasMore: page.hasMore,
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      }));
    },
  });

  const retryPending = useMutation({
    mutationFn: async () => {
      if (!outboxMemberId) throw new Error('Your session is not ready to send a message.');
      const pending = await getPendingMessages(outboxMemberId, id);
      return retryAllInOrder(pending, async (item) => {
        const message = await sendMessage(id, item.body, item.id);
        void removePendingMessage(outboxMemberId, item.id).catch(() => {});
        return message;
      });
    },
    onMutate: () => setRetryFailed(false),
    onSuccess: ({ delivered, failedCount }) => {
      queryClient.setQueryData<MessagePage>(queryKeys.messages(id), (current) => ({
        messages: [...(current?.messages ?? []), ...delivered]
          .filter((message, index, all) => all.findIndex((item) => item.id === message.id) === index)
          .sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
        hasMore: current?.hasMore ?? false,
        ...(current?.nextCursor ? { nextCursor: current.nextCursor } : {}),
      }));
      setRetryFailed(failedCount > 0);
    },
    onError: () => setRetryFailed(true),
    onSettled: () => { void refreshPendingCount(); },
  });

  const close = useMutation({
    mutationFn: () => closeConnection(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.connections });
      router.replace('/(tabs)/connections');
    },
    onError: () => {
      Alert.alert(
        t('chat.closeErrorTitle'),
        t('chat.closeErrorBody')
      );
    },
  });

  const confirmClose = () => {
    Alert.alert(
      t('chat.closeTitle'),
      t('chat.closeBody', { name: connection?.profile.firstName ?? '' }),
      [
        { text: t('chat.keep'), style: 'cancel' },
        {
          text: t('chat.closeConfirm'),
          style: 'destructive',
          onPress: () => close.mutate(),
        },
      ]
    );
  };

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

  if (connectionQuery.isPending || messagesQuery.isPending) {
    return (
      <Screen>
        <LoadingState label={t('chat.loading')} />
      </Screen>
    );
  }

  if (
    connectionQuery.isError ||
    messagesQuery.isError ||
    !connection
  ) {
    return (
      <Screen>
        <ErrorState
          title={t('chat.errorTitle')}
          message={t('chat.errorBody')}
          onRetry={() => {
            void connectionQuery.refetch();
            void messagesQuery.refetch();
          }}
        />
      </Screen>
    );
  }

  const answered = connection.questions.length;
  const days = Math.max(
    1,
    Math.round((now - new Date(connection.createdAt).getTime()) / 86400_000)
  );

  return (
    <Screen style={isRTL ? styles.rtl : undefined}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={8}
      >
        <View style={[styles.header, isRTL && styles.rowRTL]}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('chat.backA11y')}
            onPress={() => router.replace('/(tabs)/connections')}
            hitSlop={12}
            style={styles.backButton}
          >
            <Text style={styles.backGlyph}>{isRTL ? '→' : '←'}</Text>
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
              {t('chat.headerMeta', { days, count: answered })}
            </Text>
          </View>

          {liveCalling ? (
          <Pressable
            testID={testIds.chat.call}
            accessibilityRole="button"
            accessibilityLabel={t('chat.callA11y', { name: connection.profile.firstName })}
            onPress={() => setCallState('calling')}
            style={styles.callButton}
          >
            <Text style={styles.callGlyph}>☎</Text>
          </Pressable>
          ) : null}

          <SafetyControl
            scope={{ kind: 'connection', id }}
            memberName={connection.profile.firstName}
          />

          <Pressable
            testID={testIds.chat.retry}
            accessibilityRole="button"
            accessibilityLabel={t('chat.closeA11y')}
            accessibilityState={{ busy: close.isPending }}
            disabled={close.isPending}
            onPress={confirmClose}
            style={styles.pauseButton}
          >
            <Text style={styles.pauseLabel}>{t('chat.pause')}</Text>
          </Pressable>
        </View>

        <FlatList
          ref={listRef}
          data={conversation}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.messages}
          showsVerticalScrollIndicator={false}
          onContentSizeChange={() => {
            if (!shouldScrollToEndRef.current) return;
            listRef.current?.scrollToEnd({ animated: false });
          }}
          onScroll={(event) => {
            const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
            // Keep a conversation anchored only while the member is already
            // reading its newest messages; never pull them away from history.
            shouldScrollToEndRef.current =
              contentSize.height - contentOffset.y - layoutMeasurement.height < 64;
          }}
          scrollEventThrottle={32}
          ListHeaderComponent={
            messagesQuery.data?.hasMore ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('chat.loadEarlier')}
                accessibilityState={{ busy: loadEarlier.isPending }}
                disabled={loadEarlier.isPending}
                onPress={() => loadEarlier.mutate()}
                style={styles.loadEarlier}
              >
                <Text variant="caption" style={styles.loadEarlierLabel}>
                  {loadEarlier.isPending ? t('common.loading') : t('chat.loadEarlier')}
                </Text>
              </Pressable>
            ) : null
          }
          renderItem={({ item }) =>
            item.kind === 'day' ? (
              <DayMarker date={item.date} />
            ) : (
              <Bubble message={item.message} isLastOutgoing={item.isLastOutgoing} />
            )
          }
        />

        {pendingCount > 0 ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('chat.retryPending', { count: pendingCount })}
            accessibilityState={{ busy: retryPending.isPending }}
            disabled={retryPending.isPending}
            onPress={() => retryPending.mutate()}
            style={styles.pendingNotice}
          >
            <Text variant="caption" style={styles.pendingNoticeText}>
              {t('chat.pendingMessages', { count: pendingCount })}
            </Text>
            <Text variant="caption" style={styles.pendingRetryText}>
              {retryPending.isPending ? t('common.loading') : t('chat.retryPending', { count: pendingCount })}
            </Text>
          </Pressable>
        ) : null}
        {retryFailed ? (
          <Text accessibilityRole="alert" variant="caption" style={styles.sendError}>
            {t('chat.retrySomeFailed')}
          </Text>
        ) : null}

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.starters}
        >
          {(['chat.starter.relocation', 'chat.starter.family', 'chat.starter.call'] as const).map((key) => {
            const starter = t(key);
            return (
            <Pressable
              key={key}
              accessibilityRole="button"
              onPress={() => setDraft(starter)}
              style={styles.starter}
            >
              <Text style={styles.starterLabel}>{starter}</Text>
            </Pressable>
          );})}
        </ScrollView>

        <View style={styles.composer}>
          <TextInput
            testID={testIds.chat.composer}
            accessibilityLabel={t('chat.messageA11y')}
            value={draft}
            onChangeText={setDraft}
            placeholder={t('chat.placeholder')}
            placeholderTextColor={color.whisper}
            style={styles.input}
            multiline
            maxLength={2000}
          />
          {inChatVoiceNotes ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('chat.recordUnavailable')}
            onPress={() =>
              Alert.alert(
                t('chat.voiceTitle'),
                t('chat.voiceBody')
              )
            }
            style={styles.recordButton}
          >
            <Text style={styles.recordGlyph}>●</Text>
          </Pressable>
          ) : null}
          <Pressable
            testID={testIds.chat.send}
            accessibilityRole="button"
            accessibilityLabel={t('chat.sendA11y')}
            disabled={!draft.trim() || send.isPending}
            onPress={() => send.mutate(draft.trim())}
            style={[styles.sendButton, !draft.trim() && styles.sendButtonIdle]}
          >
            <Text style={styles.sendGlyph}>→</Text>
          </Pressable>
        </View>
        {send.isError ? (
          <Text accessibilityRole="alert" variant="caption" style={styles.sendError}>
            {t('chat.sendError')}
          </Text>
        ) : null}
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
  const { localeTag } = useI18n();
  return (
    <View style={[styles.messageMeta, mine && styles.messageMetaMine]}>
      <Text style={[styles.messageTime, mine && styles.messageTimeMine]}>
        {formatTime(message.createdAt, localeTag)}
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
  const { localeTag, t } = useI18n();
  return (
    <View style={styles.dayMarker}>
      <Text style={styles.dayMarkerLabel}>{formatDay(date, localeTag, t('chat.today'), t('chat.yesterday'))}</Text>
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
  state: 'calling' | 'connected' | 'unavailable' | null;
  name: string;
  photo: string | undefined;
  onConnected: () => void;
  onEnd: () => void;
}) {
  const { isRTL, t } = useI18n();
  const [muted, setMuted] = useState(false);
  const [speakerOn, setSpeakerOn] = useState(false);
  useEffect(() => {
    if (state !== 'calling') return;
    const timer = setTimeout(onConnected, 1100);
    return () => clearTimeout(timer);
  }, [onConnected, state]);
  useEffect(() => {
    if (visible) return;
    setMuted(false);
    setSpeakerOn(false);
  }, [visible]);

  return (
    <Modal
      visible={visible}
      animationType="fade"
      onRequestClose={onEnd}
      accessibilityViewIsModal
    >
      <View style={[styles.callScreen, isRTL && styles.rtl]} accessibilityViewIsModal>
        <Text variant="microAccent">
          {state === 'unavailable' ? t('chat.call.private') : t('chat.call.preview')}
        </Text>
        <Image
          source={photo}
          style={styles.callAvatar}
          contentFit="cover"
          accessibilityLabel={name}
        />
        <Text variant="displaySmall" style={styles.callName}>
          {name}
        </Text>
        <Text variant="bodySmall" style={styles.callStatus} accessibilityRole="alert">
          {state === 'unavailable'
            ? t('chat.call.unavailable')
            : state === 'calling'
              ? t('chat.call.calling')
              : t('chat.call.connected')}
        </Text>
        {state === 'unavailable' ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('chat.call.back')}
            onPress={onEnd}
            style={styles.callUnavailableAction}
          >
            <Text style={styles.callUnavailableLabel}>{t('chat.call.back')}</Text>
          </Pressable>
        ) : (
          <View style={[styles.callActions, isRTL && styles.rowRTL]}>
            <Pressable
              accessibilityRole="switch"
              accessibilityLabel={t('chat.call.mute')}
              accessibilityState={{ checked: muted }}
              onPress={() => setMuted((current) => !current)}
              style={[styles.callUtility, muted && styles.callUtilityActive]}
            >
              <Text style={styles.callUtilityGlyph}>◉</Text>
              <Text style={styles.callUtilityLabel}>{t('chat.call.mute')}</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('chat.call.endA11y')}
              onPress={onEnd}
              style={styles.endCall}
            >
              <Text style={styles.endCallGlyph}>☎</Text>
            </Pressable>
            <Pressable
              accessibilityRole="switch"
              accessibilityLabel={t('chat.call.speaker')}
              accessibilityState={{ checked: speakerOn }}
              onPress={() => setSpeakerOn((current) => !current)}
              style={[styles.callUtility, speakerOn && styles.callUtilityActive]}
            >
              <Text style={styles.callUtilityGlyph}>◌</Text>
              <Text style={styles.callUtilityLabel}>{t('chat.call.speaker')}</Text>
            </Pressable>
          </View>
        )}
        <Text variant="caption" center style={styles.callNote}>
          {state === 'unavailable'
            ? t('chat.call.unavailableNote')
            : t('chat.call.previewNote')}
        </Text>
      </View>
    </Modal>
  );
}

function dayKey(value: string): string {
  const date = new Date(value);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function formatTime(value: string, localeTag: string): string {
  return new Intl.DateTimeFormat(localeTag, { hour: 'numeric', minute: '2-digit' }).format(
    new Date(value)
  );
}

function formatDay(value: string, localeTag: string, todayLabel: string, yesterdayLabel: string): string {
  const date = new Date(value);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (dayKey(value) === dayKey(today.toISOString())) return todayLabel;
  if (dayKey(value) === dayKey(yesterday.toISOString())) return yesterdayLabel;
  return new Intl.DateTimeFormat(localeTag, { day: 'numeric', month: 'short' }).format(date);
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  rtl: { direction: 'rtl' },
  rowRTL: { flexDirection: 'row-reverse' },

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
    width: 44,
    height: 44,
    borderRadius: 22,
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
    minHeight: 44,
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
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: alpha.lineStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  callGlyph: { fontFamily: font.body, fontSize: 16, color: color.inkSoft },
  messages: { paddingHorizontal: space.xl, paddingVertical: 16, gap: 10 },
  loadEarlier: { alignSelf: 'center', paddingHorizontal: space.md, paddingVertical: space.sm },
  loadEarlierLabel: { color: color.ink, textDecorationLine: 'underline' },
  pendingNotice: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.sm, marginHorizontal: space.xl, marginBottom: space.xs, padding: space.sm, borderRadius: radius.md, backgroundColor: color.sand },
  pendingNoticeText: { flex: 1, color: color.inkSoft },
  pendingRetryText: { color: color.ink, textDecorationLine: 'underline' },
  dayMarker: { alignItems: 'center', paddingVertical: 5 },
  dayMarkerLabel: {
    borderRadius: radius.pill,
    backgroundColor: color.sand,
    paddingVertical: 5,
    paddingHorizontal: 11,
    fontFamily: font.bodyMedium,
    fontSize: 12,
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
    fontSize: 15,
    lineHeight: 21,
    color: color.inkSoft,
  },
  bubbleTextMine: { color: color.white },
  messageMeta: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 5 },
  messageMetaMine: { justifyContent: 'flex-end' },
  messageTime: { fontFamily: font.body, fontSize: 11, color: color.faint },
  messageTimeMine: { color: 'rgba(252,252,251,0.58)' },
  tick: { fontFamily: font.bodyBold, fontSize: 12, letterSpacing: -2, color: 'rgba(252,252,251,0.48)' },
  tickRead: { color: color.goldOnDark },

  starters: { paddingHorizontal: space.xl, gap: 7, paddingBottom: 4 },
  starter: {
    minHeight: 44,
    borderWidth: 1,
    borderColor: alpha.lineStrong,
    borderRadius: radius.pill,
    paddingVertical: 10,
    paddingHorizontal: 13,
  },
  starterLabel: { fontFamily: font.body, fontSize: 13, color: color.inkSoft },

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
    fontSize: 15,
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
  controlDisabled: { opacity: 0.35 },
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
  sendError: {
    paddingHorizontal: space.xl,
    paddingBottom: 8,
    textAlign: 'center',
    color: color.inkSoft,
  },

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
  callUnavailableAction: {
    marginTop: 36,
    minHeight: 48,
    borderRadius: radius.pill,
    backgroundColor: color.white,
    paddingVertical: 14,
    paddingHorizontal: 24,
    justifyContent: 'center',
  },
  callUnavailableLabel: {
    color: color.ink,
    fontFamily: font.bodyBold,
    fontSize: 12,
  },
  callUtility: { alignItems: 'center', justifyContent: 'center', gap: 8, width: 68, minHeight: 68, borderRadius: 34 },
  callUtilityActive: { backgroundColor: 'rgba(252,252,251,0.14)' },
  callUtilityGlyph: { fontFamily: font.body, fontSize: 22, color: color.white },
  callUtilityLabel: { fontFamily: font.bodyMedium, fontSize: 12, color: 'rgba(252,252,251,0.76)' },
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

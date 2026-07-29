import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Text } from '@/components/ui/Text';
import { useI18n } from '@/i18n';
import {
  galleryImagePerformancePolicy,
  galleryListPerformancePolicy,
  galleryRetryKey,
} from '@/lib/galleryPerformancePolicy';
import { getGalleryState, safeGalleryIndex } from '@/lib/galleryState';
import { testIds } from '@/lib/testIds';
import { useRound } from '@/state/round';
import { color, font, radius } from '@/theme/tokens';

export default function GalleryScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { localeTag, isRTL, t } = useI18n();
  const insets = useSafeAreaInsets();
  const { round, refresh } = useRound();
  const listRef = useRef<FlatList<string>>(null);
  const [index, setIndex] = useState(0);
  const { width } = useWindowDimensions();
  const introduction = round?.introductions.find((item) => item.id === id);
  const photos = introduction?.profile.photos ?? [];
  const galleryState = getGalleryState(!!introduction, photos.length);
  const safeIndex = safeGalleryIndex(index, photos.length);
  const number = (value: number) => new Intl.NumberFormat(localeTag).format(value);

  useEffect(() => {
    if (safeIndex !== index) setIndex(safeIndex);
  }, [index, safeIndex]);

  const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    setIndex(safeGalleryIndex(Math.round(event.nativeEvent.contentOffset.x / width), photos.length));
  };

  const goTo = useCallback((next: number) => {
    listRef.current?.scrollToIndex({ index: next, animated: true });
    setIndex(next);
  }, []);

  if (!introduction || galleryState !== 'ready') {
    return (
      <GalleryRecovery
        title={galleryState === 'unavailable' ? t('gallery.unavailableTitle') : t('gallery.emptyTitle')}
        message={galleryState === 'unavailable' ? t('gallery.unavailableBody') : t('gallery.emptyBody')}
        onClose={() => router.back()}
        onRetry={galleryState === 'unavailable' ? () => refresh() : undefined}
      />
    );
  }

  return (
    <View style={[styles.backdrop, { paddingTop: insets.top }]}>
      <View style={[styles.header, isRTL && styles.rowRTL]}>
        <Pressable
          testID={testIds.gallery.close}
          accessibilityRole="button"
          accessibilityLabel={t('gallery.close')}
          onPress={() => router.back()}
          style={styles.close}
          hitSlop={12}
        >
          <Text style={styles.closeGlyph}>✕</Text>
        </Pressable>
        <Text style={styles.title} numberOfLines={1}>
          {t('gallery.title', { name: introduction.profile.firstName })}
        </Text>
        <View style={styles.counter}>
          <Text style={styles.counterLabel}>
            {number(safeIndex + 1)} / {number(photos.length)}
          </Text>
        </View>
      </View>

      <FlatList
        key={`gallery-${width}`}
        ref={listRef}
        data={photos}
        keyExtractor={(item) => item}
        horizontal
        pagingEnabled
        initialScrollIndex={safeIndex}
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={onScroll}
        getItemLayout={(_, i) => ({ length: width, offset: width * i, index: i })}
        {...galleryListPerformancePolicy}
        renderItem={({ item, index: photoIndex }) => (
          <GallerySlide photo={item} index={photoIndex} width={width} />
        )}
      />

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={[styles.thumbs, { paddingBottom: insets.bottom + 20 }]}
      >
        {photos.map((photo, thumbIndex) => (
          <Pressable
            key={photo}
            accessibilityRole="button"
            accessibilityLabel={t('gallery.photoA11y', { count: number(thumbIndex + 1) })}
            onPress={() => goTo(thumbIndex)}
            style={[styles.thumb, thumbIndex === safeIndex && styles.thumbActive]}
          >
            <Image
              source={photo}
              style={StyleSheet.absoluteFill}
              contentFit="cover"
              accessibilityIgnoresInvertColors
            />
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

function GalleryRecovery({
  title,
  message,
  onClose,
  onRetry,
}: {
  title: string;
  message: string;
  onClose: () => void;
  onRetry?: () => void;
}) {
  const { t } = useI18n();
  return (
    <View testID={testIds.gallery.recovery} style={styles.backdrop}>
      <View accessibilityRole="alert" style={styles.recovery}>
        <Text variant="displaySmall" center style={styles.recoveryTitle}>{title}</Text>
        <Text variant="bodySmall" center style={styles.recoveryBody}>{message}</Text>
        {onRetry ? (
          <Pressable accessibilityRole="button" accessibilityLabel={t('common.tryAgain')} onPress={onRetry} style={styles.recoveryPrimary}>
            <Text style={styles.recoveryPrimaryLabel}>{t('common.tryAgain')}</Text>
          </Pressable>
        ) : null}
        <Pressable testID={testIds.gallery.close} accessibilityRole="button" accessibilityLabel={t('gallery.close')} onPress={onClose} style={styles.recoveryClose}>
          <Text style={styles.recoveryCloseLabel}>{t('common.close')}</Text>
        </Pressable>
      </View>
    </View>
  );
}

function GallerySlide({ photo, index, width }: { photo: string; index: number; width: number }) {
  const { t } = useI18n();
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);

  return (
    <View style={[styles.slide, { width }]}>
      <Image
        key={galleryRetryKey(photo, attempt)}
        testID={`gallery-photo-${index + 1}`}
        source={photo}
        style={styles.photo}
        contentFit="cover"
        transition={200}
        {...galleryImagePerformancePolicy}
        accessibilityIgnoresInvertColors
        onError={() => setFailed(true)}
      />
      {failed ? (
        <View style={styles.errorOverlay} accessibilityRole="alert">
          <Text variant="bodySmall" center style={styles.errorText}>{t('gallery.photoUnavailable')}</Text>
          <Pressable
            testID={`gallery-photo-${index + 1}-retry`}
            accessibilityRole="button"
            accessibilityLabel={t('gallery.retry')}
            onPress={() => {
              setFailed(false);
              setAttempt((current) => current + 1);
            }}
            style={styles.retry}
          >
            <Text style={styles.retryLabel}>{t('gallery.retry')}</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(14,13,12,0.96)' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  rowRTL: { flexDirection: 'row-reverse' },
  title: { flex: 1, fontFamily: font.bodySemi, fontSize: 13, color: color.white },
  counter: {
    backgroundColor: 'rgba(252,252,251,0.1)',
    borderRadius: radius.sm,
    paddingVertical: 3,
    paddingHorizontal: 7,
  },
  counterLabel: {
    fontFamily: font.body,
    fontSize: 12,
    color: 'rgba(252,252,251,0.62)',
  },
  close: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: 'rgba(252,252,251,0.16)',
    backgroundColor: 'rgba(252,252,251,0.06)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeGlyph: { fontFamily: font.body, fontSize: 15, color: color.white },

  slide: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 14 },
  photo: {
    width: '100%',
    aspectRatio: 3 / 4,
    borderRadius: radius.md,
  },
  errorOverlay: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 14,
    borderRadius: radius.md,
    backgroundColor: 'rgba(14,13,12,0.82)',
  },
  errorText: { color: color.white, maxWidth: 190 },
  retry: {
    minHeight: 44,
    minWidth: 108,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.pill,
    backgroundColor: color.white,
    paddingHorizontal: 16,
  },
  retryLabel: { color: color.ink, fontFamily: font.bodyBold, fontSize: 11 },

  thumbs: {
    alignItems: 'center',
    gap: 8,
    paddingTop: 10,
    paddingHorizontal: 16,
  },
  thumb: {
    width: 44,
    height: 56,
    borderRadius: 8,
    overflow: 'hidden',
    opacity: 0.45,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  thumbActive: { opacity: 1, borderColor: color.goldOnDark },
  recovery: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 14, paddingHorizontal: 32 },
  recoveryTitle: { color: color.white },
  recoveryBody: { color: 'rgba(252,252,251,0.72)', maxWidth: 300 },
  recoveryPrimary: { minHeight: 48, minWidth: 152, alignItems: 'center', justifyContent: 'center', borderRadius: radius.pill, backgroundColor: color.white, paddingHorizontal: 22 },
  recoveryPrimaryLabel: { color: color.ink, fontFamily: font.bodyBold, fontSize: 11 },
  recoveryClose: { minHeight: 44, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },
  recoveryCloseLabel: { color: color.white, fontFamily: font.bodySemi, fontSize: 12 },
});

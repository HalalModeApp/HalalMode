import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import {
  Dimensions,
  FlatList,
  Pressable,
  StyleSheet,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Text } from '@/components/ui/Text';
import { useI18n } from '@/i18n';
import { galleryImagePerformancePolicy, galleryListPerformancePolicy } from '@/lib/galleryPerformancePolicy';
import { useRound } from '@/state/round';
import { color, font, radius } from '@/theme/tokens';

export default function GalleryScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { localeTag, isRTL, t } = useI18n();
  const insets = useSafeAreaInsets();
  const { round } = useRound();
  const listRef = useRef<FlatList<string>>(null);
  const [index, setIndex] = useState(0);

  const width = Dimensions.get('window').width;
  const introduction = round?.introductions.find((item) => item.id === id);
  const photos = introduction?.profile.photos ?? [];
  const number = (value: number) => new Intl.NumberFormat(localeTag).format(value);

  const onScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      setIndex(Math.round(event.nativeEvent.contentOffset.x / width));
    },
    [width]
  );

  const goTo = useCallback((next: number) => {
    listRef.current?.scrollToIndex({ index: next, animated: true });
    setIndex(next);
  }, []);

  if (!introduction) return null;

  return (
    <View style={[styles.backdrop, { paddingTop: insets.top }]}>
      <View style={[styles.header, isRTL && styles.rowRTL]}>
        <Pressable
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
            {number(index + 1)} / {number(photos.length)}
          </Text>
        </View>
      </View>

      <FlatList
        ref={listRef}
        data={photos}
        keyExtractor={(item) => item}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={onScroll}
        getItemLayout={(_, i) => ({ length: width, offset: width * i, index: i })}
        {...galleryListPerformancePolicy}
        renderItem={({ item }) => (
          <View style={[styles.slide, { width }]}>
            <Image
              source={item}
              style={styles.photo}
              contentFit="cover"
              transition={200}
              {...galleryImagePerformancePolicy}
              accessibilityIgnoresInvertColors
            />
          </View>
        )}
      />

      <View style={[styles.thumbs, { paddingBottom: insets.bottom + 20 }]}>
        {photos.map((photo, thumbIndex) => (
          <Pressable
            key={photo}
            accessibilityRole="button"
            accessibilityLabel={t('gallery.photoA11y', { count: number(thumbIndex + 1) })}
            onPress={() => goTo(thumbIndex)}
            style={[styles.thumb, thumbIndex === index && styles.thumbActive]}
          >
            <Image
              source={photo}
              style={StyleSheet.absoluteFill}
              contentFit="cover"
              accessibilityIgnoresInvertColors
            />
          </Pressable>
        ))}
      </View>
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

  thumbs: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 8,
    paddingTop: 10,
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
});

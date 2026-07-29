const DELTA_PSI = 0.3;
const Y_CAP = 16;
const ARC_BUTTON = 52;
const ARC_STEP = 72;
const AVAILABLE_WIDTH = 330;
const ARC_MAX = 5;

export interface ArcItem {
  id: string;
}

export interface ArcSlot<T extends ArcItem> {
  introduction: T;
  x: number;
  y: number;
  angle: number;
  scale: number;
  opacity: number;
  zIndex: number;
  isActive: boolean;
  size: number;
}

export interface ArcLayout<T extends ArcItem> {
  slots: ArcSlot<T>[];
  isGrid: boolean;
  stripHeight: number;
}

/** Platform-free carousel geometry shared by the native UI and regression tests. */
export function computeArcLayout<T extends ArcItem>(
  live: readonly T[],
  activeId: string
): ArcLayout<T> {
  if (live.length === 0) {
    return { slots: [], isGrid: false, stripHeight: 86 };
  }

  const count = live.length;
  const isGrid = count > ARC_MAX;
  const perRow = isGrid ? Math.ceil(count / 2) : count;
  const step = isGrid ? Math.min(ARC_STEP, AVAILABLE_WIDTH / perRow) : ARC_STEP;
  const size = isGrid
    ? Math.max(34, Math.min(ARC_BUTTON, step * 0.72))
    : ARC_BUTTON;
  const radiusOfArc = step / (2 * Math.sin(DELTA_PSI / 2));
  const foundActiveIndex = live.findIndex((item) => item.id === activeId);
  const activeIndex = foundActiveIndex >= 0 ? foundActiveIndex : 0;

  const slots = live.map((introduction, index): ArcSlot<T> => {
    // A stale id can exist for one render after a release. Falling back here
    // prevents a frame where no face is active while React state catches up.
    const isActive = index === activeIndex;

    if (isGrid) {
      const row = Math.floor(index / perRow);
      const col = index % perRow;
      const rowCount = Math.min(perRow, count - row * perRow);
      const rows = Math.ceil(count / perRow);
      return {
        introduction,
        x: (col - (rowCount - 1) / 2) * step,
        y: row * step - ((rows - 1) * step) / 2,
        angle: 0,
        scale: 1,
        opacity: 1,
        zIndex: isActive ? 100 : 1,
        isActive,
        size,
      };
    }

    let slot = ((index - activeIndex) % count + count) % count;
    if (slot > count / 2) slot -= count;

    const angle = slot * DELTA_PSI;
    const distance = Math.abs(slot);
    const depth = Math.max(0, 1 - (0.5 * distance) / 2.4);
    const arcY = Math.min(radiusOfArc * (1 - Math.cos(angle)), Y_CAP);

    return {
      introduction,
      x: radiusOfArc * Math.sin(angle),
      y: distance === 1 ? Math.max(4, arcY - 5) : arcY,
      angle,
      scale: 0.62 + 0.38 * depth,
      opacity: distance <= 2 ? 1 : Math.max(0, 1 - (distance - 2)),
      zIndex: Math.round(depth * 100) + (isActive ? 100 : 0),
      isActive,
      size,
    };
  });

  return {
    slots,
    isGrid,
    stripHeight: isGrid ? size * 2 + 46 : 86,
  };
}

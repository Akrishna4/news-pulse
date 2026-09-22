'use client';

import { useMemo, useState, useRef, useCallback } from 'react';
import { TimelineCluster } from '../lib/mockData';

interface TimelineProps {
  clusters: TimelineCluster[];
  range: { earliest: string; latest: string } | null; // only used to know latest; scale computed from cluster data
  onClusterClick: (clusterId: number) => void;
  selectedClusterId: number | null;
}

interface PlacedCluster extends TimelineCluster {
  lane: number;
  startX: number;  // 0–100 percentage within effective scale
  endX: number;
  isSingleton: boolean;
  isOutlier: boolean; // clamped to x=0, flagged for visual treatment
}

interface TooltipState {
  x: number;  // px from left of container
  y: number;  // px from top of container
  cluster: PlacedCluster;
}

// N=14 days: wide enough to include legitimate articles from a two-week rolling
// news window, narrow enough to exclude evergreen/republished entries from a
// different month or year.  The median is used rather than the mean so that a
// large cluster of recent articles anchors the reference point regardless of
// how many or how far-apart the outliers are.
const OUTLIER_DEVIATION_MS = 14 * 24 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Compute the effective x-scale from actual cluster startTimes.
 *
 * Algorithm:
 *   1. Sort all non-null startTimes.
 *   2. Compute the median startTime (middle of sorted array).
 *   3. Any startTime that differs from the median by > 14 days is an outlier:
 *      excluded from the scale domain, but still rendered clamped at x=0% (amber).
 *   4. scaleFrom = min of non-outlier startTimes; scaleTo = max of all startTimes.
 *
 * Why median, not boundary gap?
 *   A boundary gap check (sorted[1] - sorted[0]) only catches the first outlier
 *   at the bottom of the list.  If two or three old articles existed, it would
 *   stop at the first gap and leave the rest distorting the scale.
 *   The median is resistant to any number of outliers: as long as more than half
 *   the clusters are from the recent news cycle, the median is anchored there,
 *   and ALL old entries — however many — are excluded from the scale.
 *
 * Note: /timeline's `range` field (API response) is intentionally NOT used here.
 * The API still returns it for future consumers (analytics, alternative clients).
 * The frontend derives its own outlier-aware scale from the cluster startTime
 * distribution so a single stale RSS entry cannot distort the visual axis.
 */
function computeDataScale(clusters: TimelineCluster[]): {
  scaleFrom: number;
  scaleTo: number;
  outlierThreshold: number; // startTimes < this value are scale-excluded outliers
} | null {
  const starts = clusters
    .map(c => c.startTime ? new Date(c.startTime).getTime() : null)
    .filter((t): t is number => t !== null)
    .sort((a, b) => a - b);

  if (starts.length === 0) return null;

  const scaleTo = starts[starts.length - 1];

  if (starts.length === 1) {
    return { scaleFrom: starts[0], scaleTo, outlierThreshold: -Infinity };
  }

  // Median: lower-middle element of sorted array
  const medianMs = starts[Math.floor((starts.length - 1) / 2)];

  // Non-outliers: within 14 days of the median
  const nonOutliers = starts.filter(t => Math.abs(t - medianMs) <= OUTLIER_DEVIATION_MS);

  if (nonOutliers.length === 0) {
    // Degenerate edge case: all points equidistant — use full range
    return { scaleFrom: starts[0], scaleTo, outlierThreshold: -Infinity };
  }

  // Snap scale boundaries to full calendar days to avoid arbitrary sub-day divisions
  const scaleFromDate = new Date(nonOutliers[0]);
  scaleFromDate.setHours(0, 0, 0, 0);
  const scaleFrom = scaleFromDate.getTime();

  const scaleToDate = new Date(starts[starts.length - 1]);
  scaleToDate.setHours(23, 59, 59, 999);
  const scaleTo = scaleToDate.getTime();

  return { scaleFrom, scaleTo, outlierThreshold: nonOutliers[0] };
}

function formatTick(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function Timeline({ clusters, range, onClusterClick, selectedClusterId }: TimelineProps) {
  const [showAllTime, setShowAllTime] = useState(false);
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Compute the data-driven scale (outlier-aware) from all clusters
  const dataScale = useMemo(() => computeDataScale(clusters), [clusters]);

  // In recent mode, limit to clusters starting within 7 days of latest
  const activeWindow = useMemo(() => {
    if (!dataScale) return null;
    if (showAllTime) return null; // null = no time filter, show all
    return { from: Math.max(dataScale.scaleFrom, dataScale.scaleTo - SEVEN_DAYS_MS) };
  }, [dataScale, showAllTime]);

  // Check if there are any clusters outside the 7-day window (to show the toggle)
  const hasOlderClusters = useMemo(() => {
    if (!dataScale) return false;
    const windowFrom = dataScale.scaleTo - SEVEN_DAYS_MS;
    return clusters.some(c => {
      const t = c.startTime ? new Date(c.startTime).getTime() : null;
      return t !== null && t < windowFrom;
    });
  }, [clusters, dataScale]);

  // Layout: assign lanes and compute x-percentages
  const { placedClusters, totalLanes, effectiveScaleFrom, effectiveScaleTo } = useMemo(() => {
    if (!dataScale || clusters.length === 0) {
      return { placedClusters: [], totalLanes: 1, effectiveScaleFrom: 0, effectiveScaleTo: 1 };
    }

    const { scaleFrom, scaleTo, outlierThreshold } = dataScale;
    const rangeSpanMs = Math.max(scaleTo - scaleFrom, 1);

    // Filter clusters to visible set (based on window)
    const visibleClusters = clusters.filter(c => {
      if (!activeWindow) return true; // all-time mode: show everything
      const startMs = c.startTime ? new Date(c.startTime).getTime() : scaleFrom;
      const endMs = c.endTime ? new Date(c.endTime).getTime() : startMs;
      // Include if the cluster overlaps or starts within the window
      return startMs >= activeWindow.from || endMs >= activeWindow.from;
    });

    // Sort by start time
    const sorted = [...visibleClusters].sort((a, b) => {
      const aStart = a.startTime ? new Date(a.startTime).getTime() : scaleFrom;
      const bStart = b.startTime ? new Date(b.startTime).getTime() : scaleFrom;
      return aStart - bStart;
    });

    const lanes: number[] = [];
    const MIN_GAP_PCT = 0.8;
    const placed: PlacedCluster[] = [];

    for (const cluster of sorted) {
      const startMs = cluster.startTime ? new Date(cluster.startTime).getTime() : scaleFrom;
      const endMs = cluster.endTime ? new Date(cluster.endTime).getTime() : startMs;
      const isOutlier = startMs < outlierThreshold;
      const isSingleton = cluster.articleCount === 1 || startMs === endMs;

      let startX = ((startMs - scaleFrom) / rangeSpanMs) * 100;
      let endX = ((endMs - scaleFrom) / rangeSpanMs) * 100;

      // Clamp to 0-100
      startX = Math.max(0, Math.min(100, startX));
      endX = Math.max(0, Math.min(100, endX));

      // Ensure multi-article bars have a minimum visible width
      if (!isSingleton && endX - startX < 0.4) endX = startX + 0.4;

      // Lane assignment
      let assignedLane = -1;
      for (let i = 0; i < lanes.length; i++) {
        if (lanes[i] + MIN_GAP_PCT <= startX) {
          assignedLane = i;
          break;
        }
      }
      if (assignedLane === -1) {
        assignedLane = lanes.length;
        lanes.push(isSingleton ? startX + MIN_GAP_PCT : endX);
      } else {
        lanes[assignedLane] = isSingleton ? startX + MIN_GAP_PCT : endX;
      }

      placed.push({ ...cluster, lane: assignedLane, startX, endX, isSingleton, isOutlier });
    }

    return {
      placedClusters: placed,
      totalLanes: Math.max(lanes.length, 1),
      effectiveScaleFrom: scaleFrom,
      effectiveScaleTo: scaleTo,
    };
  }, [clusters, dataScale, activeWindow]);

  // Generate exactly one tick per calendar day in the effective scale
  const axisTicks = useMemo(() => {
    const ticks = [];
    const span = effectiveScaleTo - effectiveScaleFrom;
    if (span <= 0) return [{ ms: effectiveScaleFrom, pct: 0, label: formatTick(effectiveScaleFrom) }];

    // Because effectiveScaleFrom is snapped to midnight, we just step forward by 1 day at a time
    const current = new Date(effectiveScaleFrom);
    
    while (current.getTime() < effectiveScaleTo) {
      const ms = current.getTime();
      ticks.push({
        ms,
        pct: ((ms - effectiveScaleFrom) / span) * 100,
        label: formatTick(ms)
      });
      current.setDate(current.getDate() + 1);
    }
    
    return ticks;
  }, [effectiveScaleFrom, effectiveScaleTo]);

  // Tooltip: track position from mouse events on the container
  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>, cluster: PlacedCluster) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setTooltip({
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
      cluster,
    });
  }, []);

  const handleMouseLeave = useCallback(() => setTooltip(null), []);

  if (!dataScale || clusters.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-64 bg-slate-50 border border-dashed border-slate-200 rounded-xl">
        <p className="text-slate-400 font-medium">No timeline data available.</p>
      </div>
    );
  }

  const LANE_HEIGHT = 36;
  const TOP_PADDING = 12;
  const AXIS_HEIGHT = 34;
  // 32 px inset on each side so dots/bars/labels never touch the container edges.
  // Using a fixed px value (not %) because it needs to be consistent with the
  // tooltip's horizontal clamping, which operates in pixels.
  const PLOT_MARGIN_PX = 32;
  const containerHeight = TOP_PADDING + totalLanes * LANE_HEIGHT + AXIS_HEIGHT;

  return (
    <div className="relative w-full">
      {/* Controls row */}
      <div className="flex items-center justify-end mb-2 gap-3">
        {hasOlderClusters && (
          <button
            onClick={() => setShowAllTime(v => !v)}
            className={`px-3 py-1 rounded-full border text-xs font-medium transition-colors duration-150 ${
              showAllTime
                ? 'bg-amber-50 text-amber-700 border-amber-300 hover:bg-amber-100'
                : 'bg-white text-slate-500 border-slate-300 hover:bg-slate-50'
            }`}
          >
            {showAllTime ? '← Recent (7 days)' : 'Show older stories ↗'}
          </button>
        )}
        <span className="text-xs text-slate-400">
          {placedClusters.length} cluster{placedClusters.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Timeline container */}
      <div
        ref={containerRef}
        className="relative w-full bg-white rounded-xl border border-slate-200 shadow-sm"
        style={{ minHeight: 200 }}
      >
        <div className="overflow-x-auto w-full">
          <div className="relative min-w-[700px] w-full" style={{ height: containerHeight }}>

            {/* Inset plot area — PLOT_MARGIN_PX from each horizontal edge.
                All clusters, gridlines, axis ticks live inside this div so that
                0% = left inset boundary and 100% = right inset boundary.
                The percentage formula is unchanged; only the bounding box shifts. */}
            <div
              className="absolute top-0 bottom-0"
              style={{ left: PLOT_MARGIN_PX, right: PLOT_MARGIN_PX }}
            >
              {/* Vertical grid lines — scoped to the inset area */}
              {axisTicks.map((tick, i) => (
                <div
                  key={i}
                  className="absolute top-0 bottom-0 pointer-events-none border-l"
                  style={{
                    left: `${tick.pct}%`,
                    borderColor: i === 0 || i === axisTicks.length - 1 ? '#e2e8f0' : '#f8fafc'
                  }}
                />
              ))}

              {/* Cluster elements */}
              <div className="absolute left-0 right-0" style={{ top: TOP_PADDING, bottom: AXIS_HEIGHT }}>
                {placedClusters.map((cluster) => {
                  const top = cluster.lane * LANE_HEIGHT + LANE_HEIGHT / 2;
                  const isSelected = selectedClusterId === cluster.id;

                  const dotColor = cluster.isOutlier
                    ? 'bg-amber-400'
                    : isSelected
                    ? 'bg-blue-600'
                    : cluster.articleCount > 3
                    ? 'bg-slate-800'
                    : cluster.articleCount > 1
                    ? 'bg-slate-600'
                    : 'bg-slate-400';

                  return (
                    <div
                      key={cluster.id}
                      className="absolute cursor-pointer"
                      style={{
                        top: `${top}px`,
                        left: `${cluster.startX}%`,
                        width: cluster.isSingleton ? '0px' : `${Math.max(cluster.endX - cluster.startX, 0.4)}%`,
                        transform: 'translateY(-50%)',
                        zIndex: isSelected ? 10 : 1,
                      }}
                      onMouseMove={(e) => handleMouseMove(e, cluster)}
                      onMouseLeave={handleMouseLeave}
                      onClick={() => onClusterClick(cluster.id)}
                    >
                      {cluster.isSingleton ? (
                        <div
                          className={`
                            w-3 h-3 -ml-1.5 rounded-full shadow-sm transition-all duration-150
                            ${dotColor}
                            ${isSelected ? 'scale-150 ring-2 ring-blue-200 ring-offset-1' : 'hover:scale-125'}
                          `}
                        />
                      ) : (
                        <div
                          className={`
                            h-2.5 rounded-full shadow-sm transition-all duration-150
                            ${dotColor}
                            ${isSelected ? 'h-4 ring-2 ring-blue-200' : 'hover:h-3.5'}
                          `}
                        />
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Axis baseline — spans the inset width */}
              <div
                className="absolute left-0 right-0 border-t border-slate-200"
                style={{ bottom: AXIS_HEIGHT - 6 }}
              />

              {/* Axis tick labels */}
              <div className="absolute left-0 right-0" style={{ bottom: 0, height: AXIS_HEIGHT }}>
                {axisTicks.map((tick, i) => {
                  const isFirst = i === 0;
                  const isLast = i === axisTicks.length - 1;
                  return (
                    <div
                      key={i}
                      className="absolute flex flex-col items-center"
                      style={{
                        left: `${tick.pct}%`,
                        top: 0,
                        transform: isFirst ? 'none' : isLast ? 'translateX(-100%)' : 'translateX(-50%)',
                      }}
                    >
                      <div className="w-px h-2 bg-slate-300" />
                      <span className="text-[10px] font-medium text-slate-400 mt-0.5 whitespace-nowrap select-none">
                        {tick.label}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>

        {/* Tooltip: rendered inside the container, positioned via mouse coords, constrained to container bounds */}
        {tooltip && (
          <TooltipPopup tooltip={tooltip} containerRef={containerRef} />
        )}
      </div>
    </div>
  );
}

// Separate component so it can measure its own size and flip
function TooltipPopup({ tooltip, containerRef }: {
  tooltip: TooltipState;
  containerRef: React.RefObject<HTMLDivElement>;
}) {
  const tooltipRef = useRef<HTMLDivElement>(null);
  // Reuse the same inset value as the plot margin so the tooltip's horizontal
  // clamping boundary matches the visual edges of the plot area.
  const PLOT_MARGIN_PX = 32;
  const VERTICAL_MARGIN = 8;
  const containerWidth = containerRef.current?.clientWidth ?? 800;
  const containerHeight = containerRef.current?.clientHeight ?? 400;
  const tooltipWidth = tooltipRef.current?.offsetWidth ?? 240;
  const tooltipHeight = tooltipRef.current?.offsetHeight ?? 48;

  // Default: above the cursor
  let top = tooltip.y - tooltipHeight - 12;
  let left = tooltip.x - tooltipWidth / 2;

  // Flip below if not enough room above
  if (top < VERTICAL_MARGIN) {
    top = tooltip.y + 16;
  }
  // Keep within container vertically (don't overlap header)
  top = Math.max(VERTICAL_MARGIN, Math.min(top, containerHeight - tooltipHeight - VERTICAL_MARGIN));

  // Keep within the inset plot area horizontally (consistent with dot/bar boundaries)
  left = Math.max(PLOT_MARGIN_PX, Math.min(left, containerWidth - tooltipWidth - PLOT_MARGIN_PX));

  return (
    <div
      ref={tooltipRef}
      className="absolute pointer-events-none z-50 bg-slate-900 text-white text-xs px-3 py-2 rounded-lg shadow-xl whitespace-nowrap font-medium"
      style={{ top, left }}
    >
      <div className="flex items-center gap-2">
        <span className="bg-blue-500 text-white px-1.5 py-0.5 rounded text-[10px] font-bold shrink-0">
          {tooltip.cluster.articleCount}
        </span>
        <span className="max-w-[220px] truncate">{tooltip.cluster.label}</span>
      </div>
    </div>
  );
}

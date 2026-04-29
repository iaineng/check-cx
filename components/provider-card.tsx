"use client";

import {AlertTriangle, Radio, Zap} from "lucide-react";

import {ProviderIcon} from "@/components/provider-icon";
import {StatusTimeline} from "@/components/status-timeline";
import {AvailabilityStats} from "@/components/availability-stats";
import {Badge} from "@/components/ui/badge";
import type {AvailabilityPeriod, AvailabilityStat, ProviderTimeline} from "@/lib/types";
import {OFFICIAL_STATUS_META, PROVIDER_LABEL, STATUS_META} from "@/lib/core/status";
import {cn} from "@/lib/utils";

interface ProviderCardProps {
  timeline: ProviderTimeline;
  timeToNextRefresh: number | null;
  availabilityStats?: AvailabilityStat[] | null;
  selectedPeriod: AvailabilityPeriod;
}

const formatLatency = (value: number | null | undefined) =>
  typeof value === "number" ? `${value} ms` : "—";

/** Tech-style decorative corner plus marker */
const CornerPlus = ({ className }: { className?: string }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1"
    className={cn("absolute h-4 w-4 text-muted-foreground/40", className)}
  >
    <line x1="12" y1="0" x2="12" y2="24" />
    <line x1="0" y1="12" x2="24" y2="12" />
  </svg>
);

export function ProviderCard({
  timeline,
  timeToNextRefresh,
  availabilityStats,
  selectedPeriod,
}: ProviderCardProps) {
  const { id, latest, items } = timeline;
  const preset = STATUS_META[latest.status];
  const isMaintenance = latest.status === "maintenance";
  const officialStatus = latest.officialStatus;
  const officialStatusMeta = officialStatus
    ? OFFICIAL_STATUS_META[officialStatus.status]
    : null;
  const banner = officialStatusMeta?.bannerLabel ? officialStatusMeta : null;

  return (
    <div className={cn(
      "group relative flex flex-col overflow-hidden rounded-2xl border bg-background/40 backdrop-blur-xl transition-all duration-300 hover:-translate-y-1 hover:shadow-lg hover:shadow-primary/5",
      banner
        ? banner.bannerBorder
        : "border-border/40 hover:border-primary/20"
    )}>
      <CornerPlus className="left-2 top-2 opacity-0 transition-opacity group-hover:opacity-100" />
      <CornerPlus className="right-2 top-2 opacity-0 transition-opacity group-hover:opacity-100" />

      {banner && officialStatus && (
        <div className={cn(
          "flex items-start gap-2.5 border-b px-4 py-2.5 sm:px-5 sm:py-3",
          banner.bannerBg
        )}>
          <div className="relative mt-0.5 flex-shrink-0">
            <AlertTriangle className="h-4 w-4" />
            <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-current animate-pulse" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-bold sm:text-sm">
              {banner.bannerLabel}
            </p>
            <p className="mt-0.5 text-[11px] leading-snug opacity-80 sm:text-xs">
              {officialStatus.message || banner.description}
            </p>
            {officialStatus.affectedComponents && officialStatus.affectedComponents.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1">
                {officialStatus.affectedComponents.map((c, i) => (
                  <span key={`${c}-${i}`} className="rounded bg-current/10 px-1.5 py-0.5 text-[10px] font-medium">
                    {c}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      <div className={cn("flex-1 p-4 sm:p-5", banner && "opacity-60")}>
        <div className="mb-4">
          <h3 className="line-clamp-2 text-base font-bold leading-tight tracking-tight text-foreground sm:text-lg md:text-xl lg:text-2xl">
            {latest.name}
          </h3>

          <div className="mt-2.5 flex items-center gap-3">
            <div className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-white/80 to-white/20 shadow-sm ring-1 ring-black/5 transition-transform group-hover:scale-105 dark:from-white/10 dark:to-white/5 dark:ring-white/10 sm:h-12 sm:w-12 sm:rounded-2xl">
              <div className="scale-75 sm:scale-100">
                <ProviderIcon type={latest.type} size={26} className="text-foreground/80" />
              </div>
            </div>
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-muted px-2 py-0.5 font-semibold text-foreground/70">
                {PROVIDER_LABEL[latest.type]}
              </span>
              <span className="truncate font-mono font-medium text-foreground/50">{latest.model}</span>
            </div>
            <Badge
              variant={preset.badge}
              className="shrink-0 whitespace-nowrap rounded-lg px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider shadow-sm backdrop-blur-md sm:px-2.5 sm:py-1 sm:text-xs"
            >
              {preset.label}
            </Badge>
          </div>
        </div>

        <div className="mb-4 grid grid-cols-2 gap-3">
          <div className="rounded-xl bg-muted/30 p-3 transition-colors group-hover:bg-muted/50">
            <div className="flex items-center gap-2 text-muted-foreground">
              <Zap className="h-3.5 w-3.5" />
              <span className="text-[10px] font-semibold uppercase tracking-wider">对话延迟</span>
            </div>
            <div className="mt-1 font-mono text-lg font-medium leading-none text-foreground">
              {formatLatency(latest.latencyMs)}
            </div>
          </div>

          <div className="rounded-xl bg-muted/30 p-3 transition-colors group-hover:bg-muted/50">
            <div className="flex items-center gap-2 text-muted-foreground">
              <Radio className="h-3.5 w-3.5" />
              <span className="text-[10px] font-semibold uppercase tracking-wider">端点 PING</span>
            </div>
            <div className="mt-1 font-mono text-lg font-medium leading-none text-foreground">
              {formatLatency(latest.pingLatencyMs)}
            </div>
          </div>
        </div>

        <div className="border-t border-border/30 pt-4">
          <AvailabilityStats stats={availabilityStats} period={selectedPeriod} isMaintenance={isMaintenance} />
        </div>
      </div>

      {/* Timeline Section - Visual separation */}
      <div className="border-t border-border/40 bg-muted/10 px-5 py-4">
        <StatusTimeline items={items} nextRefreshInMs={timeToNextRefresh} isMaintenance={isMaintenance} />
      </div>
    </div>
  );
}

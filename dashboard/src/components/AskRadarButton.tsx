import { useReducedMotion } from 'motion/react';
import { NoiseBackground } from '@/components/ui/noise-background';
import { cn } from '@/lib/utils';
import { IconSparkle } from './Icons';

// Brand blue -> indigo -> sky. Swap for e.g. pink/blue/amber to match the stock demo look.
const RADAR_GRADIENT = ['rgb(37, 99, 235)', 'rgb(99, 102, 241)', 'rgb(56, 189, 248)'];

interface AskRadarButtonProps {
  collapsed: boolean;
  open: boolean;
  onClick: () => void;
}

export function AskRadarButton({ collapsed, open, onClick }: AskRadarButtonProps) {
  const reduceMotion = useReducedMotion();

  return (
    <NoiseBackground
      containerClassName={cn('rounded-full bg-brand-100', collapsed ? 'w-fit p-1.5' : 'w-full p-2')}
      gradientColors={RADAR_GRADIENT}
      animating={!reduceMotion}
    >
      <button
        type="button"
        onClick={onClick}
        aria-label="Ask Radar"
        aria-expanded={open}
        aria-controls="radar-panel"
        title={collapsed ? 'Ask Radar' : undefined}
        className={cn(
          'flex items-center justify-center rounded-full bg-gradient-to-r from-neutral-100 via-neutral-100 to-white text-sm font-semibold text-slate-900',
          'shadow-[0px_2px_0px_0px_theme(colors.neutral.50)_inset,0px_0.5px_1px_0px_theme(colors.neutral.400)]',
          'transition-all duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 active:scale-[0.98]',
          collapsed ? 'h-9 w-9' : 'h-9 w-full gap-2 px-4',
        )}
      >
        <IconSparkle className="h-4 w-4 shrink-0 text-brand-600" />
        {!collapsed && (
          <span className="text-shimmer [--shimmer-base:#0f172a] [--shimmer-hi:#94a3b8]">Ask Radar</span>
        )}
      </button>
    </NoiseBackground>
  );
}

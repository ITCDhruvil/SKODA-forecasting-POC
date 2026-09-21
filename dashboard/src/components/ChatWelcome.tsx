import type { ReactElement } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { cn } from '@/lib/utils';
import { greetingFor } from '@/lib/greeting';
import {
  IconBeaker,
  IconChevronRight,
  IconGlobe,
  IconInfo,
  IconSparkle,
  IconTarget,
  IconTrending,
} from './Icons';

interface Card {
  title: string;
  description: string;
  prompt: string;
  icon: (props: { className?: string }) => ReactElement;
  tone: string;
}

const CARDS: Card[] = [
  {
    title: 'Biggest price movers',
    description: 'Parts with the largest forecast increases',
    prompt: 'Which parts are seeing the biggest price increases?',
    icon: IconTrending,
    tone: 'bg-blue-50 text-blue-600',
  },
  {
    title: 'Spend at risk',
    description: 'Exposure above the 5% threshold',
    prompt: "What's our spend at risk this quarter?",
    icon: IconTarget,
    tone: 'bg-amber-50 text-amber-600',
  },
  {
    title: 'Review geo alerts',
    description: 'Confirm or dismiss pending signals',
    prompt: 'Are there any geopolitical risks I need to review?',
    icon: IconGlobe,
    tone: 'bg-violet-50 text-violet-600',
  },
  {
    title: 'Model accuracy',
    description: 'How well the forecast has performed',
    prompt: 'How accurate is the forecasting model?',
    icon: IconBeaker,
    tone: 'bg-emerald-50 text-emerald-600',
  },
];

const EXPLORE_PROMPTS = [
  'How do I see the FX impact scenarios?',
  'Where does the data come from?',
  'What does Real-Data Validation show?',
];

const NEWS_PROMPT = 'What is the latest news affecting auto-parts prices?';

interface ChatWelcomeProps {
  onPick: (prompt: string) => void;
  disabled?: boolean;
  webEnabled?: boolean;
}

/** Opening screen shown before the first message: scope, capability cards, trust note. */
export function ChatWelcome({ onPick, disabled, webEnabled }: ChatWelcomeProps) {
  const reduceMotion = useReducedMotion();
  const greeting = greetingFor(new Date().getHours());
  const explorePrompts = webEnabled ? [NEWS_PROMPT, ...EXPLORE_PROMPTS] : EXPLORE_PROMPTS;

  return (
    <section aria-label="Welcome" className="relative -mx-5 -mt-4 overflow-hidden px-5 pb-2 pt-6">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-60 bg-[radial-gradient(70%_90%_at_15%_0%,rgba(37,99,235,0.12),transparent_70%),radial-gradient(50%_70%_at_95%_0%,rgba(99,102,241,0.10),transparent_70%)]"
      />

      <div className="relative flex flex-col gap-5">
        <div className="flex flex-col gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-brand-600 to-indigo-500 text-white shadow-[0_8px_20px_-6px_rgba(37,99,235,0.55)] ring-1 ring-inset ring-white/25">
            <IconSparkle className="h-5 w-5" />
          </div>
          <div>
            <p className="text-xs font-medium text-brand-600">{greeting}</p>
            <h2 className="mt-0.5 text-xl font-semibold tracking-tight text-slate-900">
              What should we look at first?
            </h2>
            <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-slate-500">
              Radar reads your live forecast data and answers with numbers you can trace.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2.5">
          {CARDS.map((card, i) => {
            const Icon = card.icon;
            return (
              <motion.button
                key={card.title}
                type="button"
                disabled={disabled}
                onClick={() => onPick(card.prompt)}
                initial={reduceMotion ? false : { opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.3, delay: 0.05 * i, ease: 'easeOut' }}
                className="group flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-3.5 text-left shadow-sm transition hover:border-brand-500/40 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 disabled:opacity-50"
              >
                <div className="flex items-center justify-between">
                  <span className={cn('flex h-8 w-8 items-center justify-center rounded-lg', card.tone)}>
                    <Icon className="h-4 w-4" />
                  </span>
                  <IconChevronRight className="h-4 w-4 -translate-x-1 text-slate-300 opacity-0 transition group-hover:translate-x-0 group-hover:opacity-100 group-focus-visible:translate-x-0 group-focus-visible:opacity-100" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-slate-900">{card.title}</p>
                  <p className="mt-0.5 text-xs leading-snug text-slate-500">{card.description}</p>
                </div>
              </motion.button>
            );
          })}
        </div>

        <div className="flex flex-col gap-2">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Explore</p>
          <div className="flex flex-wrap gap-2">
            {explorePrompts.map((prompt) => (
              <button
                key={prompt}
                type="button"
                disabled={disabled}
                onClick={() => onPick(prompt)}
                className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-left text-xs text-slate-600 transition hover:border-brand-500/40 hover:bg-brand-50 hover:text-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 disabled:opacity-50"
              >
                {prompt}
              </button>
            ))}
          </div>
        </div>

        <p className="flex items-start gap-2 text-xs leading-relaxed text-slate-400">
          <IconInfo className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {webEnabled
            ? 'Dashboard answers come from your data. Radar searches trusted news sources only when a question needs current information, and shows the sources. It can also confirm or dismiss geopolitical alerts when you ask.'
            : 'Answers come only from your dashboard data. Radar can confirm or dismiss geopolitical alerts when you ask.'}
        </p>
      </div>
    </section>
  );
}

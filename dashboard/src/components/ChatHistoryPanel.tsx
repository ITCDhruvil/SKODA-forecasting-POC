import { useLayoutEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { AnimatePresence, MotionConfig, motion, type Transition } from 'motion/react';
import { IconClear, IconClose, IconPin } from './Icons';
import { formatRelativeTime, splitForDisplay, type Conversation } from '../lib/chatHistory';

const SPRING: Transition = { type: 'spring', stiffness: 400, damping: 40 };
const MARQUEE_PX_PER_SECOND = 60;

/** Single-line text that scrolls right-to-left on hover when it doesn't fit. */
function MarqueeText({ text, animate, className }: { text: string; animate: boolean; className?: string }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const textRef = useRef<HTMLSpanElement | null>(null);
  const [overflow, setOverflow] = useState(0);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const inner = textRef.current;
    if (container && inner) setOverflow(Math.max(0, inner.offsetWidth - container.clientWidth));
  }, [text, animate]);

  const fade = 'linear-gradient(to right, black 85%, transparent)';
  const showFade = overflow > 0 && !animate;

  return (
    <div
      ref={containerRef}
      className={clsx('overflow-hidden whitespace-nowrap', className)}
      style={showFade ? { maskImage: fade, WebkitMaskImage: fade } : undefined}
    >
      <span
        ref={textRef}
        className="inline-block will-change-transform"
        style={{
          transform: `translateX(-${animate ? overflow : 0}px)`,
          transition: animate
            ? `transform ${Math.max(0.6, overflow / MARQUEE_PX_PER_SECOND)}s linear`
            : 'transform 0.25s ease-out',
        }}
      >
        {text}
      </span>
    </div>
  );
}

function ConversationRow({
  conversation,
  active,
  onSelect,
  onTogglePin,
  onDelete,
}: {
  conversation: Conversation;
  active: boolean;
  onSelect: () => void;
  onTogglePin: () => void;
  onDelete: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const { pinned } = conversation;

  return (
    <motion.div
      layoutId={`history-row-${conversation.id}`}
      transition={SPRING}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setHovered(true)}
      onBlur={() => setHovered(false)}
      className={clsx(
        'group flex items-center gap-1 rounded-xl px-3 py-2 transition-colors',
        active ? 'bg-brand-50' : 'bg-slate-50 hover:bg-slate-100',
      )}
    >
      <button type="button" onClick={onSelect} className="min-w-0 flex-1 py-0.5 text-left outline-none">
        <MarqueeText
          text={conversation.title}
          animate={hovered}
          className={clsx('text-sm font-medium', active ? 'text-brand-700' : 'text-slate-800')}
        />
        <span className="mt-0.5 block text-xs text-slate-400">{formatRelativeTime(conversation.updatedAt)}</span>
      </button>

      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={onTogglePin}
          aria-label={pinned ? 'Unpin conversation' : 'Pin conversation'}
          aria-pressed={pinned}
          title={pinned ? 'Unpin' : 'Pin'}
          className={clsx(
            'flex h-7 w-7 items-center justify-center rounded-full transition',
            pinned
              ? 'bg-amber-400 text-white opacity-100'
              : 'bg-slate-200 text-slate-600 opacity-0 hover:bg-slate-300 focus-visible:opacity-100 group-hover:opacity-100',
          )}
        >
          <IconPin className={clsx('h-3.5 w-3.5', pinned && 'fill-current')} />
        </button>
        <button
          type="button"
          onClick={onDelete}
          aria-label="Delete conversation"
          title="Delete"
          className="flex h-7 w-7 items-center justify-center rounded-full bg-slate-200 text-slate-600 opacity-0 transition hover:bg-red-100 hover:text-red-600 focus-visible:opacity-100 group-hover:opacity-100"
        >
          <IconClear className="h-3.5 w-3.5" />
        </button>
      </div>
    </motion.div>
  );
}

interface Props {
  open: boolean;
  conversations: Conversation[];
  activeId: string;
  onSelect: (id: string) => void;
  onTogglePin: (id: string) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}

/** History overlay that sits on top of the chat panel. */
export function ChatHistoryPanel({ open, conversations, activeId, onSelect, onTogglePin, onDelete, onClose }: Props) {
  const { pinned, recent } = splitForDisplay(conversations);

  const renderRow = (c: Conversation) => (
    <ConversationRow
      key={c.id}
      conversation={c}
      active={c.id === activeId}
      onSelect={() => onSelect(c.id)}
      onTogglePin={() => onTogglePin(c.id)}
      onDelete={() => onDelete(c.id)}
    />
  );

  return (
    <div
      inert={!open}
      aria-hidden={!open}
      className={clsx(
        'absolute inset-0 z-20 flex flex-col bg-white transition duration-200 ease-out',
        open ? 'translate-y-0 opacity-100' : 'pointer-events-none translate-y-2 opacity-0',
      )}
    >
      <div className="flex items-center justify-between px-5 py-4">
        <p className="text-sm font-semibold text-slate-900">History</p>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close history"
          title="Close history"
          className="flex h-8 w-8 items-center justify-center rounded-md text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
        >
          <IconClose className="h-4 w-4" />
        </button>
      </div>

      <div className="scrollbar-hidden flex-1 overflow-y-auto px-4 pb-4">
        <MotionConfig transition={SPRING}>
          <AnimatePresence mode="popLayout" initial={false}>
            {pinned.length > 0 && (
              <motion.div
                key="pinned-section"
                layout
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="mb-5 space-y-2"
              >
                <motion.h3 layout className="ml-1 text-xs font-semibold uppercase tracking-wider text-slate-400">
                  Pinned
                </motion.h3>
                <div className="space-y-1.5">{pinned.map(renderRow)}</div>
              </motion.div>
            )}
          </AnimatePresence>

          <motion.div layout className="space-y-2">
            <motion.h3 layout className="ml-1 text-xs font-semibold uppercase tracking-wider text-slate-400">
              Recent
            </motion.h3>
            {recent.length > 0 ? (
              <div className="space-y-1.5">{recent.map(renderRow)}</div>
            ) : (
              <p className="ml-1 text-sm text-slate-400">
                {pinned.length > 0 ? 'No other conversations.' : 'No conversations yet. Your chats will show up here.'}
              </p>
            )}
          </motion.div>
        </MotionConfig>
      </div>
    </div>
  );
}

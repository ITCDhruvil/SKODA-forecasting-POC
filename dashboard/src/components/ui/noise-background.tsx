import { useEffect, useRef } from 'react';
import {
  motion,
  useAnimationFrame,
  useMotionTemplate,
  useMotionValue,
  useSpring,
  useTransform,
  type MotionValue,
} from 'motion/react';
import { cn } from '@/lib/utils';

/**
 * Adapted from the Aceternity "noise-background" component for this project's stack
 * (Tailwind v3, light theme only):
 * - v3 shadow syntax (theme() instead of v4 --color-* variables), no dark: variants
 * - grain is generated locally as an SVG data URI, so the dashboard makes no third-party
 *   network request for a decorative texture
 */
const NOISE_IMAGE = `url("data:image/svg+xml,${encodeURIComponent(
  "<svg xmlns='http://www.w3.org/2000/svg' width='200' height='200'><filter id='n' x='0' y='0' width='100%' height='100%'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/><feColorMatrix type='saturate' values='0'/></filter><rect width='100%' height='100%' filter='url(#n)'/></svg>",
)}")`;

function GradientLayer({
  springX,
  springY,
  gradientColor,
  opacity,
  multiplier,
}: {
  springX: MotionValue<number>;
  springY: MotionValue<number>;
  gradientColor: string;
  opacity: number;
  multiplier: number;
}) {
  const x = useTransform(springX, (val) => val * multiplier);
  const y = useTransform(springY, (val) => val * multiplier);
  const background = useMotionTemplate`radial-gradient(circle at ${x}px ${y}px, ${gradientColor} 0%, transparent 50%)`;

  return <motion.div className="absolute inset-0" style={{ opacity, background }} />;
}

interface NoiseBackgroundProps {
  children?: React.ReactNode;
  className?: string;
  containerClassName?: string;
  gradientColors?: string[];
  noiseIntensity?: number;
  speed?: number;
  backdropBlur?: boolean;
  animating?: boolean;
}

export const NoiseBackground = ({
  children,
  className,
  containerClassName,
  gradientColors = ['rgb(255, 100, 150)', 'rgb(100, 150, 255)', 'rgb(255, 200, 100)'],
  noiseIntensity = 0.2,
  speed = 0.1,
  backdropBlur = false,
  animating = true,
}: NoiseBackgroundProps) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const x = useMotionValue(0);
  const y = useMotionValue(0);

  const springX = useSpring(x, { stiffness: 100, damping: 30 });
  const springY = useSpring(y, { stiffness: 100, damping: 30 });

  const topGradientX = useTransform(springX, (val) => val * 0.1 - 50);

  const velocityRef = useRef({ x: 0, y: 0 });
  const lastDirectionChangeRef = useRef(0);

  useEffect(() => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    x.set(rect.width / 2);
    y.set(rect.height / 2);
  }, [x, y]);

  const generateRandomVelocityRef = useRef(() => {
    const angle = Math.random() * Math.PI * 2;
    const magnitude = speed * (0.5 + Math.random() * 0.5);
    return { x: Math.cos(angle) * magnitude, y: Math.sin(angle) * magnitude };
  });

  useEffect(() => {
    generateRandomVelocityRef.current = () => {
      const angle = Math.random() * Math.PI * 2;
      const magnitude = speed * (0.5 + Math.random() * 0.5);
      return { x: Math.cos(angle) * magnitude, y: Math.sin(angle) * magnitude };
    };
    velocityRef.current = generateRandomVelocityRef.current();
  }, [speed]);

  useAnimationFrame((time) => {
    if (!animating || !containerRef.current) return;

    const rect = containerRef.current.getBoundingClientRect();
    const maxX = rect.width;
    const maxY = rect.height;

    if (time - lastDirectionChangeRef.current > 1500 + Math.random() * 1500) {
      velocityRef.current = generateRandomVelocityRef.current();
      lastDirectionChangeRef.current = time;
    }

    const deltaTime = 16;
    let newX = x.get() + velocityRef.current.x * deltaTime;
    let newY = y.get() + velocityRef.current.y * deltaTime;

    const padding = 20;
    if (newX < padding || newX > maxX - padding || newY < padding || newY > maxY - padding) {
      const angle = Math.random() * Math.PI * 2;
      const magnitude = speed * (0.5 + Math.random() * 0.5);
      velocityRef.current = { x: Math.cos(angle) * magnitude, y: Math.sin(angle) * magnitude };
      lastDirectionChangeRef.current = time;
      newX = Math.max(padding, Math.min(maxX - padding, newX));
      newY = Math.max(padding, Math.min(maxY - padding, newY));
    }

    x.set(newX);
    y.set(newY);
  });

  return (
    <div
      ref={containerRef}
      className={cn(
        'group relative overflow-hidden rounded-2xl bg-neutral-200 p-2 backdrop-blur-sm',
        'shadow-[0px_0.5px_1px_0px_theme(colors.neutral.400)_inset,0px_1px_0px_0px_theme(colors.neutral.100)]',
        backdropBlur && "after:absolute after:inset-0 after:h-full after:w-full after:backdrop-blur-lg after:content-['']",
        containerClassName,
      )}
      style={{ '--noise-opacity': noiseIntensity } as React.CSSProperties}
    >
      <GradientLayer springX={springX} springY={springY} gradientColor={gradientColors[0]} opacity={0.4} multiplier={1} />
      <GradientLayer springX={springX} springY={springY} gradientColor={gradientColors[1]} opacity={0.3} multiplier={0.7} />
      <GradientLayer
        springX={springX}
        springY={springY}
        gradientColor={gradientColors[2] || gradientColors[0]}
        opacity={0.25}
        multiplier={1.2}
      />

      <motion.div
        className="absolute inset-x-0 top-0 h-1 rounded-t-2xl opacity-80 blur-sm"
        style={{
          background: `linear-gradient(to right, ${gradientColors.join(', ')})`,
          x: animating ? topGradientX : 0,
        }}
      />

      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage: NOISE_IMAGE,
          backgroundSize: '200px 200px',
          opacity: 'var(--noise-opacity)',
          mixBlendMode: 'overlay',
        }}
      />

      <div className={cn('relative z-10', className)}>{children}</div>
    </div>
  );
};

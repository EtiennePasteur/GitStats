/** Primitives visuelles partagées : marques fines, chrome discret, ancres cliquables. */

import type { ReactNode, ButtonHTMLAttributes } from 'react';

export function cx(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ');
}

export function Card({
  title,
  subtitle,
  actions,
  children,
  className,
  bodyClassName,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section
      className={cx(
        'rounded-xl border bg-[var(--surface-1)]',
        'border-[var(--border)]',
        className,
      )}
    >
      {(title !== undefined || actions !== undefined) && (
        <header className="flex items-start justify-between gap-4 px-4 pt-4 pb-2">
          <div className="min-w-0">
            {title !== undefined && (
              <h2 className="truncate text-sm font-semibold text-[var(--text-primary)]">{title}</h2>
            )}
            {subtitle !== undefined && (
              <p className="mt-0.5 text-xs text-[var(--text-muted)]">{subtitle}</p>
            )}
          </div>
          {actions !== undefined && <div className="shrink-0">{actions}</div>}
        </header>
      )}
      <div className={cx('px-4 pt-1 pb-4', bodyClassName)}>{children}</div>
    </section>
  );
}

/**
 * Tuile de statistique : quand l'histoire tient en un nombre, c'est un nombre
 * qu'il faut afficher — pas un graphique à une barre.
 * Chiffres proportionnels (jamais `tabular-nums` sur un grand nombre isolé).
 */
export function StatTile({
  label,
  value,
  hint,
  accent,
  loading,
}: {
  label: string;
  value: string;
  hint?: ReactNode;
  accent?: string;
  loading?: boolean;
}) {
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-1)] px-4 py-3">
      <div className="text-xs font-medium tracking-wide text-[var(--text-muted)] uppercase">{label}</div>
      {loading === true ? (
        <div className="skeleton mt-2 h-8 w-24 rounded-md" />
      ) : (
        <div
          className="mt-1 text-3xl leading-none font-semibold"
          style={{ color: accent ?? 'var(--text-primary)' }}
        >
          {value}
        </div>
      )}
      {hint !== undefined && <div className="mt-1.5 text-xs text-[var(--text-muted)]">{hint}</div>}
    </div>
  );
}

type ButtonVariant = 'primary' | 'ghost' | 'danger' | 'subtle';

export function Button({
  variant = 'ghost',
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  const styles: Record<ButtonVariant, string> = {
    primary:
      'bg-[var(--series-1)] text-white hover:brightness-110 border-transparent disabled:opacity-40',
    ghost:
      'bg-transparent text-[var(--text-secondary)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)] border-[var(--border)]',
    subtle:
      'bg-[var(--surface-2)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] border-transparent',
    danger:
      'bg-transparent text-[var(--status-critical)] hover:bg-[color-mix(in_oklab,var(--status-critical)_14%,transparent)] border-[var(--border)]',
  };
  return (
    <button
      type="button"
      className={cx(
        'inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border px-3 text-sm font-medium transition',
        'disabled:cursor-not-allowed disabled:opacity-50',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--series-1)]',
        styles[variant],
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: ReactNode;
  hint?: string;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5 text-sm select-none">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={cx(
          'relative mt-0.5 h-[18px] w-8 shrink-0 rounded-full border transition',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--series-1)]',
          checked
            ? 'border-transparent bg-[var(--series-1)]'
            : 'border-[var(--border-strong)] bg-[var(--surface-2)]',
        )}
      >
        <span
          className={cx(
            'absolute top-[2px] h-[12px] w-[12px] rounded-full bg-white transition-all',
            checked ? 'left-[16px]' : 'left-[2px]',
          )}
        />
      </button>
      <span>
        <span className="text-[var(--text-secondary)]">{label}</span>
        {hint !== undefined && <span className="block text-xs text-[var(--text-muted)]">{hint}</span>}
      </span>
    </label>
  );
}

export type StatusTone = 'good' | 'warning' | 'serious' | 'critical' | 'neutral' | 'accent';

const TONE_COLOR: Record<StatusTone, string> = {
  good: 'var(--status-good)',
  warning: 'var(--status-warning)',
  serious: 'var(--status-serious)',
  critical: 'var(--status-critical)',
  neutral: 'var(--text-muted)',
  accent: 'var(--series-1)',
};

/**
 * Une couleur de statut ne porte jamais le sens seule : la pastille est toujours
 * accompagnée d'un libellé (contrainte d'accessibilité, et les teintes
 * « warning » / « serious » passent sous 3:1 en mode clair).
 */
export function StatusBadge({ tone, children }: { tone: StatusTone; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md bg-[var(--surface-2)] px-1.5 py-0.5 text-xs whitespace-nowrap text-[var(--text-secondary)]">
      <span
        aria-hidden
        className="h-1.5 w-1.5 shrink-0 rounded-full"
        style={{ background: TONE_COLOR[tone] }}
      />
      {children}
    </span>
  );
}

/** Pastille de couleur d'une série, à poser à côté d'un libellé en encre de texte. */
export function SeriesDot({ color }: { color: string }) {
  return (
    <span
      aria-hidden
      className="inline-block h-2.5 w-2.5 shrink-0 rounded-[3px]"
      style={{ background: color }}
    />
  );
}

export function Avatar({ name, size = 24, color }: { name: string; size?: number; color?: string }) {
  const initials = name
    .split(/[\s.@_-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.4,
        background: color ?? 'var(--surface-2)',
      }}
      aria-hidden
    >
      {initials}
    </span>
  );
}

/**
 * Pastille d'instance. Volontairement discrète et rendue uniquement quand
 * plusieurs instances coexistent : sur un parc mono-instance, l'information est
 * du bruit.
 */
export function InstanceBadge({ label }: { label: string | null }) {
  if (label === null) return null;
  return (
    <span className="shrink-0 rounded bg-[var(--surface-2)] px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-[var(--text-muted)] uppercase">
      {label}
    </span>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx('skeleton rounded-md', className)} />;
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-[var(--border)] px-6 py-12 text-center">
      <p className="text-sm font-medium text-[var(--text-secondary)]">{title}</p>
      {children !== undefined && (
        <div className="mt-1.5 max-w-md text-xs text-[var(--text-muted)]">{children}</div>
      )}
    </div>
  );
}

/** Barre de progression fine. `value` et `max` dans la même unité. */
export function ProgressBar({
  value,
  max,
  tone = 'accent',
}: {
  value: number;
  max: number;
  tone?: StatusTone;
}) {
  const ratio = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  return (
    <div
      className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--surface-2)]"
      role="progressbar"
      aria-valuenow={Math.round(ratio * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className="h-full rounded-full transition-[width] duration-300"
        style={{ width: `${ratio * 100}%`, background: TONE_COLOR[tone] }}
      />
    </div>
  );
}

// --- formatage ---------------------------------------------------------

const NUMBER = new Intl.NumberFormat('fr-FR');

export function formatNumber(value: number): string {
  return NUMBER.format(Math.round(value));
}

export function formatCompact(value: number): string {
  if (Math.abs(value) < 10_000) return NUMBER.format(Math.round(value));
  return new Intl.NumberFormat('fr-FR', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

export function formatSigned(value: number): string {
  return `${value >= 0 ? '+' : '−'}${NUMBER.format(Math.abs(Math.round(value)))}`;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds} s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes} min ${String(seconds).padStart(2, '0')} s`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${String(minutes % 60).padStart(2, '0')} min`;
}

export function formatDay(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return day;
  return new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(date);
}

export function formatDateTime(iso: string | null): string {
  if (iso === null) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

export function formatRelative(iso: string | null): string {
  if (iso === null) return 'jamais';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'jamais';
  const diffDays = Math.round((Date.now() - date.getTime()) / 86_400_000);
  if (diffDays <= 0) return "aujourd'hui";
  if (diffDays === 1) return 'hier';
  if (diffDays < 30) return `il y a ${diffDays} j`;
  if (diffDays < 365) return `il y a ${Math.round(diffDays / 30)} mois`;
  return `il y a ${Math.round(diffDays / 365)} an${diffDays >= 730 ? 's' : ''}`;
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes)) return '—';
  const units = ['o', 'Ko', 'Mo', 'Go'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 && unit > 0 ? 1 : 0)} ${units[unit]}`;
}

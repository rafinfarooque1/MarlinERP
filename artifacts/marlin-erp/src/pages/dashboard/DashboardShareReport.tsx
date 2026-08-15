/**
 * DashboardShareReport — the dedicated share/export surface for the dashboard.
 *
 * The Share button captures THIS component and nothing else (owner spec:
 * never a cropped page screenshot). It renders off-screen at a fixed design
 * width, so the generated image is identical on phone, tablet and desktop —
 * the viewport never leaks into the output.
 *
 * Two deliberate rules:
 *  - Figures arrive as ALREADY-FORMATTED strings taken from the same card
 *    array the on-screen dashboard renders, so the image can never disagree
 *    with the screen (no refetch, no recompute).
 *  - Colors are hard-coded light-report values (hex), not theme tokens: a
 *    user in dark mode still shares a clean white business report.
 */
import { forwardRef } from 'react';
import type { CardTone } from '@/pages/reports/shared';

export interface ShareKpi {
  label: string;
  value: string;
  tone?: CardTone;
  /** Reconciling breakdown line, e.g. "Salary ₹x · Rent ₹y · Other ₹z". */
  hint?: string;
}

/** Light-report ink colors — independent of the app theme. */
const TONE_HEX: Record<CardTone, string> = {
  default: '#0f172a',
  pos: '#047857',
  neg: '#dc2626',
  warn: '#b45309',
  accent: '#1d4ed8',
  info: '#1d4ed8',
};

export interface DashboardShareReportProps {
  locationLabel: string;
  periodLabel: string;
  presetLabel: string;
  generatedAt: string;
  cards: ShareKpi[];
}

/** Fixed design width — chosen so 2-across cards stay readable at 2x capture. */
export const SHARE_REPORT_WIDTH = 720;

export const DashboardShareReport = forwardRef<HTMLDivElement, DashboardShareReportProps>(
  function DashboardShareReport({ locationLabel, periodLabel, presetLabel, generatedAt, cards }, ref) {
    return (
      <div
        ref={ref}
        style={{ width: SHARE_REPORT_WIDTH, fontFamily: "'Inter', system-ui, sans-serif" }}
        className="bg-white text-slate-900 p-8"
      >
        {/* Brand accent + header */}
        <div className="h-1.5 rounded-full bg-blue-700 mb-6" />
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-slate-900">Business Dashboard</h1>
            <p className="mt-1 text-sm text-slate-600">{locationLabel}</p>
          </div>
          <div className="text-right shrink-0">
            <span className="inline-block rounded-full border border-blue-200 bg-blue-50 px-3 py-1 text-xs font-semibold text-blue-700">
              {presetLabel}
            </span>
            <p className="mt-1.5 text-xs text-slate-500">{periodLabel}</p>
          </div>
        </div>

        {/* KPI grid — 2 across, same pair order as the live dashboard */}
        <div className="mt-6 grid grid-cols-2 gap-3">
          {cards.map((c) => (
            <div key={c.label} className="rounded-xl border border-slate-200 bg-slate-50/60 px-4 py-3">
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{c.label}</p>
              <p
                className="mt-1 text-xl font-bold tabular-nums leading-tight"
                style={{ color: TONE_HEX[c.tone ?? 'default'] }}
              >
                {c.value}
              </p>
              {c.hint && <p className="mt-1 text-[11px] leading-tight text-slate-500">{c.hint}</p>}
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="mt-6 flex items-center justify-between border-t border-slate-200 pt-3">
          <p className="text-[11px] text-slate-400">Generated {generatedAt}</p>
          <p className="text-[11px] font-medium text-slate-400">Marlin Frozen Fruits ERP</p>
        </div>
      </div>
    );
  },
);

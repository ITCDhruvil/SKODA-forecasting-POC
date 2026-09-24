import { useState } from 'react';
import clsx from 'clsx';
import type { ChatEntry, ExportOffer } from '../lib/chatHistory';
import { toApiMessages } from '../lib/chatHistory';

const FORMAT_LABEL: Record<ExportOffer['format'], string> = { xlsx: 'Excel', docx: 'Word' };

function other(format: ExportOffer['format']): ExportOffer['format'] {
  return format === 'xlsx' ? 'docx' : 'xlsx';
}

function filenameFrom(disposition: string | null, fallback: string): string {
  const match = disposition?.match(/filename="([^"]+)"/);
  return match ? match[1] : fallback;
}

/**
 * One line under the answer: the model's pick as a button, the other format as a link.
 * Never blocks the conversation — an ignored card does nothing.
 */
export function ExportCard({ offer, messages }: { offer: ExportOffer; messages: ChatEntry[] }) {
  const [busy, setBusy] = useState<ExportOffer['format'] | null>(null);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function download(format: ExportOffer['format']) {
    if (busy) return;
    setBusy(format);
    setError(null);
    try {
      const response = await fetch('/api/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          offer,
          format,
          ...(format === 'docx' ? { messages: toApiMessages(messages) } : {}),
        }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        setError((payload as { error?: string }).error ?? "couldn't build that file");
        return;
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filenameFrom(response.headers.get('Content-Disposition'), `export.${format}`);
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      setDone(true);
    } catch {
      setError("couldn't build that file");
    } finally {
      setBusy(null);
    }
  }

  const secondary = other(offer.format);
  const secondaryAllowed = secondary === 'docx' || offer.dataRef !== null;

  return (
    <div className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm">
      <p className="font-medium text-slate-800">{offer.label}</p>
      <div className="mt-1.5 flex items-center gap-3">
        <button
          type="button"
          onClick={() => download(offer.format)}
          disabled={busy !== null}
          className={clsx(
            'rounded-lg px-3 py-1.5 text-xs font-medium text-white transition',
            busy !== null ? 'bg-slate-400' : 'bg-brand-600 hover:bg-brand-700',
          )}
        >
          {busy === offer.format ? 'Preparing…' : done ? 'Downloaded' : FORMAT_LABEL[offer.format]}
        </button>
        {secondaryAllowed && (
          <button
            type="button"
            onClick={() => download(secondary)}
            disabled={busy !== null}
            className="text-xs text-slate-500 underline-offset-2 hover:underline disabled:opacity-50"
          >
            {busy === secondary ? 'Preparing…' : FORMAT_LABEL[secondary]}
          </button>
        )}
      </div>
      {error && <p className="mt-1.5 text-xs text-red-600">{error}</p>}
    </div>
  );
}

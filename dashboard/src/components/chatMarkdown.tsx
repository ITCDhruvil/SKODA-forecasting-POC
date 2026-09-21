import type { ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { isDomainLabel } from '../lib/markdownLinks';

/** Plain text of a link's children (strings and arrays of strings); anything richer yields ''. */
function plainText(children: ReactNode): string {
  if (typeof children === 'string') return children;
  if (Array.isArray(children)) return children.map((c) => (typeof c === 'string' ? c : '')).join('');
  return '';
}

const listClasses =
  'space-y-1.5 pl-5 text-sm text-slate-800 [&_ul]:mt-1.5 [&_ol]:mt-1.5';

export const markdownComponents: Components = {
  p: ({ node, ...props }) => <p className="text-sm leading-relaxed text-slate-800" {...props} />,
  strong: ({ node, ...props }) => <strong className="font-semibold text-slate-900" {...props} />,
  a: ({ node, children, ...props }) => {
    const pill = isDomainLabel(plainText(children));
    return (
      <a
        className={
          pill
            ? 'inline-flex items-center rounded-full bg-slate-100 px-1.5 py-0.5 align-baseline text-[11px] font-medium text-slate-600 no-underline transition hover:bg-brand-50 hover:text-brand-700'
            : 'text-brand-600 underline hover:text-brand-700'
        }
        target="_blank"
        rel="noopener noreferrer"
        {...props}
      >
        {children}
      </a>
    );
  },
  ul: ({ node, ...props }) => <ul className={`list-disc marker:text-slate-400 ${listClasses}`} {...props} />,
  ol: ({ node, ...props }) => (
    <ol className={`list-decimal marker:font-semibold marker:text-brand-600 ${listClasses}`} {...props} />
  ),
  li: ({ node, ...props }) => <li className="pl-0.5 leading-relaxed" {...props} />,
  h1: ({ node, ...props }) => <h1 className="text-[15px] font-semibold text-slate-900" {...props} />,
  h2: ({ node, ...props }) => (
    <h2 className="border-b border-slate-100 pb-1 text-sm font-semibold text-slate-900" {...props} />
  ),
  h3: ({ node, ...props }) => <h3 className="text-[13px] font-semibold text-slate-700" {...props} />,
  hr: ({ node, ...props }) => <hr className="border-slate-200" {...props} />,
  blockquote: ({ node, ...props }) => (
    <blockquote className="border-l-2 border-slate-200 pl-3 text-sm text-slate-600" {...props} />
  ),
  code: ({ node, ...props }) => (
    <code className="rounded bg-slate-100 px-1 py-0.5 text-xs text-slate-800" {...props} />
  ),
  pre: ({ node, ...props }) => (
    <pre
      className="overflow-x-auto rounded-lg bg-slate-50 p-3 text-xs [&_code]:bg-transparent [&_code]:p-0"
      {...props}
    />
  ),
  table: ({ node, ...props }) => (
    <div className="overflow-x-auto rounded-lg border border-slate-200">
      <table className="w-full border-collapse text-xs" {...props} />
    </div>
  ),
  thead: ({ node, ...props }) => <thead className="bg-slate-50" {...props} />,
  th: ({ node, ...props }) => (
    <th className="whitespace-nowrap px-2.5 py-1.5 text-left font-semibold text-slate-600" {...props} />
  ),
  td: ({ node, ...props }) => (
    <td className="border-t border-slate-100 px-2.5 py-1.5 align-top text-slate-700" {...props} />
  ),
};

/** Renders an assistant answer as markdown with the Radar panel's typography. */
export function MessageMarkdown({ content }: { content: string }) {
  return (
    <div className="space-y-3">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {content}
      </ReactMarkdown>
    </div>
  );
}

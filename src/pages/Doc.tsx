import type { ReactNode } from 'react';
import { ErrorBanner, Lines, PageHead } from '../components/Common';
import { useSnapshot } from '../stream';

export interface Sec { id: string; title: string; body: ReactNode }

/** Text page with a table of contents beside the sections. */
export function DocPage({ title, lede, secs }: { title: string; lede: ReactNode; secs: Sec[] }) {
  const snap = useSnapshot();
  return (
    <main className="page">
      <PageHead title={title}>{lede}</PageHead>
      <ErrorBanner snap={snap} />
      {snap.status === 'loading' ? <Lines n={10} /> : (
        <div className="doc">
          <nav className="toc" aria-label="Table of contents">
            <span className="label">Contents</span>
            <ol>{secs.map((s) => <li key={s.id}><a href={`#${s.id}`}>{s.title}</a></li>)}</ol>
          </nav>
          <div>
            {secs.map((s) => (
              <section key={s.id} id={s.id} className="section">
                <h2>{s.title}</h2>
                {s.body}
              </section>
            ))}
          </div>
        </div>
      )}
    </main>
  );
}

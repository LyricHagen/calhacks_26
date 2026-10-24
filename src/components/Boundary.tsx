// Crash containment. Each route sits in its own boundary, so a crash keeps the
// header and says in one sentence what failed, with Copy diagnostics right
// there. The whole app also sits in one, so nothing ever renders blank.
import { Component, useState, type ErrorInfo, type ReactNode } from 'react';
import { copyText, diagnostics, log } from '../debug';

/** Copies the diagnostics report; shows it for copying by hand if the clipboard is blocked. */
export function CopyDiagnostics() {
  const [note, setNote] = useState('');
  const [manual, setManual] = useState<string | null>(null);
  const copy = async () => {
    const text = diagnostics();
    if (await copyText(text, 'Diagnostics')) {
      setManual(null);
      setNote(`Copied ${text.split('\n').length} lines.`);
    } else {
      setManual(text);
      setNote('The browser blocked the clipboard. Select the text below and copy it by hand.');
    }
  };
  return (
    <>
      <div className="actions">
        <button type="button" className="btn" onClick={copy}>Copy diagnostics</button>
        <span className="note" aria-live="polite">{note}</span>
      </div>
      {manual != null && <textarea className="manual-copy" readOnly value={manual} onFocus={(e) => e.currentTarget.select()} autoFocus />}
    </>
  );
}

interface Props {
  /** What failed, as the sentence says it: "The Session page", "The app". */
  what: string;
  children: ReactNode;
  /** Shown under the sentence, such as a way back. */
  after?: ReactNode;
  /** Adds the page margins, for the boundary outside the app's own layout. */
  wrap?: boolean;
}

export class Boundary extends Component<Props, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    const where = (info.componentStack ?? '').split('\n').map((s) => s.trim().replace(/^at /, '').split(' ')[0]).filter(Boolean).slice(0, 6);
    log.error.error(`${this.props.what} crashed and was replaced by an error message`, error, { components: where.join(' < ') || 'unknown' });
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const page = (
      <main className="page">
        <div className="banner banner-error" role="alert">
          <span className="label">Crashed</span>
          <p>{this.props.what} stopped working: {(error.message || error.name).replace(/\.$/, '')}.</p>
          <CopyDiagnostics />
          {this.props.after}
        </div>
      </main>
    );
    return this.props.wrap ? <div className="wrap">{page}</div> : page;
  }
}

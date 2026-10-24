import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import '@fontsource/libre-franklin/latin-400.css';
import '@fontsource/libre-franklin/latin-700.css';
import '@fontsource/courier-prime/latin-400.css';
import '@fontsource/courier-prime/latin-700.css';
import './styles.css';
import { App } from './App';
import { Boundary } from './components/Boundary';
import { DebugPanel } from './DebugPanel';
import { logEnvironment } from './debug';

logEnvironment();

createRoot(document.getElementById('root')!).render(
  <BrowserRouter>
    {/* Last line of defence: a crash outside any page (header, stream) still shows a sentence and Copy diagnostics. */}
    <Boundary what="The app" wrap after={<p className="note"><a href="/">Reload from the start</a></p>}>
      <App />
    </Boundary>
  </BrowserRouter>,
);

// The debug panel gets its own root so it survives a crash in the app.
const debugRoot = document.createElement('div');
document.body.appendChild(debugRoot);
createRoot(debugRoot).render(<DebugPanel />);

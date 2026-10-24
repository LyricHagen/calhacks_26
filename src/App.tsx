import { useEffect, useLayoutEffect, type ReactNode } from 'react';
import { useLocation, useRoutes, type RouteObject } from 'react-router-dom';
import { Boundary } from './components/Boundary';
import { Footer, Header, PageHead } from './components/Common';
import { CalibratePage } from './pages/Calibrate';
import { DiagPage } from './pages/Diag';
import { HomePage } from './pages/Home';
import { MethodPage } from './pages/Method';
import { PrivacyPage } from './pages/Privacy';
import { SessionPage } from './pages/Session';
import { SummaryPage } from './pages/Summary';
import { log } from './debug';
import { StreamProvider } from './stream';
import { QLink, useTheme } from './util';

function Sync() {
  const theme = useTheme();
  const { pathname, search, hash } = useLocation();
  useLayoutEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  useEffect(() => { log.route.info(`Page shown: ${pathname}`, { path: pathname, query: search || 'none', hash: hash || 'none', theme }); }, [pathname, search, hash, theme]);
  useEffect(() => {
    const el = hash && document.getElementById(decodeURIComponent(hash.slice(1)));
    if (el) el.scrollIntoView();
    else window.scrollTo(0, 0);
  }, [pathname, hash]);
  return null;
}

/** Every page, with the name its crash message uses. /diag is reached from the debug panel only. */
export const PAGES: { path: string; name: string; element: ReactNode }[] = [
  { path: '/', name: 'Connect', element: <HomePage /> },
  { path: '/calibrate', name: 'Calibrate', element: <CalibratePage /> },
  { path: '/session', name: 'Session', element: <SessionPage /> },
  { path: '/session/summary', name: 'Summary', element: <SummaryPage /> },
  { path: '/method', name: 'Method', element: <MethodPage /> },
  { path: '/privacy', name: 'Privacy', element: <PrivacyPage /> },
  { path: '/diag', name: 'Self-test', element: <DiagPage /> },
];

function NotFound() {
  const { pathname } = useLocation();
  useEffect(() => { log.route.warn('No page matches this address; showing "Page not found"', { path: pathname, known: PAGES.map((p) => p.path).join(' ') }); }, [pathname]);
  return <main className="page"><PageHead title="Page not found"><p><QLink to="/">Back to Connect</QLink>.</p></PageHead></main>;
}

/** The route table, each page in its own crash boundary. Also read by /diag. */
export const ROUTES: RouteObject[] = [
  ...PAGES.map(({ path, name, element }) => ({
    path,
    element: (
      <Boundary key={path} what={`The ${name} page`} after={path === '/' ? null : <p className="note"><QLink to="/">Back to Connect</QLink></p>}>
        {element}
      </Boundary>
    ),
  })),
  { path: '*', element: <NotFound /> },
];

export function App() {
  const routes = useRoutes(ROUTES);
  return (
    <StreamProvider>
      <Sync />
      <div className="wrap">
        <Header />
        {routes}
        <Footer />
      </div>
    </StreamProvider>
  );
}

import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Rail } from './components/Rail';
import { PauseBanner } from './components/PauseBanner';
import { PauseProvider } from './pause/PauseProvider';
import { ToastProvider } from './components/Toast';
import { useJobs, JobsProvider } from './jobs/JobsProvider';
import { PlacesProvider } from './places/PlacesProvider';
import { ProfileScopeProvider } from './profiles/ProfileScopeProvider';
import { SettingsProvider } from './settings/SettingsProvider';
import { preloadScreens, screenDef } from './nav';
import { NavContext, RouteContext } from './navContext';
import { formatRoute, GALLERY_ROUTE, parseHash, resolveTarget, sameRoute, type NavTarget, type Route } from './routes';
import { StartupNotice } from './components/StartupNotice';
import type { StartupStatus } from '../shared/startup';
import { focusSearchBox, isGalleryShortcut, isSearchShortcut } from './shortcuts';

/** Review-only screen showing every component. Compiled out of production builds. */
const DevGallery = import.meta.env.DEV ? lazy(() => import('./screens/DevGallery')) : null;

/** The address bar of the window is the one source of truth for the screen: back and forward just work. */
function useHashRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash, import.meta.env.DEV));
  useEffect(() => {
    const onChange = (): void => {
      const next = parseHash(window.location.hash, import.meta.env.DEV);
      setRoute((current) => (sameRoute(current, next) ? current : next));
    };
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

export function App() {
  return (
    <JobsProvider>
      <PlacesProvider>
        <SettingsProvider>
          <PauseProvider>
            <ProfileScopeProvider>
              <ToastProvider>
                <Shell />
              </ToastProvider>
            </ProfileScopeProvider>
          </PauseProvider>
        </SettingsProvider>
      </PlacesProvider>
    </JobsProvider>
  );
}

function Shell() {
  const route = useHashRoute();
  const { attention } = useJobs();
  const [resetKey, setResetKey] = useState(0);
  const mainRef = useRef<HTMLElement>(null);
  const shownScreen = useRef(route.screen);
  const routeRef = useRef(route);
  useEffect(() => {
    routeRef.current = route;
  });
  // Ctrl+K from another screen: the search box takes the focus once Files has opened.
  const wantsSearch = useRef(false);
  const [dataReady, setDataReady] = useState(false);
  const [startup, setStartup] = useState<StartupStatus | null>(null);

  // The database opens after the window is visible; say so instead of showing empty screens.
  useEffect(() => {
    let alive = true;
    let timer: number | undefined;
    const ready = (): void => {
      if (alive) setDataReady(true);
      window.clearInterval(timer);
    };
    window.backupHub.app
      .dataReady()
      .then(() => {
        ready();
        return undefined;
      })
      .catch(ready);
    // The database file may be checked first, or brought up to this version; say so, with how long it has been (it can take a minute).
    timer = window.setInterval(() => {
      window.backupHub.app
        .startupStatus()
        .then((status) => {
          if (alive) setStartup(status);
          return undefined;
        })
        .catch(() => undefined);
    }, 500);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  // Once the first screen is up, the code of the others is fetched quietly.
  useEffect(() => {
    const timer = window.setTimeout(preloadScreens, 1200);
    return () => window.clearTimeout(timer);
  }, []);

  // After the user switches screen, move focus into the content so keyboard and screen-reader
  // users land at the top of the new page. Skipped on the first render, and when Ctrl+K asked for the search box.
  useEffect(() => {
    if (shownScreen.current === route.screen) return undefined;
    shownScreen.current = route.screen;
    if (wantsSearch.current && route.screen === 'files') {
      wantsSearch.current = false;
      return focusSearchBox();
    }
    mainRef.current?.focus();
    return undefined;
  }, [route.screen]);

  // Any screen can ask to go somewhere, by a current or an old name. Setting the address makes the browser keep the history.
  const navigate = useCallback((target: NavTarget, sub?: string | null) => {
    const landing = resolveTarget(target);
    const hash = formatRoute(landing.screen, sub === undefined ? landing.sub : sub);
    if (window.location.hash !== hash) window.location.hash = hash;
  }, []);

  // Main asks us to open a screen (a clicked notification opens Activity).
  useEffect(
    () =>
      window.backupHub.onEvent('app:navigate', (payload) => {
        if (payload.screen === 'jobs') navigate('jobs');
      }),
    [navigate],
  );

  // Ctrl+K opens Files search from anywhere. Dev only: Ctrl+Shift+G toggles the component gallery (it has no sidebar entry).
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (isSearchShortcut(event)) {
        event.preventDefault();
        if (routeRef.current.screen === 'files') {
          focusSearchBox();
        } else {
          wantsSearch.current = true;
          navigate('files');
        }
      } else if (import.meta.env.DEV && isGalleryShortcut(event)) {
        event.preventDefault();
        window.location.hash = routeRef.current.screen === GALLERY_ROUTE ? formatRoute('home') : formatRoute(GALLERY_ROUTE);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate]);

  const Screen = route.screen === GALLERY_ROUTE ? DevGallery : (screenDef(route.screen)?.Screen ?? null);

  return (
    <NavContext.Provider value={navigate}>
      <RouteContext.Provider value={route}>
        <div className="app">
          <a
            className="skip-link"
            href="#main-content"
            onClick={(event) => {
              event.preventDefault();
              mainRef.current?.focus();
            }}
          >
            Skip to the page content
          </a>
          <Rail
            route={route}
            onSelect={(id) => {
              // Choosing the screen you are on takes you back to its top (for example out of a detail panel).
              if (route.screen === id && route.sub === null) setResetKey((k) => k + 1);
              else navigate(id);
            }}
            jobsBadge={attention}
          />
          <main className="main" id="main-content" ref={mainRef} tabIndex={-1}>
            <PauseBanner />
            {dataReady ? null : <StartupNotice status={startup} />}
            {/* Mounted while the notice shows (the code is loaded and the screen is ready), but not drawn until the data is there. */}
            <div className={dataReady ? 'screen-slot' : 'screen-slot screen-slot--waiting'}>
              <Suspense fallback={null}>{Screen ? <Screen key={resetKey} /> : null}</Suspense>
            </div>
          </main>
        </div>
      </RouteContext.Provider>
    </NavContext.Provider>
  );
}

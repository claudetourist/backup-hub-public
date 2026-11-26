import { createContext, useContext } from 'react';
import type { NavTarget, Route } from './routes';
import { HOME_ROUTE } from './routes';

/**
 * Lets any screen switch screens without a router: navigate('files'), or navigate('settings', 'security') for a section.
 * The App provides the real function (it sets the address, so back and forward work).
 */
export type Navigate = (target: NavTarget, sub?: string | null) => void;

export const NavContext = createContext<Navigate>(() => undefined);

export function useNavigate(): Navigate {
  return useContext(NavContext);
}

/** The screen being shown, read from the address. */
export const RouteContext = createContext<Route>(HOME_ROUTE);

export function useRoute(): Route {
  return useContext(RouteContext);
}

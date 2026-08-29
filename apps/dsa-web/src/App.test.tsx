import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import * as AuthContext from './contexts/AuthContext';
import { UI_LANGUAGE_STORAGE_KEY } from './utils/uiLanguage';

type AuthState = ReturnType<typeof AuthContext.useAuth>;

const { useAgentChatStoreMock } = vi.hoisted(() => {
  const setCurrentRoute = vi.fn();
  const state = { completionBadge: false };
  const useAgentChatStoreMock = Object.assign(
    vi.fn((selector?: (value: typeof state) => unknown) => (selector ? selector(state) : state)),
    { getState: () => ({ setCurrentRoute }) },
  );
  return { useAgentChatStoreMock };
});

vi.mock('./contexts/AuthContext', () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => children,
  useAuth: vi.fn(),
}));

vi.mock('./stores/agentChatStore', () => ({ useAgentChatStore: useAgentChatStoreMock }));
vi.mock('./pages/HomePage', () => ({ default: () => <div data-testid="home-page">Home</div> }));
vi.mock('./pages/StockMasterHoldingsPage', () => ({ default: () => <div data-testid="stockmaster-holdings-page">Portfolio</div> }));
vi.mock('./pages/StockMasterSettingsPage', () => ({ default: () => <div data-testid="settings-page">Settings</div> }));
vi.mock('./pages/LoginPage', () => ({ default: () => <div data-testid="login-page">Login</div> }));

function makeAuthState(overrides: Partial<AuthState> = {}): AuthState {
  return {
    authEnabled: false,
    loggedIn: false,
    passwordSet: false,
    passwordChangeable: false,
    setupState: 'no_password',
    isLoading: false,
    loadError: null,
    login: vi.fn().mockResolvedValue({ success: true }),
    changePassword: vi.fn().mockResolvedValue({ success: true }),
    logout: vi.fn().mockResolvedValue(undefined),
    refreshStatus: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  window.history.pushState({}, '', '/');
  localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, 'zh');
  vi.mocked(AuthContext.useAuth).mockReturnValue(makeAuthState());
});

describe('StockMaster App routing behavior', () => {
  it('shows loading fallback while auth status is initializing', () => {
    vi.mocked(AuthContext.useAuth).mockReturnValue(makeAuthState({ isLoading: true }));
    const { container } = render(<App />);
    expect(container.querySelector('.border-t-cyan')).toBeInTheDocument();
  });

  it('renders the three supported pages', async () => {
    for (const [path, testId] of [['/', 'home-page'], ['/portfolio', 'stockmaster-holdings-page'], ['/settings', 'settings-page']] as const) {
      window.history.pushState({}, '', path);
      const view = render(<App />);
      expect(await screen.findByTestId(testId)).toBeInTheDocument();
      view.unmount();
    }
  });

  it('redirects unsupported routes to Home', async () => {
    window.history.pushState({}, '', '/chat');
    render(<App />);
    expect(await screen.findByTestId('home-page')).toBeInTheDocument();
  });

  it('redirects protected routes to login when auth is enabled', async () => {
    vi.mocked(AuthContext.useAuth).mockReturnValue(makeAuthState({
      authEnabled: true,
      loggedIn: false,
      setupState: 'enabled',
    }));
    window.history.pushState({}, '', '/portfolio');
    render(<App />);
    expect(await screen.findByTestId('login-page')).toBeInTheDocument();
    expect(window.location.pathname).toBe('/login');
  });
});

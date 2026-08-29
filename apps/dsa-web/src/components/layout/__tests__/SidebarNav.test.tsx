import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { SidebarNav } from '../SidebarNav';

const mockLogout = vi.fn().mockResolvedValue(undefined);
const mockThemeToggle = vi.fn(({ collapsed }: { collapsed?: boolean }) => (
  <button type="button">{collapsed ? '切换主题(折叠)' : '切换主题'}</button>
));

vi.mock('../../../contexts/AuthContext', () => ({
  useAuth: () => ({ authEnabled: true, logout: mockLogout }),
}));

vi.mock('../../theme/ThemeToggle', () => ({
  ThemeToggle: (props: { collapsed?: boolean }) => mockThemeToggle(props),
}));

describe('SidebarNav', () => {
  it('keeps the StockMaster rail labels inside a fixed desktop rail', () => {
    const { container } = render(
      <MemoryRouter initialEntries={['/']}>
        <SidebarNav variant="rail" />
      </MemoryRouter>,
    );

    const links = screen.getAllByRole('link');
    expect(container.querySelector('[data-stockmaster-nav="true"]')).toHaveClass('stockmaster-nav-rail');
    expect(links.every((link) => link.className.includes('whitespace-nowrap'))).toBe(true);
  });

  it('renders exactly the three StockMaster destinations', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <SidebarNav />
      </MemoryRouter>,
    );

    expect(screen.getAllByRole('link').map((link) => link.getAttribute('href'))).toEqual([
      '/',
      '/portfolio',
      '/settings',
    ]);
    expect(screen.getByRole('link', { name: '首页 / 自选股' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '持仓' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '设置' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '问股' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '选股' })).not.toBeInTheDocument();
  });

  it('renders the collapsed theme toggle variant when the sidebar is collapsed', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <SidebarNav collapsed />
      </MemoryRouter>,
    );

    expect(mockThemeToggle).toHaveBeenCalledWith(
      expect.objectContaining({ variant: 'nav', collapsed: true }),
    );
    expect(screen.getByRole('button', { name: '切换主题(折叠)' })).toBeInTheDocument();
  });

  it('opens the logout confirmation and confirms logout', async () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <SidebarNav />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: /退出/ }));
    expect(await screen.findByRole('heading', { name: /退出登录/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /确认退出/ }));
    expect(mockLogout).toHaveBeenCalled();
  });
});

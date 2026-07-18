import { render, screen } from '@testing-library/react';
import DashboardOrganizationsPage from '@/app/dashboard/org/page';
import { useQuery } from '@tanstack/react-query';

vi.mock('@tanstack/react-query', () => ({
  useQuery: vi.fn(),
}));

describe('DashboardOrganizationsPage loading skeleton', () => {
  it('shows skeleton cards while loading', () => {
    vi.mocked(useQuery).mockReturnValue({ data: undefined, error: undefined, isLoading: true } as any);
    render(<DashboardOrganizationsPage />);
    const skeletons = screen.getAllByTestId('organization-skeleton');
    expect(skeletons.length).toBeGreaterThan(0);
  });
});

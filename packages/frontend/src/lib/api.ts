/**
 * @file api.ts
 * @description Backend API client for very-princess.
 */

const BACKEND_URL = process.env["NEXT_PUBLIC_BACKEND_URL"] ?? "http://localhost:3001/api";

export interface Org {
  id: string;
  name: string;
  admin: string;
  publicBudget?: string; // Total public budget available in stroops
}

export interface PaginatedResponse<T> {
  data: T[];
  meta: {
    totalPages: number;
    currentPage: number;
    totalCount: number;
  };
}

/**
 * Fetch a paginated list of organizations from the backend.
 */
export async function fetchOrganizations(page: number = 1, limit: number = 10, search?: string): Promise<PaginatedResponse<Org>> {
  const params = new URLSearchParams({
    page: page.toString(),
    limit: limit.toString(),
  });
  
  if (search) {
    params.append('search', search);
  }
  
  const response = await fetch(`${BACKEND_URL}/v1/contract/orgs?${params}`);
  if (!response.ok) {
    throw new Error(`Failed to fetch organizations: ${response.statusText}`);
  }
  return response.json();
}

export interface TopMaintainer {
  address: string;
  totalEarningsXlm: string;
  totalEarningsStroops: string;
  organizationsAssisted: number;
}

/**
 * Fetch top maintainers from the backend.
 */
export async function fetchTopMaintainers(): Promise<TopMaintainer[]> {
  const response = await fetch(`${BACKEND_URL}/stats/top-maintainers`);
  if (!response.ok) {
    throw new Error(`Failed to fetch leaderboard: ${response.statusText}`);
  }
  return response.json();
}

/**
 * Register a new organization.
 */
export async function registerOrganization(
  id: string,
  name: string,
  admin: string,
  signerSecret: string
): Promise<{ success: boolean; transactionHash?: string }> {
  const response = await fetch(`${BACKEND_URL}/v1/contract/orgs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, name, admin, signerSecret }),
  });
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ message: response.statusText }));
    throw new Error(errorData.message || `Failed to register organization: ${response.statusText}`);
  }
  return response.json();
}

import {
  organizationService,
  PaginatedOrgsResponse,
} from "../services/organizationService.js";
import { payoutService } from "../services/payoutService.js";
import { stellarService } from "../services/stellarService.js";
import type {
  OrgResponse,
  MaintainersResponse,
  MaintainerBalanceResponse,
  BudgetResponse,
  FundResponse,
  PayoutResponse,
  ClaimTransactionResponse,
  SubmitTransactionResponse,
} from "@very-prince/types";

// ─── Controller ───────────────────────────────────────────────────────────────

export const contractController = {
  /**
   * Fetch a paginated list of organizations.
   */
  async getOrganizations(
    page: number,
    limit: number,
    search?: string,
  ): Promise<PaginatedOrgsResponse> {
    return organizationService.getOrganizations(page, limit, search);
  },

  /**
   * Register a new organization and index it in the local database.
   */
  async registerOrganization(
    id: string,
    name: string,
    admin: string,
    signerSecret: string,
  ): Promise<FundResponse> {
    const result = await organizationService.registerOrganization(
      id,
      name,
      admin,
      signerSecret,
    );

    return {
      success: result.success,
      orgId: id,
      donor: admin,
      amountStroops: "0",
      ...(result.transactionHash !== undefined
        ? { transactionHash: result.transactionHash }
        : {}),
    };
  },

  /**
   * Fetch the details of a registered organization.
   */
  async getOrganization(orgId: string): Promise<OrgResponse> {
    return organizationService.getOrganization(orgId);
  },

  /**
   * Fetch the ordered list of maintainer addresses for an organization.
   */
  async getMaintainers(
    orgId: string,
    page = 1,
    limit = 20
  ): Promise<MaintainersResponse> {
    // The Soroban contract has no native pagination for this read, so we
    // fetch the full maintainer list and paginate in-memory.
    const allMaintainers = await organizationService.getMaintainers(orgId);
    const totalCount = allMaintainers.length;
    const totalPages = Math.max(1, Math.ceil(totalCount / limit));

    const skip = (page - 1) * limit;
    const maintainers = allMaintainers.slice(skip, skip + limit);

    return {
      orgId,
      maintainers,
      count: maintainers.length,
      meta: {
        page,
        limit,
        totalCount,
        totalPages,
      },
    };
  },

  /**
   * Fetch the current budget for an organization.
   */
  async getOrgBudget(orgId: string): Promise<BudgetResponse> {
    return organizationService.getOrgBudget(orgId);
  },

  /**
   * Fetch the claimable balance for a maintainer address.
   */
  async getClaimableBalance(
    maintainerAddress: string,
  ): Promise<MaintainerBalanceResponse> {
    return payoutService.getClaimableBalance(maintainerAddress);
  },

  /**
   * Fund an organization's budget.
   */
  async fundOrg(
    orgId: string,
    fromAddress: string,
    amountStroops: string,
    signerSecret: string,
  ): Promise<FundResponse> {
    const result = await payoutService.fundOrg(
      orgId,
      fromAddress,
      amountStroops,
      signerSecret,
    );
    return {
      success: result.success,
      orgId,
      donor: fromAddress,
      amountStroops,
      ...(result.transactionHash !== undefined
        ? { transactionHash: result.transactionHash }
        : {}),
    };
  },

  /**
   * Allocate a payout to a maintainer.
   */
  async allocatePayout(
    orgId: string,
    maintainerAddress: string,
    amountStroops: string,
    signerSecret: string,
  ): Promise<PayoutResponse> {
    const result = await payoutService.allocatePayout(
      orgId,
      maintainerAddress,
      amountStroops,
      signerSecret,
    );
    return {
      success: result.success,
      orgId,
      maintainer: maintainerAddress,
      amountStroops,
      ...(result.transactionHash !== undefined
        ? { transactionHash: result.transactionHash }
        : {}),
    };
  },

  /**
   * Create a claim payout transaction for a maintainer.
   */
  async createClaimTransaction(
    orgId: string,
    maintainerAddress: string,
  ): Promise<ClaimTransactionResponse> {
    const transactionXdr = await stellarService.createClaimPayoutTransaction(
      orgId,
      maintainerAddress,
    );
    return { transactionXdr };
  },

  /**
   * Submit a signed transaction to the Stellar network.
   */
  async submitTransaction(
    signedTransaction: string,
  ): Promise<SubmitTransactionResponse> {
    const result = await stellarService.submitTransaction(signedTransaction);
    return {
      success: result.success,
      ...(result.transactionHash !== undefined
        ? { transactionHash: result.transactionHash }
        : {}),
    };
  },
} as const;

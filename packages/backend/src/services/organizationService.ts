import { organizationRepository } from "../repositories/OrganizationRepository.js";
import { stellarService } from "../services/stellarService.js";
import { redis } from "../services/cache.js";
import type { PaginatedOrgsResponse, CursorPaginatedOrgsResponse } from "@very-prince/types";
import { ipfsService } from "./ipfsService.js";

export type { PaginatedOrgsResponse, CursorPaginatedOrgsResponse };

export class OrganizationService {
  async getOrganizations(page: number, limit: number, search?: string): Promise<PaginatedOrgsResponse> {
    const skip = (page - 1) * limit;
    const cacheKey = `orgs:page:${page}:limit:${limit}:search:${search || ''}`;

    // 1. Try cache if it's the first page
    if (page === 1) {
      const cached = await redis.get(cacheKey);
      if (cached) {
        return JSON.parse(cached);
      }
    }

    // 2. Fetch from Repo
    const [orgs, totalCount] = await Promise.all([
      organizationRepository.findMany(skip, limit, search),
      organizationRepository.count(search),
    ]);

    // 3. Fetch public budgets for each organization
    const orgsWithBudget = await Promise.all(
      orgs.map(async (org) => {
        try {
          const budget = await stellarService.readOrgBudget(org.id);
          return {
            id: org.id,
            name: org.name,
            admin: org.admin,
            publicBudget: budget.toString(),
          };
        } catch (error) {
          // If budget fetch fails, return org without budget
          return {
            id: org.id,
            name: org.name,
            admin: org.admin,
          };
        }
      })
    );

    const totalPages = Math.ceil(totalCount / limit);
    const response: PaginatedOrgsResponse = {
      data: orgsWithBudget,
      meta: {
        totalPages,
        currentPage: page,
        totalCount,
      },
    };

    // 4. Cache the first page for 5 minutes
    if (page === 1) {
      await redis.set(cacheKey, JSON.stringify(response), "EX", 300);
    }

    return response;
  }

  async getOrganizationsCursor(
    cursor: string | undefined,
    limit: number,
    search?: string
  ): Promise<CursorPaginatedOrgsResponse> {
    const cacheKey = `orgs:cursor:${cursor || ''}:limit:${limit}:search:${search || ''}`;

    if (!cursor) {
      const cached = await redis.get(cacheKey);
      if (cached) {
        return JSON.parse(cached);
      }
    }

    const [repoResult, totalCount] = await Promise.all([
      organizationRepository.findManyCursor(cursor, limit, search),
      organizationRepository.count(search),
    ]);

    const data = await Promise.all(
      repoResult.data.map(async (org) => {
        try {
          const budget = await stellarService.readOrgBudget(org.id);
          return {
            id: org.id,
            name: org.name,
            admin: org.admin,
            publicBudget: budget.toString(),
          };
        } catch {
          return {
            id: org.id,
            name: org.name,
            admin: org.admin,
          };
        }
      })
    );

    const startCursor = data.length > 0 ? OrganizationRepository.encodeCursor(repoResult.data[0]) : undefined;
    const endCursor = data.length > 0 ? OrganizationRepository.encodeCursor(repoResult.data[data.length - 1]) : undefined;

    const response: CursorPaginatedOrgsResponse = {
      data,
      meta: {
        totalCount,
        hasNextPage: repoResult.hasNextPage,
        hasPrevPage: repoResult.hasPrevPage,
        startCursor,
        endCursor,
      },
    };

    if (!cursor) {
      await redis.set(cacheKey, JSON.stringify(response), "EX", 300);
    }

    return response;
  }

  async registerOrganization(
    id: string,
    name: string,
    admin: string,
    signerSecret: string
  ) {
    const result = await stellarService.registerOrg(id, name, admin, signerSecret);
    
    // Index in Repo for pagination
    if (result.success) {
      await organizationRepository.upsert(id, name, admin);

      // Invalidate the first page cache
      const cacheKey = "orgs:page:1:limit:10";
      await redis.del(cacheKey);

      // Invalidate the organization cache
      await redis.del(`org:${id}`);
    }

    return result;
  }

  async getOrganization(orgId: string) {
    const cacheKey = `org:${orgId}`;
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        return JSON.parse(cached);
      }
    } catch (error) {
      console.error(`Redis error in getOrganization for key ${cacheKey}:`, error);
    }

    const org = await stellarService.readOrganization(orgId);
    const orgDetails = {
      id: String(org["id"]),
      name: String(org["name"]),
      admin: String(org["admin"]),
      metadataCid: org["metadata_cid"] ? String(org["metadata_cid"]) : undefined,
    };

    try {
      await redis.set(cacheKey, JSON.stringify(orgDetails), "EX", 300);
    } catch (error) {
      console.error(`Redis set error in getOrganization for key ${cacheKey}:`, error);
    }

    return orgDetails;
  }

  async getMaintainers(orgId: string) {
    return stellarService.readMaintainers(orgId);
  }

  async getOrgBudget(orgId: string) {
    const stroops = await stellarService.readOrgBudget(orgId);
    const xlm = (Number(stroops) / 10_000_000).toFixed(7);
    return {
      orgId,
      budgetStroops: stroops.toString(),
      budgetXlm: xlm,
    };
  }

  /**
   * Uploads organization metadata (logo and description) to IPFS.
   */
  async uploadMetadata(
    name: string,
    description: string,
    logoBase64?: string
  ): Promise<string> {
    return ipfsService.uploadOrgMetadata(name, description, logoBase64);
  }
}

export const organizationService = new OrganizationService();

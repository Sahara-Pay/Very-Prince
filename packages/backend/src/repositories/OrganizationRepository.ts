import { prisma } from "../services/db.js";
import { Organization } from "@prisma/client";

interface Cursor {
  createdAt: string;
  id: string;
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64");
}

function decodeCursor(cursor: string): Cursor | null {
  try {
    return JSON.parse(Buffer.from(cursor, "base64").toString("utf-8"));
  } catch {
    return null;
  }
}

export class OrganizationRepository {
  async findById(id: string): Promise<Organization | null> {
    return prisma.organization.findUnique({
      where: { id },
    });
  }

  async findMany(skip: number, take: number, search?: string): Promise<Organization[]> {
    const where = search ? {
      OR: [
        { id: { contains: search, mode: 'insensitive' as const } },
        { name: { contains: search, mode: 'insensitive' as const } },
      ],
    } : {};

    return prisma.organization.findMany({
      where,
      skip,
      take,
      orderBy: { createdAt: "desc" },
    });
  }

  async findManyCursor(
    cursor: string | undefined,
    limit: number,
    search?: string
  ): Promise<{
    data: Organization[];
    hasNextPage: boolean;
    hasPrevPage: boolean;
  }> {
    const where = search ? {
      OR: [
        { id: { contains: search, mode: 'insensitive' as const } },
        { name: { contains: search, mode: 'insensitive' as const } },
      ],
    } : {};

    let prismaCursor: { createdAt: Date; id: string } | undefined;
    const decodedCursor = cursor ? decodeCursor(cursor) : null;
    if (decodedCursor) {
      prismaCursor = {
        createdAt: new Date(decodedCursor.createdAt),
        id: decodedCursor.id,
      };
    }

    const take = limit + 1; // Fetch one extra to check for next page

    const results = await prisma.organization.findMany({
      where,
      take,
      ...(prismaCursor ? { cursor: { createdAt_id: prismaCursor } } : {}),
      skip: prismaCursor ? 1 : 0,
      orderBy: { createdAt: "desc" },
    });

    const hasNextPage = results.length > limit;
    const data = hasNextPage ? results.slice(0, -1) : results;

    // For hasPrevPage, we can check if there's any item before the cursor
    // For simplicity, we'll set it to false here, but you can add a count if needed
    const hasPrevPage = !!prismaCursor;

    return { data, hasNextPage, hasPrevPage };
  }

  static encodeCursor(org: Organization): string {
    return encodeCursor({
      createdAt: org.createdAt.toISOString(),
      id: org.id,
    });
  }

  async count(search?: string): Promise<number> {
    const where = search ? {
      OR: [
        { id: { contains: search, mode: 'insensitive' as const } },
        { name: { contains: search, mode: 'insensitive' as const } },
      ],
    } : {};

    return prisma.organization.count({ where });
  }

  async upsert(id: string, name: string, admin: string): Promise<Organization> {
    return prisma.organization.upsert({
      where: { id },
      update: { name, admin },
      create: { id, name, admin },
    });
  }
}

export const organizationRepository = new OrganizationRepository();

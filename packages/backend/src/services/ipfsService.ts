import axios from 'axios';
import FormData from 'form-data';
import { logger } from '../utils/logger.js';

/**
 * Service to handle metadata uploads to IPFS.
 * This implementation uses Pinata as the IPFS provider.
 */
export class IpfsService {
  private readonly pinataUrl = 'https://api.pinata.cloud/pinning/pinFileToIPFS';
  private readonly apiKey = process.env['PINATA_API_KEY'];
  private readonly secretKey = process.env['PINATA_SECRET_API_KEY'];

  /**
   * Uploads organization metadata (logo and description) to IPFS.
   * 
   * @param name - Organization name
   * @param description - Organization description
   * @param logoBase64 - Optional base64 encoded logo image
   * @returns The IPFS Content Identifier (CID)
   */
  async uploadOrgMetadata(
    name: string,
    description: string,
    logoBase64?: string
  ): Promise<string> {
    if (!this.apiKey || !this.secretKey) {
      throw new Error('IPFS provider credentials (PINATA_API_KEY) are not configured.');
    }

    const metadata = {
      name,
      description,
      logo: logoBase64,
      version: "1.0",
      updatedAt: new Date().toISOString(),
    };

    const data = new FormData();
    const buffer = Buffer.from(JSON.stringify(metadata));
    data.append('file', buffer, { filename: 'metadata.json' });

    try {
      const response = await axios.post(this.pinataUrl, data, {
        headers: {
          ...data.getHeaders(),
          'pinata_api_key': this.apiKey,
          'pinata_secret_api_key': this.secretKey,
        },
      });

      const cid = response.data.IpfsHash;
      logger.info({ name, cid }, 'Uploaded organization metadata to IPFS');
      return cid;
    } catch (error) {
      logger.error({ err: error, name }, 'Failed to upload organization metadata to IPFS');
      throw error;
    }
  }
}

export const ipfsService = new IpfsService();
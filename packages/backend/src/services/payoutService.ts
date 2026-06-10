import { stellarService } from "./stellarService.js";

export class PayoutService {
  async getClaimableBalance(maintainerAddress: string) {
    const stroops = await stellarService.readClaimableBalance(maintainerAddress);
    const xlm = (Number(stroops) / 10_000_000).toFixed(7);
    return {
      maintainer: maintainerAddress,
      claimableStroops: stroops.toString(),
      claimableXlm: xlm,
    };
  }

  async fundOrg(
    orgId: string,
    fromAddress: string,
    amountStroops: string,
    signerSecret: string
  ) {
    return stellarService.fundOrg(
      orgId,
      fromAddress,
      BigInt(amountStroops),
      signerSecret
    );
  }

  async allocatePayout(
    orgId: string,
    maintainerAddress: string,
    amountStroops: string,
    signerSecret: string
  ) {
    return stellarService.allocatePayout(
      orgId,
      maintainerAddress,
      BigInt(amountStroops),
      signerSecret
    );
  }
}

export const payoutService = new PayoutService();

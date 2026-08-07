import { Suspense } from "react";
import { xdr } from "@stellar/stellar-sdk";
import {
  XdrOperationCard,
  type DecodedOperation,
  type OperationType,
} from "./XdrOperationCard";
import {
  XdrEnvelopeErrorBoundary,
  XdrStreamErrorBoundary,
} from "./XdrStreamErrorBoundary";
import { HeaderSkeleton, OperationSkeleton } from "./XdrStreamSkeletons";

function decodeOperationType(opType: xdr.OperationType): OperationType {
  const map: Partial<Record<string, OperationType>> = {
    invokeContract: "invoke_contract",
    createAccount: "create_account",
    payment: "payment",
    pathPaymentStrictReceive: "path_payment_strict_receive",
    pathPaymentStrictSend: "path_payment_strict_send",
    manageSellOffer: "manage_sell_offer",
    manageBuyOffer: "manage_buy_offer",
    createPassiveSellOffer: "create_passive_sell_offer",
    setOptions: "set_options",
    changeTrust: "change_trust",
    allowTrust: "allow_trust",
    accountMerge: "account_merge",
    manageData: "manage_data",
    bumpSequence: "bump_sequence",
    createClaimableBalance: "create_claimable_balance",
    claimClaimableBalance: "claim_claimable_balance",
    beginSponsoringFutureReserves: "begin_sponsoring_future_reserves",
    endSponsoringFutureReserves: "end_sponsoring_future_reserves",
    revokeSponsorship: "revoke_sponsorship",
    clawback: "clawback",
    clawbackClaimableBalance: "clawback_claimable_balance",
    setTrustLineFlags: "set_trust_line_flags",
    liquidityPoolDeposit: "liquidity_pool_deposit",
    liquidityPoolWithdraw: "liquidity_pool_withdraw",
    invokeHostFunction: "invoke_host_function",
    extendFootprintTtl: "extend_footprint_ttl",
    restoreFootprint: "restore_footprint",
  };
  const name = opType.name ?? String(opType);
  return map[name] ?? "unknown";
}

function formatAddress(scAddress: xdr.ScAddress): string {
  if (scAddress.switch() === xdr.ScAddressType.scAddressTypeAccount()) {
    const accountId = scAddress.accountId();
    return accountId.ed25519()?.toString("hex") ?? accountId.toString();
  }
  const contractId = scAddress.contractId();
  return contractId ? `contract:${contractId.toString("hex")}` : "unknown";
}

function decodeScVal(val: xdr.ScVal): string {
  const fallback = val.toXDR("base64");
  try {
    switch (val.switch()) {
      case xdr.ScValType.scvBool():
        return String(val.b());
      case xdr.ScValType.scvVoid():
        return "void";
      case xdr.ScValType.scvU32():
        return String(val.u32());
      case xdr.ScValType.scvI32():
        return String(val.i32());
      case xdr.ScValType.scvU64():
        return val.u64().toString();
      case xdr.ScValType.scvI64():
        return val.i64().toString();
      case xdr.ScValType.scvU128(): {
        const parts = val.u128();
        const hi = BigInt(parts.hi());
        const lo = BigInt(parts.lo());
        return ((hi << BigInt(64)) + lo).toString();
      }
      case xdr.ScValType.scvI128(): {
        const parts = val.i128();
        const hi = BigInt(parts.hi());
        const lo = BigInt(parts.lo());
        return ((hi << BigInt(64)) + lo).toString();
      }
      case xdr.ScValType.scvBytes():
        return val.bytes().toString("hex");
      case xdr.ScValType.scvString():
        return val.str().toString("utf-8");
      case xdr.ScValType.scvSymbol():
        return val.sym().toString("utf-8");
      case xdr.ScValType.scvAddress():
        return formatAddress(val.address());
      case xdr.ScValType.scvBytesN():
        return val.bytesN().toString("hex");
      case xdr.ScValType.scvTimepoint():
        return String(val.timepoint());
      case xdr.ScValType.scvDuration():
        return String(val.duration());
      default:
        return fallback.slice(0, 64) + (fallback.length > 64 ? "..." : "");
    }
  } catch {
    return fallback;
  }
}

function decodeInvokeContractArgs(args: xdr.InvokeContractArgs): {
  contract: string;
  function: string;
  args: { type: string; value: string }[];
} {
  const contract = formatAddress(args.contractAddress());
  const fn = args.functionName().toString("utf-8");
  const decodedArgs = args.args().map((arg) => ({
    type: arg.switch().name ?? `ScVal(${arg.switch()})`,
    value: decodeScVal(arg),
  }));
  return { contract, function: fn, args: decodedArgs };
}

function decodeInvokeHostFunctionArgs(args: xdr.InvokeHostFunctionArgs): {
  hostFunctions: string[];
  auth: string[];
} {
  const fns = args.hostFunctions().map((fn) => {
    if (fn.switch() === xdr.HostFunctionType.hostFunctionTypeInvokeContract()) {
      const invoke = fn.invokeContract();
      return `invoke(${formatAddress(invoke.contractAddress())}.${invoke.functionName().toString("utf-8")})`;
    }
    return fn.switch().name ?? "unknown";
  });
  const auth = args.auth().map((a) => {
    return `auth(cred:${a.cred().switch().name})`;
  });
  return { hostFunctions: fns, auth };
}

function decodeOperation(op: xdr.Operation, index: number): DecodedOperation {
  const body = op.body();
  const opType = decodeOperationType(body.switch());
  const details: Record<string, string> = {};
  let contractArgs: DecodedOperation["contractArgs"] = undefined;
  let sorobanData: string | undefined = undefined;

  switch (body.switch()) {
    case xdr.OperationType.invokeContract(): {
      const args = body.invokeContractArgs();
      const decoded = decodeInvokeContractArgs(args);
      details["contract"] = decoded.contract;
      details["function"] = decoded.function;
      contractArgs = decoded.args;
      break;
    }
    case xdr.OperationType.createAccount(): {
      const args = body.createAccountOp();
      details["destination"] = args.destination().toString();
      details["starting_balance"] = args.startingBalance().toString();
      break;
    }
    case xdr.OperationType.payment(): {
      const args = body.paymentOp();
      details["destination"] = formatAddress(args.destination());
      details["asset"] = args.asset().isNative()
        ? "XLM"
        : `${args.asset().getCode()}:${args.asset().getIssuer().toString().slice(0, 8)}...`;
      details["amount"] = args.amount().toString();
      break;
    }
    case xdr.OperationType.manageSellOffer(): {
      const args = body.manageSellOfferOp();
      details["selling"] = args.selling().isNative()
        ? "XLM"
        : args.selling().getCode();
      details["buying"] = args.buying().isNative()
        ? "XLM"
        : args.buying().getCode();
      details["amount"] = args.amount().toString();
      details["price"] = `${args.price().n()}/${args.price().d()}`;
      details["offer_id"] = args.offerId().toString();
      break;
    }
    case xdr.OperationType.manageBuyOffer(): {
      const args = body.manageBuyOfferOp();
      details["selling"] = args.selling().isNative()
        ? "XLM"
        : args.selling().getCode();
      details["buying"] = args.buying().isNative()
        ? "XLM"
        : args.buying().getCode();
      details["amount"] = args.amount().toString();
      details["price"] = `${args.price().n()}/${args.price().d()}`;
      details["offer_id"] = args.offerId().toString();
      break;
    }
    case xdr.OperationType.setOptions(): {
      const args = body.setOptionsOp();
      if (args.homeDomain())
        details["home_domain"] = args.homeDomain()!.toString("utf-8");
      if (args.signer()) {
        const signer = args.signer()!;
        details["signer_type"] = signer.ed25519() ? "ed25519" : "preAuthTx";
      }
      if (args.inflationDest())
        details["inflation_dest"] = args.inflationDest()!.toString();
      if (args.setFlags()) details["set_flags"] = String(args.setFlags());
      if (args.clearFlags()) details["clear_flags"] = String(args.clearFlags());
      break;
    }
    case xdr.OperationType.changeTrust(): {
      const args = body.changeTrustOp();
      const asset = args.line();
      details["asset"] = asset.isNative() ? "XLM" : asset.getCode();
      details["limit"] = args.limit().toString();
      break;
    }
    case xdr.OperationType.accountMerge(): {
      details["destination"] = formatAddress(body.destination());
      break;
    }
    case xdr.OperationType.manageData(): {
      const args = body.manageDataOp();
      details["name"] = args.dataName().toString("utf-8");
      if (args.dataValue()) {
        details["value"] = args.dataValue()!.toString("hex");
      } else {
        details["action"] = "remove";
      }
      break;
    }
    case xdr.OperationType.bumpSequence(): {
      details["bump_to"] = body.bumpSequenceOp().bumpTo().toString();
      break;
    }
    case xdr.OperationType.invokeHostFunction(): {
      const args = body.invokeHostFunctionOp();
      const decoded = decodeInvokeHostFunctionArgs(args);
      details["functions"] = decoded.hostFunctions.join(", ");
      if (decoded.auth.length) details["auth"] = decoded.auth.join(", ");
      if (args.extendedSorobanContractData()) {
        const data = args.extendedSorobanContractData()!;
        details["contract"] = formatAddress(data.contract());
        details["durability"] = data.durability().name ?? "temporary";
        sorobanData = data.contractData().toXDR("base64");
      }
      break;
    }
    case xdr.OperationType.extendFootprintTtl(): {
      details["extend_to"] = body.extendFootprintTtlOp().extendTo().toString();
      break;
    }
    case xdr.OperationType.restoreFootprint(): {
      details["note"] = "Restores expired ledger entries";
      break;
    }
    default:
      details["raw_type"] = body.switch().name ?? "unknown";
      break;
  }

  return { type: opType, index, details, contractArgs, sorobanData };
}

function TransactionHeader({
  envelope,
  operationCount,
  source,
  fee,
}: {
  envelope: xdr.TransactionEnvelope;
  operationCount: number;
  source: string;
  fee: string;
}) {
  const feeXlm = (Number(BigInt(fee)) / 10_000_000).toFixed(7);

  return (
    <div className="animate-fade-in rounded-2xl border border-white/10 bg-white/5 p-5">
      <div className="flex items-center gap-3 mb-4">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-stellar-purple/20 text-sm">
          📋
        </span>
        <span className="text-sm font-semibold text-white">
          Transaction Envelope
        </span>
        <span className="ml-auto rounded-full border border-white/10 bg-white/5 px-2.5 py-0.5 text-xs text-white/50">
          {envelope.switch().name?.replace(/_/g, " ") ?? "unknown type"}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div>
          <span className="block text-[11px] font-medium uppercase tracking-wider text-white/40">
            Source
          </span>
          <span className="font-mono text-xs text-white/80">
            {source.length > 16
              ? `${source.slice(0, 8)}...${source.slice(-6)}`
              : source}
          </span>
        </div>
        <div>
          <span className="block text-[11px] font-medium uppercase tracking-wider text-white/40">
            Fee
          </span>
          <span className="font-mono text-xs text-white/80">{feeXlm} XLM</span>
        </div>
        <div>
          <span className="block text-[11px] font-medium uppercase tracking-wider text-white/40">
            Operations
          </span>
          <span className="font-mono text-xs text-white/80">
            {operationCount}
          </span>
        </div>
        <div>
          <span className="block text-[11px] font-medium uppercase tracking-wider text-white/40">
            Network
          </span>
          <span className="font-mono text-xs text-white/80">
            {envelope.switch().name?.includes("soroban")
              ? "Soroban"
              : "Classic"}
          </span>
        </div>
      </div>
    </div>
  );
}

async function StreamedOperation({
  operation,
  index,
}: {
  operation: xdr.Operation;
  index: number;
}) {
  const decoded = decodeOperation(operation, index);

  return (
    <XdrStreamErrorBoundary operationIndex={index}>
      <XdrOperationCard operation={decoded} />
    </XdrStreamErrorBoundary>
  );
}

interface XdrStreamServerProps {
  xdr: string;
}

export async function XdrStreamServer({
  xdr: xdrBase64,
}: XdrStreamServerProps) {
  let envelope: xdr.TransactionEnvelope;

  try {
    envelope = xdr.TransactionEnvelope.fromXDR(xdrBase64, "base64");
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to decode XDR envelope";
    throw new Error(`Invalid XDR: ${message}`);
  }

  const envelopeType = envelope.switch();
  let tx: xdr.Transaction;

  if (envelopeType === xdr.EnvelopeType.envelopeTypeTxV0()) {
    tx = envelope.v0().tx();
  } else if (envelopeType === xdr.EnvelopeType.envelopeTypeTx()) {
    tx = envelope.v1().tx();
  } else if (
    envelopeType === xdr.EnvelopeType.envelopeTypeSoroban() ||
    envelopeType === xdr.EnvelopeType.envelopeTypeSorobanCreation()
  ) {
    tx = envelope.soroban()?.tx() ?? envelope.v1().tx();
  } else {
    tx = envelope.v1()?.tx() ?? envelope.v0()?.tx();
  }

  const operations = tx.operations();
  const source = tx.sourceAccount().toString();
  const fee = tx.fee().toString();

  return (
    <XdrEnvelopeErrorBoundary xdr={xdrBase64}>
      <div className="space-y-4">
        <Suspense fallback={<HeaderSkeleton />}>
          <TransactionHeader
            envelope={envelope}
            operationCount={operations.length}
            source={source}
            fee={fee}
          />
        </Suspense>

        <div className="flex flex-wrap items-center gap-3 text-xs text-white/50">
          <span>
            {operations.length} operation{operations.length !== 1 ? "s" : ""}{" "}
            parsed
          </span>
          <span className="text-white/20">·</span>
          <span>
            Decoded server-side — 0 KB XDR libraries shipped to client
          </span>
        </div>

        {operations.map((op, i) => (
          <Suspense key={i} fallback={<OperationSkeleton />}>
            <StreamedOperation operation={op} index={i} />
          </Suspense>
        ))}
      </div>
    </XdrEnvelopeErrorBoundary>
  );
}

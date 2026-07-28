"use client";

import { useState } from "react";
import { useUnifiedWallet } from "@/hooks/useUnifiedWallet";
import { GlassButton } from "@/components/GlassButton";
import { sortAndBuildBatchTransaction } from "@/utils/xdrWorkerManager";
import { OperationIntent } from "@/utils/dagSorter";
import { Networks } from "@stellar/stellar-sdk";
import toast from "react-hot-toast";
import { submitSignedTransaction } from "@/lib/sorobanClient";

const CONTRACT_ID = process.env.NEXT_PUBLIC_CONTRACT_ID || "CCWPMAC2IR4CC4COY3LQQC2NQQ4UQQ4NQQ4UQQ4NQQ4UQQ4NQQ4UQQ4N";
const NETWORK_PASSPHRASE = process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE || Networks.TESTNET;
const HORIZON_URL = process.env.NEXT_PUBLIC_HORIZON_URL || "https://horizon-testnet.stellar.org";

export default function BatchOperationsPage() {
  const { isConnected, publicKey, signTransaction } = useUnifiedWallet();

  const [intents, setIntents] = useState<OperationIntent[]>([]);
  const [sortedIntents, setSortedIntents] = useState<OperationIntent[]>([]);
  const [generatedXdr, setGeneratedXdr] = useState<string | null>(null);
  const [sortingError, setSortingError] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Form State
  const [opId, setOpId] = useState("");
  const [opType, setOpType] = useState<OperationIntent["type"]>("fund_org");
  const [dependenciesStr, setDependenciesStr] = useState("");
  
  // Op-specific params
  const [orgId, setOrgId] = useState("stellar");
  const [fromAddress, setFromAddress] = useState("");
  const [amountStroops, setAmountStroops] = useState("50000000"); // 5 XLM
  const [userAddress, setUserAddress] = useState("");
  const [adminAddress, setAdminAddress] = useState("");
  const [maintainerAddress, setMaintainerAddress] = useState("");
  const [metadataCid, setMetadataCid] = useState("QmXoyp1eg2fodz6TXDWuzCwABjRLJnrwcia4h18E7V8JvK");

  // Autofill current wallet address when connected
  const handleAutofillAddresses = () => {
    if (!publicKey) return;
    setFromAddress(publicKey);
    setUserAddress(publicKey);
    setAdminAddress(publicKey);
    setMaintainerAddress(publicKey);
  };

  const handleAddOperation = (e: React.FormEvent) => {
    e.preventDefault();
    const cleanId = opId.trim();
    if (!cleanId) {
      toast.error("Operation ID is required");
      return;
    }
    if (intents.some(i => i.id === cleanId)) {
      toast.error(`Operation ID "${cleanId}" already exists`);
      return;
    }

    let params: any = {};
    if (opType === "fund_org") {
      params = { orgId, fromAddress, amountStroops };
    } else if (opType === "claim_payout") {
      params = { userAddress };
    } else if (opType === "allocate_payout") {
      params = { adminAddress, orgId, maintainerAddress, amountStroops };
    } else if (opType === "update_org_metadata") {
      params = { adminAddress, orgId, metadataCid };
    }

    const dependencies = dependenciesStr
      .split(",")
      .map(d => d.trim())
      .filter(d => d.length > 0);

    const newIntent: OperationIntent = {
      id: cleanId,
      type: opType,
      params,
      dependencies,
    };

    setIntents(prev => [...prev, newIntent]);
    setOpId("");
    setDependenciesStr("");
    toast.success(`Operation "${cleanId}" added!`);
  };

  const handleRemoveOperation = (id: string) => {
    setIntents(prev => prev.filter(i => i.id !== id));
    toast.success(`Operation "${id}" removed`);
  };

  const loadLinearDemo = () => {
    const pk = publicKey || "GBRPYHIL2CIW2GIZ2654QCE5A6AOBAX7RLIXRRMMQAQX66A7KCDUOS64";
    const demo: OperationIntent[] = [
      {
        id: "fund_step",
        type: "fund_org",
        params: { orgId: "stellar", fromAddress: pk, amountStroops: "100000000" },
        dependencies: [],
      },
      {
        id: "allocate_step",
        type: "allocate_payout",
        params: { adminAddress: pk, orgId: "stellar", maintainerAddress: pk, amountStroops: "50000000" },
        dependencies: ["fund_step"],
      },
      {
        id: "claim_step",
        type: "claim_payout",
        params: { userAddress: pk },
        dependencies: ["allocate_step"],
      },
    ];
    setIntents(demo);
    setSortedIntents([]);
    setGeneratedXdr(null);
    setSortingError(null);
    toast.success("Loaded Linear Demo");
  };

  const loadBranchingDemo = () => {
    const pk = publicKey || "GBRPYHIL2CIW2GIZ2654QCE5A6AOBAX7RLIXRRMMQAQX66A7KCDUOS64";
    const demo: OperationIntent[] = [
      {
        id: "update_meta",
        type: "update_org_metadata",
        params: { adminAddress: pk, orgId: "stellar", metadataCid: "QmXoyp1eg2fo..." },
        dependencies: ["fund_step"],
      },
      {
        id: "claim_step",
        type: "claim_payout",
        params: { userAddress: pk },
        dependencies: ["allocate_step"],
      },
      {
        id: "allocate_step",
        type: "allocate_payout",
        params: { adminAddress: pk, orgId: "stellar", maintainerAddress: pk, amountStroops: "25000000" },
        dependencies: ["fund_step"],
      },
      {
        id: "fund_step",
        type: "fund_org",
        params: { orgId: "stellar", fromAddress: pk, amountStroops: "80000000" },
        dependencies: [],
      },
    ];
    setIntents(demo);
    setSortedIntents([]);
    setGeneratedXdr(null);
    setSortingError(null);
    toast.success("Loaded Branching Demo");
  };

  const loadCyclicDemo = () => {
    const pk = publicKey || "GBRPYHIL2CIW2GIZ2654QCE5A6AOBAX7RLIXRRMMQAQX66A7KCDUOS64";
    const demo: OperationIntent[] = [
      {
        id: "task_A",
        type: "fund_org",
        params: { orgId: "stellar", fromAddress: pk, amountStroops: "10000000" },
        dependencies: ["task_B"],
      },
      {
        id: "task_B",
        type: "allocate_payout",
        params: { adminAddress: pk, orgId: "stellar", maintainerAddress: pk, amountStroops: "5000000" },
        dependencies: ["task_A"],
      },
    ];
    setIntents(demo);
    setSortedIntents([]);
    setGeneratedXdr(null);
    setSortingError(null);
    toast.success("Loaded Cyclic Error Demo");
  };

  const handleBuildTransaction = async () => {
    if (intents.length === 0) {
      toast.error("Please add at least one operation to build a transaction");
      return;
    }
    if (!publicKey) {
      toast.error("Please connect your wallet first");
      return;
    }

    setIsProcessing(true);
    setSortingError(null);
    setGeneratedXdr(null);
    setSortedIntents([]);

    try {
      // 1. Fetch current sequence number of connected account from Horizon
      const response = await fetch(`${HORIZON_URL}/accounts/${publicKey}`);
      if (!response.ok) {
        throw new Error(`Failed to fetch account info from Horizon. Ensure ${publicKey} is active on Testnet.`);
      }
      const accountData = await response.json();
      const sequenceNumber = accountData.sequence;

      // 2. Delegate topological sorting and XDR building to Web Worker (off-main-thread)
      const result = await sortAndBuildBatchTransaction({
        intents,
        sourceAccount: publicKey,
        sequenceNumber,
        networkPassphrase: NETWORK_PASSPHRASE,
        contractId: CONTRACT_ID,
      });

      setGeneratedXdr(result.xdr);
      setSortedIntents(result.sortedIntents);
      toast.success("Successfully sorted and built transaction off-main-thread!");
    } catch (err: any) {
      console.error(err);
      setSortingError(err.message || "Failed to process batch operations.");
      toast.error("Process failed. See error output.");
    } finally {
      setIsProcessing(false);
    }
  };

  const handleSubmit = async () => {
    if (!generatedXdr) return;
    setIsSubmitting(true);
    try {
      const signedXdr = await signTransaction(generatedXdr);
      await submitSignedTransaction(signedXdr);
      toast.success("Batch transaction confirmed successfully on-chain!");
      setGeneratedXdr(null);
      setSortedIntents([]);
      setIntents([]);
    } catch (err: any) {
      console.error(err);
      toast.error(err.message || "Transaction submission failed");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="space-y-8 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between border-b border-white/10 pb-6">
        <div>
          <h1 className="text-3xl font-bold text-white tracking-tight">Batch Transaction Builder</h1>
          <p className="mt-2 text-white/60 text-sm">
            Topologically sort and execute Web3 operations off-main-thread via Web Worker.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={loadLinearDemo}
            className="rounded-lg bg-white/5 border border-white/10 hover:bg-white/10 px-3 py-1.5 text-xs text-white/80 transition-all"
          >
            Linear Demo
          </button>
          <button
            onClick={loadBranchingDemo}
            className="rounded-lg bg-white/5 border border-white/10 hover:bg-white/10 px-3 py-1.5 text-xs text-white/80 transition-all"
          >
            Branching Demo
          </button>
          <button
            onClick={loadCyclicDemo}
            className="rounded-lg bg-red-500/10 border border-red-500/20 hover:bg-red-500/20 px-3 py-1.5 text-xs text-red-300 transition-all"
          >
            Cyclic Error Demo
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        {/* Left Column: Build Operations */}
        <div className="lg:col-span-7 space-y-6">
          <div className="glass-card p-6">
            <h2 className="text-lg font-semibold text-white mb-4">Add Operation</h2>
            <form onSubmit={handleAddOperation} className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-white/50 uppercase tracking-wider mb-2">
                    Operation ID
                  </label>
                  <input
                    type="text"
                    value={opId}
                    onChange={(e) => setOpId(e.target.value)}
                    placeholder="e.g. step_1"
                    className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-white text-sm outline-none focus:border-stellar-purple/50"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-white/50 uppercase tracking-wider mb-2">
                    Type
                  </label>
                  <select
                    value={opType}
                    onChange={(e) => setOpType(e.target.value as any)}
                    className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-white text-sm outline-none focus:border-stellar-purple/50"
                  >
                    <option value="fund_org" className="bg-stellar-blue">Fund Organization</option>
                    <option value="allocate_payout" className="bg-stellar-blue">Allocate Payout</option>
                    <option value="claim_payout" className="bg-stellar-blue">Claim Payout</option>
                    <option value="update_org_metadata" className="bg-stellar-blue">Update Metadata</option>
                  </select>
                </div>
              </div>

              {/* Dynamic Parameter Fields */}
              {opType === "fund_org" && (
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 border-t border-white/5 pt-4">
                  <div>
                    <label className="block text-xs text-white/60 mb-1">Org ID</label>
                    <input
                      type="text"
                      value={orgId}
                      onChange={(e) => setOrgId(e.target.value)}
                      className="w-full px-3 py-1.5 rounded bg-white/5 border border-white/10 text-white text-xs"
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <label className="block text-xs text-white/60 mb-1 flex justify-between">
                      <span>From Address</span>
                      {publicKey && (
                        <button type="button" onClick={handleAutofillAddresses} className="text-stellar-purple hover:underline">
                          Autofill
                        </button>
                      )}
                    </label>
                    <input
                      type="text"
                      value={fromAddress}
                      onChange={(e) => setFromAddress(e.target.value)}
                      placeholder="G..."
                      className="w-full px-3 py-1.5 rounded bg-white/5 border border-white/10 text-white text-xs font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-white/60 mb-1">Amount (Stroops)</label>
                    <input
                      type="text"
                      value={amountStroops}
                      onChange={(e) => setAmountStroops(e.target.value)}
                      className="w-full px-3 py-1.5 rounded bg-white/5 border border-white/10 text-white text-xs"
                    />
                  </div>
                </div>
              )}

              {opType === "claim_payout" && (
                <div className="border-t border-white/5 pt-4">
                  <label className="block text-xs text-white/60 mb-1 flex justify-between">
                    <span>User Address</span>
                    {publicKey && (
                      <button type="button" onClick={handleAutofillAddresses} className="text-stellar-purple hover:underline">
                        Autofill
                      </button>
                    )}
                  </label>
                  <input
                    type="text"
                    value={userAddress}
                    onChange={(e) => setUserAddress(e.target.value)}
                    placeholder="G..."
                    className="w-full px-3 py-1.5 rounded bg-white/5 border border-white/10 text-white text-xs font-mono"
                  />
                </div>
              )}

              {opType === "allocate_payout" && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 border-t border-white/5 pt-4">
                  <div>
                    <label className="block text-xs text-white/60 mb-1 flex justify-between">
                      <span>Admin Address</span>
                      {publicKey && (
                        <button type="button" onClick={handleAutofillAddresses} className="text-stellar-purple hover:underline">
                          Autofill
                        </button>
                      )}
                    </label>
                    <input
                      type="text"
                      value={adminAddress}
                      onChange={(e) => setAdminAddress(e.target.value)}
                      placeholder="G..."
                      className="w-full px-3 py-1.5 rounded bg-white/5 border border-white/10 text-white text-xs font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-white/60 mb-1">Org ID</label>
                    <input
                      type="text"
                      value={orgId}
                      onChange={(e) => setOrgId(e.target.value)}
                      className="w-full px-3 py-1.5 rounded bg-white/5 border border-white/10 text-white text-xs"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-white/60 mb-1 flex justify-between">
                      <span>Maintainer Address</span>
                      {publicKey && (
                        <button type="button" onClick={handleAutofillAddresses} className="text-stellar-purple hover:underline">
                          Autofill
                        </button>
                      )}
                    </label>
                    <input
                      type="text"
                      value={maintainerAddress}
                      onChange={(e) => setMaintainerAddress(e.target.value)}
                      placeholder="G..."
                      className="w-full px-3 py-1.5 rounded bg-white/5 border border-white/10 text-white text-xs font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-white/60 mb-1">Amount (Stroops)</label>
                    <input
                      type="text"
                      value={amountStroops}
                      onChange={(e) => setAmountStroops(e.target.value)}
                      className="w-full px-3 py-1.5 rounded bg-white/5 border border-white/10 text-white text-xs"
                    />
                  </div>
                </div>
              )}

              {opType === "update_org_metadata" && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 border-t border-white/5 pt-4">
                  <div>
                    <label className="block text-xs text-white/60 mb-1 flex justify-between">
                      <span>Admin Address</span>
                      {publicKey && (
                        <button type="button" onClick={handleAutofillAddresses} className="text-stellar-purple hover:underline">
                          Autofill
                        </button>
                      )}
                    </label>
                    <input
                      type="text"
                      value={adminAddress}
                      onChange={(e) => setAdminAddress(e.target.value)}
                      placeholder="G..."
                      className="w-full px-3 py-1.5 rounded bg-white/5 border border-white/10 text-white text-xs font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-white/60 mb-1">Org ID</label>
                    <input
                      type="text"
                      value={orgId}
                      onChange={(e) => setOrgId(e.target.value)}
                      className="w-full px-3 py-1.5 rounded bg-white/5 border border-white/10 text-white text-xs"
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <label className="block text-xs text-white/60 mb-1">Metadata IPFS CID</label>
                    <input
                      type="text"
                      value={metadataCid}
                      onChange={(e) => setMetadataCid(e.target.value)}
                      className="w-full px-3 py-1.5 rounded bg-white/5 border border-white/10 text-white text-xs font-mono"
                    />
                  </div>
                </div>
              )}

              <div className="border-t border-white/5 pt-4">
                <label className="block text-xs font-semibold text-white/50 uppercase tracking-wider mb-2">
                  Dependencies (comma-separated IDs)
                </label>
                <input
                  type="text"
                  value={dependenciesStr}
                  onChange={(e) => setDependenciesStr(e.target.value)}
                  placeholder="e.g. fund_step, update_meta"
                  className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-white text-sm outline-none focus:border-stellar-purple/50"
                />
              </div>

              <GlassButton variant="primary" type="submit" className="w-full">
                Add to Batch List
              </GlassButton>
            </form>
          </div>

          {/* List of operations */}
          <div className="glass-card p-6">
            <h2 className="text-lg font-semibold text-white mb-4">Operations in Batch ({intents.length})</h2>
            {intents.length === 0 ? (
              <div className="text-center py-10 border border-dashed border-white/10 rounded-xl">
                <p className="text-sm text-white/40">No operations added to this batch yet.</p>
              </div>
            ) : (
              <div className="space-y-4">
                {intents.map((intent) => (
                  <div key={intent.id} className="p-4 bg-white/5 rounded-xl border border-white/10 flex justify-between items-start">
                    <div>
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-mono text-sm font-semibold text-white">{intent.id}</span>
                        <span className="badge border border-stellar-teal/30 bg-stellar-teal/10 text-stellar-teal uppercase text-[10px]">
                          {intent.type.replace("_", " ")}
                        </span>
                      </div>
                      <div className="text-xs text-white/40 font-mono break-all max-w-md">
                        {JSON.stringify(intent.params)}
                      </div>
                      {intent.dependencies.length > 0 && (
                        <div className="mt-2 text-[11px] text-stellar-purple">
                          Depends on: <span className="font-mono">{intent.dependencies.join(", ")}</span>
                        </div>
                      )}
                    </div>
                    <button
                      onClick={() => handleRemoveOperation(intent.id)}
                      className="text-xs text-red-400 hover:text-red-300 transition-colors p-1"
                    >
                      Delete
                    </button>
                  </div>
                ))}

                <GlassButton
                  variant="secondary"
                  onClick={handleBuildTransaction}
                  disabled={isProcessing}
                  className="w-full mt-4"
                >
                  {isProcessing ? "Sorting & Building..." : "Sort & Build Batch Transaction"}
                </GlassButton>
              </div>
            )}
          </div>
        </div>

        {/* Right Column: Execution Output */}
        <div className="lg:col-span-5 space-y-6">
          <div className="glass-card p-6 min-h-[300px] flex flex-col">
            <h2 className="text-lg font-semibold text-white mb-4">Worker Sorting & Build Engine</h2>

            {isProcessing && (
              <div className="flex-1 flex flex-col items-center justify-center space-y-4">
                <div className="h-8 w-8 animate-spin rounded-full border-4 border-stellar-purple/30 border-t-stellar-purple" />
                <p className="text-sm text-white/60">Sorting intents & building XDR off-main-thread...</p>
              </div>
            )}

            {!isProcessing && !generatedXdr && !sortingError && (
              <div className="flex-1 flex flex-col items-center justify-center text-center py-12">
                <span className="text-3xl mb-3">⚙️</span>
                <p className="text-sm text-white/50">Add operations, setup dependencies, and trigger the builder to run the worker process.</p>
              </div>
            )}

            {/* Error output */}
            {sortingError && (
              <div className="flex-1 rounded-xl border border-red-500/30 bg-red-500/10 p-4 space-y-2">
                <h3 className="text-sm font-semibold text-red-400">Topological Sorting Failed</h3>
                <p className="text-xs text-red-300 font-mono leading-relaxed">{sortingError}</p>
              </div>
            )}

            {/* Success output */}
            {generatedXdr && (
              <div className="flex-1 flex flex-col space-y-6">
                <div>
                  <h3 className="text-xs font-semibold text-white/50 uppercase tracking-wider mb-3">
                    Sorted Execution Path
                  </h3>
                  <div className="space-y-3 relative before:absolute before:left-3 before:top-2 before:bottom-2 before:w-[2px] before:bg-white/10">
                    {sortedIntents.map((intent, idx) => (
                      <div key={intent.id} className="flex items-start gap-4 relative pl-8">
                        <span className="absolute left-0 top-0.5 w-6 h-6 rounded-full bg-stellar-purple/20 border border-stellar-purple text-[10px] text-stellar-purple flex items-center justify-center font-bold">
                          {idx + 1}
                        </span>
                        <div>
                          <div className="font-mono text-sm text-white">{intent.id}</div>
                          <div className="text-xs text-white/40 capitalize">{intent.type.replace("_", " ")}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <div>
                  <h3 className="text-xs font-semibold text-white/50 uppercase tracking-wider mb-2">
                    Zero-Copy Transferred Transaction XDR
                  </h3>
                  <div className="relative">
                    <pre className="p-3 bg-black/40 rounded-lg text-[10px] font-mono text-white/80 overflow-x-auto break-all max-h-32 border border-white/5">
                      {generatedXdr}
                    </pre>
                    <button
                      onClick={() => {
                        navigator.clipboard.writeText(generatedXdr);
                        toast.success("XDR copied to clipboard");
                      }}
                      className="absolute right-2 top-2 px-2 py-1 bg-white/10 rounded hover:bg-white/20 text-[9px] text-white transition-colors"
                    >
                      Copy
                    </button>
                  </div>
                </div>

                {isConnected ? (
                  <GlassButton
                    variant="primary"
                    onClick={handleSubmit}
                    disabled={isSubmitting}
                    className="w-full mt-auto"
                  >
                    {isSubmitting ? "Signing & Submitting..." : "Sign and Submit Transaction"}
                  </GlassButton>
                ) : (
                  <div className="mt-auto text-center p-3 border border-white/10 rounded-lg bg-white/5">
                    <p className="text-xs text-white/50">Connect wallet to sign and submit on-chain.</p>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

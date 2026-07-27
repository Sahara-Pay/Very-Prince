"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

interface ApiKey {
  id: string;
  organizationId: string;
  name?: string;
  isActive: boolean;
  lastUsedAt?: string;
  createdAt: string;
  updatedAt: string;
}

interface GeneratedApiKey {
  plainTextKey: string;
  apiKey: ApiKey;
}

interface Props {
  orgId: string;
  publicKey: string;
}

const BACKEND_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";

export function ApiKeySettings({ orgId, publicKey }: Props) {
  const queryClient = useQueryClient();
  const [showGenerateModal, setShowGenerateModal] = useState(false);
  const [newKeyName, setNewKeyName] = useState("");
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [generatedKey, setGeneratedKey] = useState<GeneratedApiKey | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const apiKeysQuery = useQuery({
    queryKey: ["api-keys", orgId, publicKey],
    enabled: Boolean(orgId && publicKey),
    queryFn: async () => {
      const res = await fetch(`${BACKEND_URL}/api/org/${orgId}/api-keys`, {
        headers: { Authorization: `Bearer ${publicKey}` },
      });
      if (!res.ok) {
        throw new Error(`Failed to fetch API keys: ${res.statusText}`);
      }
      const data = await res.json();
      return (data.data || []) as ApiKey[];
    },
  });

  const apiKeys = apiKeysQuery.data || [];

  const generateKeyMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`${BACKEND_URL}/api/org/${orgId}/api-keys`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${publicKey}`,
        },
        body: JSON.stringify({ name: newKeyName || undefined }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message || "Failed to generate API key");
      }
      const data = await res.json();
      return data.data as GeneratedApiKey;
    },
    onSuccess: async (data) => {
      setGeneratedKey(data);
      setShowGenerateModal(false);
      setNewKeyName("");
      setSuccess("API key generated successfully! Save it now - it won't be shown again.");
      await queryClient.invalidateQueries({ queryKey: ["api-keys", orgId, publicKey] });
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Network error. Please try again.");
    },
  });

  const revokeKeyMutation = useMutation({
    mutationFn: async (keyId: string) => {
      const res = await fetch(`${BACKEND_URL}/api/org/${orgId}/api-keys/${keyId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${publicKey}` },
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message || "Failed to revoke API key");
      }
    },
    onSuccess: async () => {
      setSuccess("API key revoked successfully");
      await queryClient.invalidateQueries({ queryKey: ["api-keys", orgId, publicKey] });
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Network error. Please try again.");
    },
  });

  const updateKeyMutation = useMutation({
    mutationFn: async (keyId: string) => {
      const res = await fetch(`${BACKEND_URL}/api/org/${orgId}/api-keys/${keyId}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${publicKey}`,
        },
        body: JSON.stringify({ name: editingName }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message || "Failed to update API key");
      }
    },
    onSuccess: async () => {
      setSuccess("API key updated successfully");
      setEditingKey(null);
      setEditingName("");
      await queryClient.invalidateQueries({ queryKey: ["api-keys", orgId, publicKey] });
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Network error. Please try again.");
    },
  });

  const handleGenerateKey = async () => {
    setError(null);
    setSuccess(null);
    generateKeyMutation.mutate();
  };

  const handleRevokeKey = async (keyId: string) => {
    if (!confirm("Are you sure you want to revoke this API key? This action cannot be undone.")) {
      return;
    }
    
    setError(null);
    setSuccess(null);
    revokeKeyMutation.mutate(keyId);
  };

  const handleUpdateKey = async (keyId: string) => {
    setError(null);
    setSuccess(null);
    updateKeyMutation.mutate(keyId);
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setSuccess("API key copied to clipboard!");
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleString();
  };

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="glass-card p-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h3 className="text-lg font-semibold text-white">API Keys</h3>
            <p className="text-sm text-white/50 mt-1">
              Generate API keys for third-party integrations to access your organization data.
            </p>
          </div>
          <button
            onClick={() => setShowGenerateModal(true)}
            className="rounded-lg bg-gradient-to-r from-stellar-purple to-brand-500 px-6 py-2 text-sm font-semibold text-white hover:brightness-110"
          >
            + Generate API Key
          </button>
        </div>

        {error && (
          <div className="mb-6 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
            {error}
          </div>
        )}

        {success && (
          <div className="mb-6 rounded-xl border border-green-500/30 bg-green-500/10 px-4 py-3 text-sm text-green-400">
            {success}
          </div>
        )}

        {generatedKey && (
          <div className="mb-6 rounded-xl border border-yellow-500/30 bg-yellow-500/10 p-4">
            <h4 className="text-sm font-semibold text-yellow-400 mb-2">🔑 New API Key Generated</h4>
            <p className="text-xs text-yellow-300 mb-3">
              Save this API key now! It won't be shown again for security reasons.
            </p>
            <div className="flex items-center gap-2">
              <div className="flex-1 rounded-lg bg-black/20 px-3 py-2 font-mono text-xs text-yellow-200 break-all">
                {generatedKey.plainTextKey}
              </div>
              <button
                onClick={() => copyToClipboard(generatedKey.plainTextKey)}
                className="rounded-lg border border-yellow-500/30 bg-yellow-500/10 px-3 py-2 text-xs font-medium text-yellow-300 hover:bg-yellow-500/20"
              >
                Copy
              </button>
            </div>
          </div>
        )}

        <div className="space-y-4">
          {apiKeys.length === 0 ? (
            <div className="text-center py-8">
              <p className="text-white/40">No API keys generated yet.</p>
              <p className="text-white/30 text-sm mt-1">
                Generate an API key to enable third-party integrations.
              </p>
            </div>
          ) : (
            apiKeys.map((apiKey) => (
              <div
                key={apiKey.id}
                className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-4"
              >
                <div className="flex items-center justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-3">
                      {editingKey === apiKey.id ? (
                        <input
                          type="text"
                          value={editingName}
                          onChange={(e) => setEditingName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              handleUpdateKey(apiKey.id);
                            } else if (e.key === 'Escape') {
                              setEditingKey(null);
                              setEditingName("");
                            }
                          }}
                          className="rounded-lg border border-white/[0.12] bg-white/[0.06] px-3 py-1 text-sm text-white outline-none focus:border-stellar-purple/60"
                          placeholder="API key name"
                          autoFocus
                        />
                      ) : (
                        <h4 className="font-medium text-white">
                          {apiKey.name || "Unnamed API Key"}
                        </h4>
                      )}
                      <span className={`px-2 py-1 text-xs font-medium rounded-full ${
                        apiKey.isActive
                          ? "bg-green-500/20 text-green-400"
                          : "bg-red-500/20 text-red-400"
                      }`}>
                        {apiKey.isActive ? "Active" : "Revoked"}
                      </span>
                    </div>
                    <div className="mt-2 flex items-center gap-4 text-xs text-white/40">
                      <span>Created: {formatDate(apiKey.createdAt)}</span>
                      {apiKey.lastUsedAt && (
                        <span>Last used: {formatDate(apiKey.lastUsedAt)}</span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {editingKey === apiKey.id ? (
                      <>
                        <button
                          onClick={() => handleUpdateKey(apiKey.id)}
                          disabled={updateKeyMutation.isPending && updateKeyMutation.variables === apiKey.id}
                          className="rounded-lg border border-green-500/30 bg-green-500/10 px-3 py-1 text-xs font-medium text-green-400 hover:bg-green-500/20 disabled:opacity-50"
                        >
                          {updateKeyMutation.isPending && updateKeyMutation.variables === apiKey.id ? "Saving..." : "Save"}
                        </button>
                        <button
                          onClick={() => {
                            setEditingKey(null);
                            setEditingName("");
                          }}
                          className="rounded-lg border border-white/10 bg-white/5 px-3 py-1 text-xs font-medium text-white/60 hover:bg-white/10"
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <>
                        {apiKey.isActive && (
                          <button
                            onClick={() => {
                              setEditingKey(apiKey.id);
                              setEditingName(apiKey.name || "");
                            }}
                            className="rounded-lg border border-white/10 bg-white/5 px-3 py-1 text-xs font-medium text-white/60 hover:bg-white/10"
                          >
                            Edit Name
                          </button>
                        )}
                        {apiKey.isActive && (
                          <button
                            onClick={() => handleRevokeKey(apiKey.id)}
                            disabled={revokeKeyMutation.isPending && revokeKeyMutation.variables === apiKey.id}
                            className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-1 text-xs font-medium text-red-400 hover:bg-red-500/20 disabled:opacity-50"
                          >
                            {revokeKeyMutation.isPending && revokeKeyMutation.variables === apiKey.id ? "Revoking..." : "Revoke"}
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Generate API Key Modal */}
      {showGenerateModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="glass-card p-6 w-full max-w-md">
            <h3 className="text-lg font-semibold text-white mb-4">Generate New API Key</h3>
            <div className="mb-4">
              <label className="block text-sm font-medium text-white/70 mb-2">
                Key Name (Optional)
              </label>
              <input
                type="text"
                value={newKeyName}
                onChange={(e) => setNewKeyName(e.target.value)}
                placeholder="e.g., Production API Key"
                className="w-full rounded-lg border border-white/[0.12] bg-white/[0.06] px-4 py-2.5 text-sm text-white placeholder-white/30 outline-none focus:border-stellar-purple/60 focus:ring-1 focus:ring-stellar-purple/30"
              />
              <p className="mt-2 text-xs text-white/40">
                Give your API key a memorable name to help you identify its purpose.
              </p>
            </div>
            <div className="mb-4 p-3 rounded-lg bg-yellow-500/10 border border-yellow-500/30">
              <p className="text-xs text-yellow-300">
                <strong>Important:</strong> The API key will only be shown once after generation. 
                Save it in a secure location immediately.
              </p>
            </div>
            <div className="flex gap-3">
              <button
                onClick={handleGenerateKey}
                disabled={generateKeyMutation.isPending}
                className="flex-1 rounded-lg bg-gradient-to-r from-stellar-purple to-brand-500 px-4 py-2 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-50"
              >
                {generateKeyMutation.isPending ? "Generating..." : "Generate Key"}
              </button>
              <button
                onClick={() => {
                  setShowGenerateModal(false);
                  setNewKeyName("");
                }}
                className="flex-1 rounded-lg border border-white/10 bg-white/5 px-4 py-2 text-sm font-medium text-white/60 hover:bg-white/10"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

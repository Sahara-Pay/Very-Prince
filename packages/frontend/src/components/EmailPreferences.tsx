"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useUnifiedWallet } from "../hooks/useUnifiedWallet";
import { toast } from "sonner";

interface EmailPreferencesProps {
  dictionary?: {
    email_preferences: string;
    email_description: string;
    email_label: string;
    email_placeholder: string;
    save_email: string;
    saving: string;
    remove_email: string;
    verify_ownership: string;
    verify_description: string;
    opted_in: string;
  };
}

const defaultDictionary = {
  email_preferences: "Email Preferences",
  email_description: "Get notified instantly when an organization allocates funds to your wallet.",
  email_label: "Email Address",
  email_placeholder: "maintainer@example.com",
  save_email: "Save & Opt-in",
  saving: "Verifying & Saving...",
  remove_email: "Remove Email",
  verify_ownership: "Verification Required",
  verify_description: "To prevent spam, you must sign a message with your wallet to prove ownership before saving your email.",
  opted_in: "You are currently opted in to email notifications."
};

export function EmailPreferences({ dictionary = defaultDictionary }: EmailPreferencesProps) {
  const { publicKey, signAuthMessage } = useUnifiedWallet();
  const [email, setEmail] = useState("");

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!publicKey || !email) return;

      const message = `Opt-in to Very-prince notifications for wallet: ${publicKey}\nTimestamp: ${Date.now()}`;
      const signature = await signAuthMessage(message);

      const response = await fetch(`${process.env.NEXT_PUBLIC_BACKEND_URL}/api/v1/notifications/preferences`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          address: publicKey,
          email,
          signature,
          message
        }),
      });

      if (!response.ok) throw new Error("Failed to save");
    },
    onSuccess: () => {
      toast.success(dictionary.opted_in);
    },
    onError: () => {
      toast.error("Failed to verify ownership or save email.");
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      if (!publicKey) return;

      const message = `Delete my email notification data for wallet: ${publicKey}\nTimestamp: ${Date.now()}`;
      const signature = await signAuthMessage(message);

      const response = await fetch(`${process.env.NEXT_PUBLIC_BACKEND_URL}/api/v1/notifications/preferences`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          address: publicKey,
          signature,
          message
        }),
      });

      if (!response.ok) throw new Error("Failed to delete");
    },
    onSuccess: () => {
      setEmail("");
      toast.success("Data deleted successfully.");
    },
    onError: () => {
      toast.error("Failed to delete data.");
    },
  });

  const isSaving = saveMutation.isPending || deleteMutation.isPending;

  const handleSave = async () => {
    if (!publicKey || !email) return;
    saveMutation.mutate();
  };

  const handleDelete = async () => {
    if (!publicKey || !confirm("Are you sure? This will permanently delete your email from our records.")) return;
    deleteMutation.mutate();
  };

  return (
    <div className="glass-card p-6 rounded-xl border border-white/10 mt-6">
      <h2 className="text-xl font-semibold mb-2">{dictionary.email_preferences}</h2>
      <p className="text-gray-400 text-sm mb-6">{dictionary.email_description}</p>

      <div className="space-y-4">
        <div>
          <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">
            {dictionary.email_label}
          </label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={dictionary.email_placeholder}
            className="w-full bg-black/40 border border-white/10 rounded-lg px-4 py-2.5 text-white focus:outline-none focus:ring-2 focus:ring-purple-500/50"
          />
        </div>

        <div className="bg-purple-500/5 border border-purple-500/20 p-4 rounded-lg">
          <p className="text-xs text-purple-300">
            <strong>{dictionary.verify_ownership}:</strong> {dictionary.verify_description}
          </p>
        </div>

        <button
          onClick={handleSave}
          disabled={isSaving || !email}
          className="w-full bg-purple-600 hover:bg-purple-700 disabled:opacity-50 text-white font-semibold py-2.5 rounded-lg transition-all"
        >
          {isSaving ? dictionary.saving : dictionary.save_email}
        </button>
      </div>
      
      <div className="mt-8 pt-6 border-t border-white/5">
        <button 
          className="text-xs text-red-400 hover:text-red-300 transition-colors"
          onClick={handleDelete}
          disabled={isSaving}
        >
          {dictionary.remove_email}
        </button>
      </div>
    </div>
  );
}

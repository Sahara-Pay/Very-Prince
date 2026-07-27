# Manual QA Checklist: Wallet Interactions

This document outlines the manual QA testing procedures for wallet interactions within the application.

## 1. Wallet Connection
- [ ] **Connect Wallet**: Successfully connect via supported providers (e.g., MetaMask, WalletConnect).
- [ ] **Disconnect Wallet**: Successfully disconnect the wallet and verify UI updates accordingly.
- [ ] **Account Display**: Ensure the connected wallet address is displayed correctly (e.g., truncated).
- [ ] **Balance Display**: Verify that the correct native and ERC-20 token balances are shown.
- [ ] **Network Validation**: Connect on an unsupported network and verify the user is prompted to switch.
- [ ] **Network Switching**: Prompt the user to switch networks from the dApp; verify the wallet extension requests the switch.
- [ ] **Auto-reconnect**: Refresh the page and verify the wallet remains connected if previously connected.

## 2. Transactions & Interactions
- [ ] **Initiate Transaction**: Trigger a smart contract interaction and verify the wallet extension pops up.
- [ ] **Gas Estimates**: Ensure the gas fee estimated in the wallet matches expectations.
- [ ] **User Rejection**: Reject the transaction in the wallet extension and verify the dApp handles the rejection gracefully (e.g., shows a toast/alert without crashing).
- [ ] **Pending State**: Confirm the transaction in the wallet and verify the dApp shows a "Pending" or loading state.
- [ ] **Success State**: Once the transaction is mined, verify the dApp updates the UI (e.g., shows a success message, updates balances, updates transaction history).
- [ ] **Failure/Revert State**: Simulate a failed transaction and verify the dApp displays an appropriate error message.
- [ ] **Signature Requests**: Verify that signing messages (e.g., for SIWE or off-chain actions) works and is properly formatted.

## 3. State Synchronization
- [ ] **Account Change**: Switch accounts in the wallet extension while connected and verify the dApp updates immediately without a manual refresh.
- [ ] **Network Change**: Switch networks directly in the wallet extension and verify the dApp detects the change and updates or prompts appropriately.
- [ ] **Lock Wallet**: Lock the wallet extension while connected and verify the dApp handles the locked state.

## 4. Edge Cases & Error Handling
- [ ] **Insufficient Funds**: Attempt a transaction without enough native token for gas and verify the wallet and dApp block/handle it.
- [ ] **Wallet Not Installed**: Attempt to connect when no wallet extension is installed; ensure the user is directed to install one or shown a proper fallback.
- [ ] **Multiple Wallets**: Test behavior when multiple wallet extensions (e.g., MetaMask and Coinbase Wallet) are active simultaneously.
- [ ] **Mobile Wallets**: Test WalletConnect on a mobile device and ensure deep linking or QR code scanning works seamlessly.

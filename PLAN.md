# navcoin-rescue-tool Plan

## Summary

Build a recovery-first CLI tool for legacy NavCoin wallets that can inspect
recoverable funds and sweep them to a new destination address. The first
implementation should use `navcoin-js` as the wallet and network backend
wherever possible.

## Goals

- Accept legacy recovery material from users.
- Detect recoverable NAV balances for derived or imported addresses.
- Create and broadcast a sweep transaction to a user-supplied destination
  address.
- Keep the workflow simple, explicit, and safe for one-time recovery use.

## Expected Inputs

- Mnemonic phrases supported by `navcoin-js` wallet types:
  - `navcoin-js-v1`
  - `navcash`
  - `next`
  - `navcoin-core`
  - `navpay`
- Private keys that can be imported into `navcoin-js`
- `wallet.dat` only through a separate extraction step, since `navcoin-js` does
  not appear to load Core `wallet.dat` files directly

## Initial Non-Goals

- Full GUI in the first version
- In-place modification of old wallet files
- Broad wallet format support beyond known NavCoin legacy flows
- xNAV, token, NFT, and dotNav recovery in the first recovery pass unless
  required later

## Proposed Phases

1. Create project skeleton and CLI entrypoint.
2. Wrap `navcoin-js` wallet creation for mnemonic-based recovery.
3. Add private-key import recovery flow.
4. Define `wallet.dat` strategy:
   - either external extractor step
   - or direct integration with a separate parser if one is viable
5. Add balance discovery and address reporting.
6. Add sweep transaction creation and broadcast.
7. Add safety checks:
   - destination validation
   - explicit confirmation before broadcast
   - dry-run / preview mode
8. Test against known legacy wallet samples and edge cases.

## Open Questions

- Which exact legacy wallet types do we need to support first?
- Do we need read-only balance inspection before requiring any spending
  password?
- Should `wallet.dat` handling be built in, or should users extract keys with a
  companion command/tool?
- Do we sweep only NAV first, or also support xNAV later?
- Should the tool prefer a guided interactive flow, CLI flags, or both?

## First Implementation Direction

Start with the smallest useful path:

1. mnemonic input
2. supported wallet type selection
3. connect and sync with `navcoin-js`
4. show balances and receiving/spendable addresses
5. sweep NAV to a destination address

After that, add private-key recovery, then solve `wallet.dat` ingestion.

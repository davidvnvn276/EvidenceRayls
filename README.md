# Rayls return test, v2: recipient locks and independent compensation

This is an executed **local contract-level experiment**. It does not run Rayls nodes, a live relayer, commercial issuance, USDr or a fiat payout.

## Sources and execution boundary

Contracts are pinned to `bdf8f044b9a270e1f97c4c2ac6de9e32ec467de9` of https://github.com/raylsnetwork/rayls-sovereign-contracts. The source marks the tested Teleport routines as deprecated/decommissioning. Findings apply to this implementation and fixture. Current production deployment versions were not established.

The private fixture inherits `RaylsErc20Handler` without overriding its bridge, transfer, receive, lock, unlock, authorization or registry guards. Its constructor seeds 100,000 private test units. The public mirror is the official `PublicChainERC20`.

**v2 replaces the authority mock with the official `RaylsAccessManagerV1`.** The harness compiles its original five linked libraries, deploys the implementation, and initializes two separate ERC1967 proxies: one manager for the private token and another for the public token. The test registers MESSAGE_EXECUTOR and RELAYER roles, grants the callback signer MESSAGE_EXECUTOR with zero delay, and asserts that signer is not ADMIN. A separate signer is the fixture administrator.

Token constructors register their selectors with these managers through the original code. Tests use the actual manager's revokeRole, grantRole, canCall and pause behavior. Endpoint, token registry and user governance **remain test doubles**. Both A and B are approved in the user-governance fixture. This does not test a deployed bank's role/key history or production governance configuration.

All contracts run on one Ganache EVM, chain ID 31337 and Shanghai hardfork. Endpoint identifiers 1001/7331 are synthetic metadata. Compilation uses Solidity 0.8.24, Paris EVM and optimizer 50 runs. Ganache permits oversized contracts; production deployment/code-size limits and gas performance are not assessed.

Forward and compensation calls are manually submitted. No listener, queue, cross-chain transport, message authentication/replay system, automatic retry service or relayer timing is executed.

## Reproduce

Use Git, Node.js 22 or a compatible Node version, and npm. Commands work in PowerShell or a Unix shell; no wallet, Docker, WSL or real funds are needed. Internet access is needed to download the repository and dependencies.

Place `redemption-lab-v2` next to `rayls-sovereign-contracts`:

```text
git clone https://github.com/davidvnvn276/EvidenceRayls.git
git -C EvidenceRayls checkout --detach 032645d9f20b41fb13affc9f111f5a0914ec0aab
git clone https://github.com/raylsnetwork/rayls-sovereign-contracts.git
git -C rayls-sovereign-contracts checkout --detach bdf8f044b9a270e1f97c4c2ac6de9e32ec467de9
cd EvidenceRayls
npm ci --ignore-scripts --no-audit --no-fund
node run.cjs
```

The script requires the pinned contracts checkout to be clean. If it is elsewhere, set RAYLS_CONTRACTS_DIR to the full checkout path. The package lock marks Ganache's bundled macOS-only fsevents watcher optional, so npm ci does not require a macOS module on Linux. Dependency versions and integrity hashes are otherwise unchanged.

Some Node versions print a native µWS compatibility warning. Ganache then uses its JavaScript fallback; the recorded run completed with this warning. A failing assertion terminates the script and does not produce a successful result flag.

## Executed cases

Three fresh fixtures test return amounts 1, 40,000 and 100,000, all scaled by 10^18. A bridges outward and transfers public tokens to B. B has no private lock. The return to B fails; manually submitting compensation remints B's public tokens. A new return by B to A succeeds and credits A.

Each run checks nine readings: locks A/B, contract-held private tokens, private balances A/B, private supply, public balances A/B and public supply. It reconciles Transfer burn/remint events and TokensUnlocked/Transfer on successful return. "Restored state" means these nine token readings, not transaction counts, native balances or the whole EVM.

Nine negative transactions test zero recipient, zero amount, excessive unlock, unapproved outward caller, unauthorized callback, inactive token, revoked executor, delayed executor and paused private token. For each, static simulation decodes the expected revert and a separately mined failed transaction has receipt status zero. Tracked token state is unchanged. Delayed scheduled execution is not exercised.

An additional 40,000-unit case burns B's public balance and fails its private return. The fixture administrator pauses the public token. Compensation is then rejected by the original AccessManager guard and does not restore B's balance. After unpause and manual resubmission of the exact compensation payload, all nine readings match their pre-burn values. This demonstrates separate contract execution outcomes; it does not establish live relayer behavior or a recovery deadline.

## Files

- RedemptionLab.sol: test fixtures and imports of unmodified official implementations.
- run.cjs: compiler, library linking, manager deployment, transactions, assertions, events and state reconciliation.
- package.json / package-lock.json: exact dependencies.
- results.json: commits, source hashes, local transaction hashes, readings, events and authority configuration.
- execution.log: recorded terminal output.
- compilation-warnings.txt / compiler-input.json: diagnostics and compilation settings.
- manifest.json: hashes of package artifacts.

All addresses and transaction hashes in the output belong to the local EVM. Do not fabricate Rayls Explorer links or describe these transactions as production activity.

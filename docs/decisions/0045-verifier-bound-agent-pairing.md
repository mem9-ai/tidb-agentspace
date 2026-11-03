# ADR 0045: Verifier-bound Guest Agent pairing

- Status: proposed for [GH-158](https://github.com/mem9-ai/tidb.ai/issues/158); no pairing behavior is implemented by this decision.
- Date: 2026-11-03.
- Extends ADRs 0036, 0037, 0041 and 0043 and the accepted [GH-150 journey](../../specs/gh-150/spec.md).

## Problem

A Guest needs to give one Agent limited access without pasting a long-lived Workspace Key into a prompt. Existing Global Key creation reveals a credential to the browser and requires the user to place it in the Agent's environment. A copied prompt or a created Key does not show that an Agent actually connected. Guest expiry, Region policy propagation and revocation cannot be replaced by a cosmetic pairing code.

## Proposed decision

The external client initiates a five-minute attempt with a cryptographically random verifier challenge. The user enters a separate code in an authenticated Workspace and explicitly approves exact existing resource IDs, actions and expiry. Only the verifier-bearing client can redeem. The response returns the secret once to that client, which stores it outside prompts, process arguments, source trees and logs. Guest Keys cannot outlive the existing Guest access policy and cannot administer Keys. A separate owner-visible receipt proves an actual authorized Region request; copy, approval, secret issuance or client-reported progress alone does not establish a connection.

Global owns the attempt and new Key. In the Global Key metadata partition, consume the exact approved attempt version and create the Key record, credential verifier, version and durable attempt-to-Key receipt in a single transaction. The immutable grant is confirmed before this commit. A successful commit does not imply Region policy has applied. Hold or establish an appropriate Guest-policy fence across redemption so a logout cannot acknowledge completion while an old approval issues a usable credential. Region policy and current expiry remain independently enforced for every data request. Independent deployment topologies without a supported Guest authority bridge fail closed.

Attempt codes and verifiers have separate purposes: code lookup requires an authenticated matching Workspace and does not authorize approval or redemption; the verifier is a secret kept by the initiating client. Neither the verifier nor Key appears in a URL, log, event, request-history record or telemetry. Enforce durable, bounded admission and verification failures across instances; do not rely on an in-memory limiter, proxy header supplied by a client or a hidden browser action. Cleanup is bounded and expiry-aware.

A lost redemption response is an unknown effect, not permission to issue another secret. Owner inspection identifies any associated Key without returning its secret; the user explicitly revokes it and waits for Region acknowledgment before starting another attempt. Pending propagation, failures and revoked states remain visible and distinct. No replay reveals the prior secret.

## Consequences and gate

This introduces sensitive unauthenticated admission, client-bound Key issuance, bounded ephemeral state and an authenticated connection receipt. It increases implementation and operational work, but preserves the existing Global/Region and Owner/Agent boundaries. It does not provide Agent task evidence, interpret Agent intent, transfer Guest ownership, or replace existing manual Key management.

The [pairing contract draft](../../specs/gh-158/pairing-contract.md) describes outcomes, candidate operations, denial and recovery. Before implementation, review a machine-readable public OpenAPI amendment, resolve admission/storage cleanup and the authenticated Region receipt, and prove Guest logout/issuance fencing. Native tests must exercise expiry, replay, concurrency, crashes, wrong verifiers, rate bounds, policy propagation, revocation and cross-Workspace isolation. Verify a named external Agent client separately. No live provider or production rollout is implied by accepting the design.

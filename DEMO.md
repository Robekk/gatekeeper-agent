# Live demo — real tasks against the production endpoint

Two signed tasks sent to the live NOIRKEEPER endpoint
(`https://disallow-figurine-geologic.ngrok-free.dev/agent`) on 2026-11-15.
Each response was checked two ways: the HMAC response signature was
verified, and the returned Groth16 proof was verified **locally** with
snarkjs against the official gatekeeper verification key — both `true`.

Requests to the endpoint must be HMAC-signed with the agent's secret, so
this transcript is the receipt; the local harness in `scripts/replay.ts`
boots the same code with a test secret and is fully re-runnable.

```text
==============================================================================
DEMO 1 — valid payment (expect APPROVE)
REQUEST  POST https://disallow-figurine-geologic.ngrok-free.dev/agent
{
  "type": "agent-games.proof-gatekeeper.v1",
  "task_id": "demo_valid_1a1db85de40",
  "mode": "demo",
  "issued_at": "2026-11-14T19:25:45.920Z",
  "deadline_at": "2026-11-14T19:26:45.938Z",
  "input": {
    "registered_vk": "0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168fbad77b0",
    "proof_vk": "0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168fbad77b0",
    "minimum": "1000",
    "public_balance": "1460",
    "expiry_block": 8430000,
    "current_block": 8420000,
    "recipient": "0xabcdef1234567890abcdef1234567890abcdef12",
    "condition_recipient": "0xabcdef1234567890abcdef1234567890abcdef12",
    "amount": "500",
    "max_transfer": "1000",
    "proof_tx": "0xa5296d5b569178a589755a54ad63e1db"
  }
}
RESPONSE HTTP 200 in 1648 ms — response signature valid: true
{
  "decision": "APPROVE",
  "reason_code": "VALID_CONDITION",
  "proof_tx": "0xa5296d5b569178a589755a54ad63e1db",
  "public_signals": [
    "14744269619966411208579211824598458697587494354926760081771325075741142829156",
    "3038289366903279459499706733428410144928649079517838547585723254984116369328",
    "3038289366903279459499706733428410144928649079517838547585723254984116369328",
    "1000",
    "1460",
    "8430000",
    "8420000",
    "980829900607564470325551667077511842637428944658",
    "980829900607564470325551667077511842637428944658",
    "500",
    "1000",
    "1",
    "0"
  ]
}
proof.pi_a[0]: 16799040772775293064027108874021767200166806752483482242368010456312068752899
LOCAL snarkjs groth16.verify(vk, public_signals, proof) = true
==============================================================================
DEMO 2 — recipient swapped (expect REJECT / RECIPIENT_MISMATCH)
REQUEST  POST https://disallow-figurine-geologic.ngrok-free.dev/agent
{
  "type": "agent-games.proof-gatekeeper.v1",
  "task_id": "demo_recipient_1a1db85de40",
  "mode": "demo",
  "issued_at": "2026-11-14T19:25:45.938Z",
  "deadline_at": "2026-11-14T19:26:45.938Z",
  "input": {
    "registered_vk": "0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168fbad77b0",
    "proof_vk": "0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168fbad77b0",
    "minimum": "1000",
    "public_balance": "1460",
    "expiry_block": 8430000,
    "current_block": 8420000,
    "recipient": "0xabcdef1234567890abcdef1234567890abcdef12",
    "condition_recipient": "0x9999999999999999999999999999999999999999",
    "amount": "500",
    "max_transfer": "1000",
    "proof_tx": "0x62d4227d5e4c31ae1ccbcba3d282938d"
  }
}
RESPONSE HTTP 200 in 456 ms — response signature valid: true
{
  "decision": "REJECT",
  "reason_code": "RECIPIENT_MISMATCH",
  "proof_tx": "0x62d4227d5e4c31ae1ccbcba3d282938d",
  "public_signals": [
    "14744269619966411208579211824598458697587494354926760081771325075741142829156",
    "3038289366903279459499706733428410144928649079517838547585723254984116369328",
    "3038289366903279459499706733428410144928649079517838547585723254984116369328",
    "1000",
    "1460",
    "8430000",
    "8420000",
    "980829900607564470325551667077511842637428944658",
    "876900982398541750922210899629769811793559525785",
    "500",
    "1000",
    "0",
    "0"
  ]
}
proof.pi_a[0]: 21581357123341404372857095770962662805947809842271215516797291248425395028515
LOCAL snarkjs groth16.verify(vk, public_signals, proof) = true
```

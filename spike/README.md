# Spikes

Small scripts that answer one question each against Tiramisu. They read wallet keys from `.env.local`
and mark every entity they write with `app = "trg-spike"`, short lifetimes, and clean up after
themselves where they can.

| Script | Question |
|---|---|
| `01-u64-range.ts` | Does `lte` work on our own `u64` attributes? What shape are attributes in query results? |
| `02-replay-events.ts` | Does replaying from a saved block return deletes? Does an expiry emit any event? Does a live WebSocket watch work? |
| `03-claim-race.ts` | Can "oldest claim wins" be decided from a query when claims share a block? |
| `04-heartbeat-patch.ts` | How do we renew a heartbeat in place (patch + extend)? Why did `patchEntity` say "nothing to apply"? |
| `05-batch-order.ts` | Does `executeBatch` return `createdEntities` in the order of `creates`? |

Run one with `npx tsx spike/<name>.ts`.

## Browser access to the RPC (CORS)

```bash
curl -s -o /dev/null -D - -X OPTIONS https://rpc.tiramisu.db-chain.testnet.arkiv.network \
  -H "Origin: https://arkiv-triggers-dashboard.vercel.app" \
  -H "Access-Control-Request-Method: POST" -H "Access-Control-Request-Headers: content-type,x-api-key"

curl -s -D - -X POST https://rpc.tiramisu.db-chain.testnet.arkiv.network \
  -H "Origin: https://arkiv-triggers-dashboard.vercel.app" -H "Content-Type: application/json" \
  --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'
```

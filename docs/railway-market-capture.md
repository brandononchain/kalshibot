# Run the market capture worker on Railway

Use a dedicated Railway service for capture. The repository's web service can keep its normal start command; do not change it to the collector command. Railway runs persistent services suitable for long-lived background processes, while its filesystem is ephemeral unless a volume is attached. Attach a volume to preserve the JSONL files across deploys and restarts.

## Deploy

1. In Railway, create a new project or add a service from the `brandononchain/kalshibot` GitHub repository.
2. Name the service `kalshibot-market-capture`.
3. Set its Start Command to:

   ```sh
   npm run capture:markets
   ```

4. Add a Railway Volume to this service and mount it at `/data`.
5. Add these service variables in Railway's Variables UI:

   | Variable | Value |
   | --- | --- |
   | `CAPTURE_OUTPUT_DIR` | `/data/captures` |
   | `KALSHI_API_KEY` | Your Kalshi API key ID |
   | `KALSHI_PRIVATE_KEY_BASE64` | Base64-encoded PEM private key |
   | `KALSHI_API_BASE` | `https://external-api.kalshi.com` |
   | `CAPTURE_SERIES_TICKER` | `KXBTC15M` |
   | `CAPTURE_BINANCE_SYMBOL` | `btcusdt` |

   Keep the key ID and private key in Railway's encrypted service variables. Do not commit them, add them to a Docker image, or put them in a public build argument. Encode the PEM locally before entering it as a Railway variable; for example, on macOS or Linux run `base64 < kalshi_private_key.pem | tr -d '\\n'`. Never send the private key to chat or GitHub.

6. Deploy the service, then inspect its deploy logs. It should report WebSocket connections and begin writing `/data/captures/kalshi-KXBTC15M-YYYY-MM-DD.jsonl`. If authentication or network setup fails, the collector records the error and reconnects with backoff.
7. Check the Railway volume usage periodically and download/copy the capture files before removing the volume or deleting the service.

## What this service does

The capture process subscribes to public market data and records market metadata, book snapshots and deltas, trades, reconstructed executable quotes, settlement outcomes, and Binance BTC best-bid/ask observations. It has no order placement, amendment, or cancellation path. Keep live trading disabled during data collection.

The capture is prospective from the time the service starts. It cannot recover book history from before deployment or during outages. Treat sequence gaps as missing book coverage; do not use stale quotes across a gap. Check the logs and volume data before relying on the capture for replay.

## Why Railway

This worker needs to keep two WebSocket feeds open and append continuously to local files. Railway documents persistent services for long-running processes and volumes for data that must survive redeploys. Based on those execution and storage models, Railway is the simpler home for this collector.

Vercel Functions can use WebSockets with Fluid Compute, but function executions still have configured maximum durations and local filesystem state is not durable. Vercel can host a dashboard or API that reads from external storage; a continuously running collector would need a reconnecting invocation design plus durable external storage, so it is a less direct fit.

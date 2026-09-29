# BillStock Pro — WhatsApp link-device bridge

A tiny always-on worker that holds the WhatsApp Web "linked device" session for
each shop. It generates the QR code the app shows, reports incoming messages
back to BillStock Pro, and sends replies queued from the unified Inbox.

## What you need

- Any small VPS (1 vCPU / 1 GB is plenty, ~$5/month) with Node.js 20+
- The bridge token you saved in the app's secrets (`WHATSAPP_BRIDGE_TOKEN`)

## Install

```bash
git clone <your repo> && cd bridge/whatsapp
npm install
cp .env.example .env    # fill in the two values
npm start
```

Keep it running with pm2 (or a systemd unit):

```bash
npm i -g pm2
pm2 start index.mjs --name whatsapp-bridge
pm2 save && pm2 startup
```

## How pairing works

1. Shop owner opens **Orders → WhatsApp connection → Get QR code**.
2. The bridge notices the pairing request within a few seconds, starts a
   WhatsApp Web session and uploads the QR image.
3. Owner scans it in **WhatsApp Business → Settings → Linked devices**.
4. The bridge saves the device session, so restarts need no rescan.

## Important

This uses WhatsApp's linked-device (companion) protocol, which is not an
official WhatsApp API. It is the same mechanism the WooCommerce WhatsApp
plugins use. Use a business number you can afford to re-link and monitor the
linked device regularly.

> **Legacy design notes.** This document describes the earlier self-hosted PostgreSQL/Fastify design (`apps/api`, `packages/*`), which is not what production runs. The live product is the Firebase + Cloudflare Worker build described in the [README](../README.md) and [launch runbook](launch-runbook.md). Nothing here (including encryption, RLS or queue claims) should be read as a description of the live service.

# ZexCore: Plain-English Guide & Operating Manual

> **The Sovereign Multi-Tenant Operating System for Vertical SaaS**  
> *One Core. Infinite Possibilities.*

---

## 1. What is ZexCore? (In Plain English)

Imagine you are constructing a modern commercial office building. You would not smelt your own steel, generate your own electrical grid, or dig your own city water supply before inviting tenants to rent office suites. You rely on certified municipal utilities and structural foundations so you can focus entirely on creating exceptional office spaces.

**ZexCore is the certified digital foundation for business software.**

Whenever a software company, digital agency, or enterprise builds software for multiple customers (known as **multi-tenant**), connects physical sensors or hardware machines, manages customer sales pipelines, sends automated WhatsApp messages, encrypts confidential patient or financial records, or undergoes rigorous cybersecurity audits, they normally spend **12 to 18 months** building repetitive, risky backend infrastructure from scratch.

**ZexCore provides that entire foundation out of the box.** Instead of spending two years writing plumbing, companies launch fully sovereign, enterprise-grade vertical software in days.

---

## 2. Why ZexCore?

| The Traditional (Hard) Way | The ZexCore Way |
|---|---|
| **18 Months to Market:** Teams spend a year writing login, permissions, and database filters before shipping their core idea. | **Live in 10 Minutes:** Launch turnkey vertical packages (cold-chain, industrial automation, healthcare) with pre-armed devices and rules immediately. |
| **Accidental Data Leaks:** A single forgotten `WHERE tenant_id = x` in an application query exposes Customer A's private data to Customer B. | **Mathematical Vault Isolation:** The database itself (PostgreSQL 17 Row-Level Security) physically blocks cross-tenant access. |
| **Fragile Frankenstein Stack:** Cobbling together Zapier, HubSpot, AWS IoT, and random databases causes constant breakage and astronomical monthly bills. | **Unified Micro-Kernel:** Hardware telemetry, WhatsApp communications, deterministic rules, and billing run together in one engine. |
| **Failed Compliance Audits:** Regulators ask for unalterable proof of GDPR erasure or export logs, and the company has no cryptographic records. | **Cryptographic Tamper-Proof Seals:** Every reading, export, and state change is stamped with an immutable serial number and hash chain. |

---

## 3. How Every Feature Works (In Plain English)

### 3.1 Sovereign Multi-Tenant Isolation
- **What it is:** An impenetrable electronic wall separating every customer's data on the same platform.
- **How it works:** Traditional software relies on human programmers remembering to filter every query. If someone makes a typo, data leaks. ZexCore enforces **Row-Level Security (RLS)** directly inside PostgreSQL 17. Think of it like a hotel keycard: a keycard for Room 201 physically cannot unlock Room 302, because the door lock itself refuses.

### 3.2 Connected Devices & IoT Fleet (Hardware Hub)
- **What it is:** Connecting physical machinery (refrigerated containers, hospital monitors, factory robots, delivery vans) to your software.
- **How it works:** Each physical sensor is provisioned with a secure cryptographic token. The device transmits real-time readings (such as *"temperature is 3.8°C, humidity is 42%, voltage is 3.7V"*). ZexCore validates the token in under 1 millisecond, records the data in a tamper-proof log, and dispatches instant alerts if thresholds are breached.

### 3.3 Deterministic Automation Rules & AI Authoring
- **What it is:** "If THIS happens, do THAT" automatic business workflows.
- **How it works:** You can define rules like: *"If cold-chain temperature rises above 8°C for 3 consecutive readings, immediately send a priority WhatsApp alert to the facility engineer and log a compliance incident."* Instead of executing unsafe computer code that could crash your servers or allow hacker exploits, ZexCore compiles rules into a safe mathematical tree (**Abstract Syntax Tree / AST**) with zero JavaScript `eval()`.

### 3.4 CRM, Deals Pipeline & WhatsApp Messaging
- **What it is:** Customer inquiries, omnichannel chats, sales Kanban boards, and Paystack payments.
- **How it works:** Inbound inquiries from websites or WhatsApp feed directly into a centralized CRM pipeline. Operators can send quotes and receive card payments. Message status ticks are strictly authentic:
  - **Single Grey Tick (✓):** Transmitted to telecommunication gateway.
  - **Double Grey Tick (✓✓):** Confirmed delivered to the client's physical handset.
  - **Double Blue Tick (✓✓):** Confirmed opened and seen by the recipient. If an outbound message has not been opened, it will never show blue ticks.

### 3.5 Compliance Vault & GDPR Crypto-Erasure
- **What it is:** Military-grade data encryption and automated regulatory compliance.
- **How it works:** Confidential records (passports, home addresses, bank accounts) are scrambled using **AES-256-GCM** authenticated envelope encryption before touching the disk. If a customer exercises their legal "Right to be Forgotten" (GDPR Article 17), ZexCore permanently shreds that customer's unique encryption subkey. The data becomes mathematically irrecoverable white noise, satisfying international privacy regulators.

### 3.6 Agency White-Label Branding Studio
- **What it is:** Customizing the entire console to display your agency or enterprise brand.
- **How it works:** Upload your custom company logo directly (via drag-and-drop file upload or direct URL), customize primary brand colors, remove all ZexCore badges, and bind your own custom domain (e.g. `console.youragency.com`). Client tenants see your brand exclusively.

### 3.7 Tamper-Proof Audit & Non-Deletable Export Ledger
- **What it is:** A flight data black-box recorder for all data exports, sensor readings, and system status changes.
- **How it works:** Every time data is exported or state changes, the platform assigns a permanent serial number (e.g. `EXP-20261021-9B4F1A`), exact millisecond timestamp (UTC), user identity, and cryptographic watermark. Each entry is chained to the previous entry using a mathematical hash seal. These records are permanent and append-only: no user or administrator can alter or delete past records.

### 3.8 Licence file and dedicated cluster
- **What it is:** A signed licence file for Enterprise and Dedicated workspaces, and a request form for a dedicated cluster.
- **How it works:** An owner or admin generates a licence that states the workspace, its plan and when it expires. It is signed with an Ed25519 private key held only by ZexCore, so anyone can verify it offline with the public key and nobody can alter it. It records entitlement; plan limits are enforced by the platform itself. A dedicated cluster is set up by our team: the request goes to us by email and nothing is created or charged automatically. See `docs/licences.md`.

---

## 4. How to Run ZexCore

### Option A: Run on the Website (Instant Cloud SaaS)
*Best for testing, agency clients, and immediate production without server maintenance.*

1. Open your browser and navigate to the **ZexCore Console** (`#/console`).
2. Select your tenant organization from the top-left dropdown (e.g. `Acme Enterprise Corp`).
3. Click **Deploy Starter Kit** in the top bar to choose an industry package (Cold Chain, Industrial IoT, CRM, or Digital Agency).
4. The dashboard instantly generates simulated edge hardware nodes, automation rules, and live event streams in your browser.

---

### Option B: Install on Client Workspace (Enterprise On-Prem / Cloud)
*Best for regulated enterprises requiring private VPC, AWS, Azure, GCP, or bare-metal deployment.*

#### Prerequisites
- Node.js 20+ (LTS)
- PNPM (`npm install -g pnpm`)
- Docker & Docker Compose
- PostgreSQL 17

#### Installation Commands

```bash
# 1. Clone repository into workspace
git clone https://github.com/malcrypt-tech-hub/Zexcore.git
cd ZexCore

# 2. Install all workspace dependencies
pnpm install

# 3. Launch isolated PostgreSQL 17 database
docker compose up -d postgres

# 4. Run database migrations & seed demo vertical data
pnpm db:migrate
pnpm db:seed

# 5. Launch Backend Micro-Kernel (Port 3000)
pnpm --filter @zexcore/api dev

# 6. Launch Web Operations Console (Port 5173)
pnpm --filter @zexcore/dashboard dev
```

#### Health Verification
Verify that the kernel and Row-Level Security are active:
```bash
curl http://localhost:3000/health
# Response:
# {"status":"healthy","database":"connected","rlsEnforced":true}
```

---

## 5. Plain-English Glossary

- **Tenant:** A completely separate business or customer account.
- **Row-Level Security (RLS):** Database-level security locks preventing cross-company access.
- **Telemetry:** Automated real-time measurements sent over the wire by physical machines (temperature, pressure, voltage).
- **AST (Abstract Syntax Tree):** A safe mathematical representation of an if/then rule that prevents code injection attacks.
- **AES-256-GCM:** The highest standard of civilian encryption, ensuring scrambled data cannot be decrypted without the secret key.
- **Blind Index:** A cryptographic method allowing exact-match searches (e.g. searching for a customer's email) without decrypting the database.
- **Hash Chain:** A mathematical seal where each log entry locks into the previous entry, making tampering mathematically impossible to hide.
- **SIEM:** Enterprise security monitoring platforms (like Splunk, Datadog, or IBM QRadar) that ingest audit logs.
- **Watermark:** Permanent metadata embedded inside exported files certifying serial numbers, timestamps, and tenant authenticity.

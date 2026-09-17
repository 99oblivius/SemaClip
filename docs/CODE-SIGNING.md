# Code signing (SemaClip)

Researched 2026-09-17. Two separate mechanisms, frequently conflated:

| | **Manifest signing** | **Windows Authenticode** |
|---|---|---|
| Protects | the auto-updater manifest (`latest.json`) | the `.exe` / `.msi` file itself |
| Needs a CA? | No | Yes (or Microsoft's managed service) |
| Needs a legal identity? | No | Yes — govt photo ID at minimum |
| Cost | €0 | €0 (SignPath/Store) to ~€400/yr + token |
| Stops SmartScreen? | n/a | **Not reliably — see §2** |
| Status | **do it now** | **defer** |

Everything below is verified against a source that was actually fetched, or explicitly
marked **unverified**.

---

## 1. Manifest signing (Ed25519) for `Deno.autoUpdate`

### 1.1 What the runtime requires

Source: <https://docs.deno.com/runtime/desktop/auto_update/> (page footer: "Last updated
on June 25, 2026"). Claims below are direct quotes or close paraphrases of that page.

- `publicKey` — "Base64 Ed25519 public key. When set, the manifest must be signed (see
  Signed manifests)."
- When `publicKey` is configured the manifest becomes an **envelope**:

  ```json
  {
    "signed": "{\"version\":\"1.5.0\",\"patches\":{ … }}",
    "signature": "<base64 Ed25519 signature over the `signed` string>"
  }
  ```

- "The runtime verifies `signature` over the exact bytes of the `signed` string using
  your `publicKey`, then parses `signed` as the trusted manifest. To avoid depending on
  a canonical-JSON implementation, the real manifest is embedded verbatim as the
  `signed` string and only its contents are trusted."
- The key must be **32 raw bytes**, base64-encoded. Signature is over the **raw bytes**,
  not a hash and not a re-serialisation.
- Best practice, verbatim: "Keep the private key off the release host."
- The update URL must be `https://` — the runtime refuses a plaintext endpoint.
- Deno 2.9+ (`deno desktop` is experimental). Local toolchain verified: Deno 2.9.6.

**Three consequences that drive the design:**

1. **The signed string is the manifest file's own bytes.** Do not parse-then-re-serialise
   — that would change key order/whitespace and invalidate the signature. Sign
   `latest.json` as-is.
2. **All-or-nothing.** Once a client is built with `publicKey` set, it will only accept
   an envelope. Conversely, a client built *without* `publicKey` that receives an
   envelope sees no `version`/`patches` at the top level and silently treats it as "no
   update available". You cannot migrate a deployed fleet onto signing incrementally.
   Since SemaClip has no users yet, set the key **before the first public release** and
   this problem never exists.
3. Per-patch `sha256` is already mandatory and TLS is already required, so signing is
   defence-in-depth against a compromised release host — not the primary control.

### 1.2 Generating the keypair

Both commands below were **run and cross-checked** on this machine. All three
implementations (openssl 3.6.4, Python `cryptography`, Deno WebCrypto) produce
interoperable results, and for the same key the Ed25519 signature is byte-identical
across openssl and Deno (Ed25519 is deterministic).

**Option A — openssl (no dependencies):**

```bash
# Private key. Keep this off the release host; it never goes in the repo.
openssl genpkey -algorithm ed25519 -out manifest-signing.pem

# 32-byte raw public key, base64 — this exact string is what `publicKey` wants.
# (SubjectPublicKeyInfo DER is 44 bytes for Ed25519; the key is the trailing 32.)
openssl pkey -in manifest-signing.pem -pubout -outform DER | tail -c 32 | base64 -w0
```

Verified output shape: `a/lmOD209Tfq+xPW1GQQI7hcr1fHMmAw/aGLk6K2cHw=` (44 chars, 32 bytes).
This matched Python `cryptography`'s
`public_bytes(Encoding.Raw, PublicFormat.Raw)` byte for byte, so `tail -c 32` is the
correct extraction (not `-c 32` of the PEM, which would be wrong).

**Option B — Deno WebCrypto (zero deps, cross-platform, better for CI):**

```ts
// scripts/manifest-keygen.ts — run once, offline.
const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]) as CryptoKeyPair;
const rawPub = new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey));   // 32 bytes
const pkcs8  = new Uint8Array(await crypto.subtle.exportKey("pkcs8", keys.privateKey));
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
console.log("publicKey :", b64(rawPub));
console.log("privateKey:", b64(pkcs8));   // PKCS8 DER, base64 — store as the CI secret
```

Verified: produced a 32-byte raw public key and a PKCS8 private key that openssl could
load and verify against. Note option B exports **PKCS8**, option A produces **PEM** —
pick one and keep key handling consistent between signing script and secret.

### 1.3 Where each half goes

| Item | Location | Rationale |
|---|---|---|
| **Private key** | GitHub Actions secret, e.g. `MANIFEST_SIGNING_KEY` | Docs: "Keep the private key off the release host." A GH secret is not on the Pages host serving `latest.json`. |
| **Public key** | **Committed as a source constant** | It is not secret. See the caveat below. |
| Signing step | `release.yml` `publish` job, after patch generation | Must sign the exact bytes that get uploaded. |
| Signed envelope | committed to the `releases` branch / Pages | Replaces `latest.json` at the same URL. |

**Caveat — the current adapter will not work as written.** `server/adapters/outbound/platform/auto-update.ts:92`
reads the public key from `Deno.env.get("SEMACLIP_UPDATE_PUBKEY")`. Environment variables
are **not** baked into the compiled binary — the Deno docs say only `version` and
`desktop.release.baseUrl` from `deno.json` are baked in, and the same reasoning applies:
a GUI app launched from an `.msi`/`.AppImage` by Explorer/the desktop shell inherits no
project-specific env. That read would return `undefined` in a real install and signing
would silently be off.

Fix: make the public key a compile-time constant, e.g. a generated
`server/adapters/outbound/platform/release-key.ts` exporting `MANIFEST_PUBLIC_KEY =
"…"`, and keep the env var only as a dev override:

```ts
const publicKey = Deno.env.get("SEMACLIP_UPDATE_PUBKEY") ?? MANIFEST_PUBLIC_KEY;
```

Committing the public key is correct and the simplest safe option. If you would rather
not have it in git history, generate that file in CI from a (non-secret) variable before
`deno desktop` — but the private key must still never leave the secret store.

### 1.4 Signing script

`scripts/sign-manifest.ts` — signs the manifest file's verbatim bytes:

```ts
// Usage: MANIFEST_SIGNING_KEY=<base64 pkcs8> deno run -A scripts/sign-manifest.ts \
//          dist/release/latest.json dist/release/latest.signed.json
const privB64 = Deno.env.get("MANIFEST_SIGNING_KEY");
if (!privB64) throw new Error("MANIFEST_SIGNING_KEY is not set");

const [inPath, outPath] = Deno.args;
if (!inPath || !outPath) throw new Error("usage: sign-manifest.ts <in.json> <out.json>");

// The signed string MUST be the file's exact bytes.
const manifestText = await Deno.readTextFile(inPath);

// Parse only to fail loudly on a malformed manifest — never re-serialise it.
const parsed = JSON.parse(manifestText);
if (typeof parsed.version !== "string" || typeof parsed.patches !== "object") {
  throw new Error("manifest is missing a version string or a patches object");
}

const raw = Uint8Array.from(atob(privB64), (c) => c.charCodeAt(0));
const key = await crypto.subtle.importKey("pkcs8", raw, "Ed25519", false, ["sign"]);
const sig = new Uint8Array(
  await crypto.subtle.sign("Ed25519", key, new TextEncoder().encode(manifestText)),
);

await Deno.writeTextFile(outPath, JSON.stringify({
  signed: manifestText,                                  // verbatim
  signature: btoa(String.fromCharCode(...sig)),           // base64
}));
console.log(`signed ${inPath} -> ${outPath} (${manifestText.length} bytes)`);
```

**openssl equivalent**, if you prefer shell (verified working):

```bash
openssl pkeyutl -sign -inkey manifest-signing.pem -rawin -in latest.json -out latest.sig
jq -Rs --rawfile sig <(base64 -w0 latest.sig) '{signed: ., signature: ($sig|rtrimstr("\n"))}' latest.json \
  > latest.signed.json
```

`-rawin` is required — EdDSA in openssl 3 will not accept a pre-hashed input.

### 1.5 CI wiring (sketch for `release.yml`)

```yaml
publish:
  steps:
    # ... build artifacts, generate bsdiff patches, compose latest.json ...
    - name: Sign the update manifest
      env:
        MANIFEST_SIGNING_KEY: ${{ secrets.MANIFEST_SIGNING_KEY }}
      run: |
        deno run -A scripts/sign-manifest.ts dist/release/latest.json dist/release/latest.signed.json
        mv dist/release/latest.signed.json dist/release/latest.json

    # Fail the release rather than publish an envelope the app cannot verify.
    - name: Verify the envelope against the baked-in public key
      run: deno run -A scripts/verify-manifest.ts dist/release/latest.json
```

Add `scripts/verify-manifest.ts` (verify-only: re-import the public key, check the
signature over `signed`, then JSON-parse it). A publish job that cannot verify its own
output must fail — otherwise the first symptom is users stuck on an old version with only
a "no patch available" log line.

The existing `docs/DISTRIBUTION-PLAN.md` already specifies the `releases` branch +
GitHub Pages hosting and the `v*` tag trigger; signing slots into the `publish` job
between "compose `latest.json`" and "commit to `releases`".

### 1.6 Verification performed

Run on this machine, all passing:

- Deno keygen → openssl loads the exported PKCS8 and verifies Deno's signature: **OK**.
- openssl signing the same bytes → **byte-identical** to Deno's signature: **OK**.
- Python `cryptography` `public_key().verify(sig, signed_bytes)`: **OK**.
- `json.loads(envelope)["signed"].encode() == open("latest.json","rb").read()` — i.e. the
  JSON string-escaping round-trips to the original bytes: **OK**.
- Tamper test (mutating a version digit): signature rejected (`InvalidSignature`): **OK**.

---

## 2. Windows Authenticode

### 2.1 The headline fact: signing does not stop SmartScreen

Source: Microsoft, "SmartScreen reputation for Windows app developers" —
<https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation>

Microsoft's own table, "Certificate options and their SmartScreen implications":

| Certificate type | First-download SmartScreen behavior |
|---|---|
| Microsoft Store | ✅ No warning — covered by Microsoft's certificate |
| Valid Certificate (OV/EV) | ⚠️ Warning — app flagged as unrecognized until reputation accumulates; verified publisher name is displayed |
| No signature | ⚠️ Warning — "Windows protected your PC"; user must choose "Run anyway" before the app can run. Enterprise policy can prevent continuation entirely. |
| Self-signed Certificate | ⚠️ Warning — same behavior as no signature |

And, verbatim:

> EV certificates no longer bypass SmartScreen. Years ago, signing files with an Extended
> Validation (EV) code signing certificate would result in positive SmartScreen reputation
> by default, but this behavior no longer exists. EV certificates may matter for enterprise
> procurement, but they no longer impact SmartScreen behavior. **Paying a premium for EV
> solely to avoid SmartScreen warnings is no longer justified.**

This is the single most decision-relevant fact. Corroborated independently by reseller
CodeSigningStore on its EV product page: "March 2024 – Microsoft changed the way MS
SmartScreen interacts with EV Code Signing certificates. While these remain the highest
trust certificates, they no longer instantly remove SmartScreen warnings."

**What reputation actually depends on**, from the same Microsoft page: two signals —
*publisher reputation* (is it signed? is the certificate a known, trusted publisher?) and
*file hash reputation* (has this exact file been downloaded cleanly by many users?).
Timing: "There is no exact threshold, but it can take several weeks and hundreds of clean
installs from a wide audience."

**The real, non-obvious benefit of signing** is this sentence: "When a file is not signed,
SmartScreen reputation must build for each new version of your files, starting with zero
reputation. Reputation cannot transfer from previous versions unless both were signed
using the same publisher identity." So an unsigned app **resets to zero reputation on
every single release**; a consistently-signed one can carry certificate reputation forward
to new files.

### 2.2 What a user actually sees

- **Unsigned, on first download:** a full-screen blue "Windows protected your PC" dialog
  from SmartScreen. The user must click "More info" → "Run anyway". On Windows 11 with
  **Smart App Control** enabled, Microsoft states it "will block execution of unsigned
  files unless the file has a positive reputation" — no bypass at all. This is the worst
  case and it is the default on many new Win11 installs.
- **Signed (OV or EV), on first download:** the app is still flagged as unrecognized, but
  the dialog shows the **verified publisher name** instead of "Unknown publisher". The
  user still has to click through.
- **Either way, enterprise policy can block the install outright.**

So the honest summary is: signing changes *"Unknown publisher"* into *your name*, and lets
reputation accumulate once instead of resetting per release. It does not remove the
warning for a new, low-download app. Nothing except Microsoft Store distribution does.

**SemaClip-specific aggravator:** Deno's docs state Windows auto-update is not supported
("On Windows, patches are still downloaded and staged, but the launcher does not yet swap
them in … Treat Windows auto-update as not yet supported"). Windows users must therefore
download a **fresh installer for every single release** — the exact case where unsigned
builds reset SmartScreen reputation to zero each time.

### 2.3 What is obtainable, by whom, at what cost

Microsoft's MSIX signing page
(<https://learn.microsoft.com/en-us/windows/msix/package/signing-package-overview>)
summarises the options table:

| Scenario | Option | Cost (per Microsoft) |
|---|---|---|
| Development and local testing | Self-signed certificate | Free |
| Production (recommended) | Azure Artifact Signing (formerly Trusted Signing) | Basic ~$10/month |
| Production (alternative) | OV code signing certificate from a CA | $300–500/year |
| Microsoft Store distribution | Signed by the Store | Free |

**Azure Artifact Signing (formerly Azure Trusted Signing)** — verified numbers:

- Pricing from the Azure Retail Prices API
  (`https://prices.azure.com/api/retail/prices?$filter=serviceName eq 'Trusted Signing'`),
  fetched live: **Basic account $9.99/month**, **Premium account $99.99/month**, signature
  overage **$0.005** each. Quotas: Basic 5,000 signatures/month, Premium 100,000. Note the
  Azure pricing page states billing "is not calculated on a pro rata basis" — full SKU
  amount regardless of when you start.
- **Eligibility, verbatim from Microsoft:** "Available to organizations in the USA, Canada,
  the European Union, and the United Kingdom, and to individual developers in the USA and
  Canada. Organizations must have a verifiable tax history of three or more years."
  The Artifact Signing quickstart repeats the individual rule: "Individual developers must
  be located in the United States or Canada."
- Individual identity validation exists, and is a real, documented path: an "Identity
  Validation – Individual Developer" flow using a government-issued photo ID, verified
  through a third party (AU10TIX) and a Verified ID in Microsoft Authenticator. The Azure
  billing account must have Account Type **Individual**, and the legal name + sold-to
  address on it must match the ID. Processing takes "1 to 20 business days". You cannot
  choose a custom CN/O — the certificate must carry the validated legal name.
- `Private Trust` profiles are not geographically restricted, but they are scoped to your
  own Entra tenant / App Control for Business policy, not public trust for arbitrary end
  users — so they do not clear warnings for SemaClip's users. (Profile types verified from
  the quickstart; the "not public trust" characterisation is the plain reading of the
  product structure, treat as high-confidence inference rather than a quote.)
- CI integration is first-class: SignTool (needs the Artifact Signing Client Tools dlib +
  .NET 8), a GitHub Action, Azure DevOps tasks, and an SDK.

**The eligibility question for a private individual:**

- **Artifact Signing (Public Trust): effectively unavailable.** Organizations need a
  3-year tax history; individuals must be **resident in the USA or Canada**. If you are in
  the EU (the CEST timezone suggests you are), the individual path is closed. **Confirm
  your country of residence before spending any time here** — this is the one fact that
  flips the cost/benefit, and I could not verify your residency.
- **OV from a CA: available to individuals.** Certum's own product comparison
  (<https://www.certum.eu/en/code-signing-certificates/>) states plainly: "OV certificates
  involve a simpler validation process and **can also be issued to individuals**" while
  "EV … is available only to registered companies." CodeSigningStore likewise lists a
  Sectigo OV product as "Available for companies/corporations and **individual
  developers**". SSL.com markets a dedicated **IV (Individual Validation)** code signing
  certificate: "Personal name on every installer. No business docs required."
- **EV: generally requires a registered entity** (Certum: registered companies only).
  SSL.com does offer a "Sole Proprietor EV" for individuals — **but per §2.1 EV no longer
  affects SmartScreen, so it buys nothing here.** Do not pay the premium.

**Costs verified from vendor pages I fetched:**

| Product | Verified price | Notes |
|---|---|---|
| Certum **Open Source** | **from €25.00** | 1 year; "Dedicated to Open Source Licenses"; certificate data literally "Developer Open Source" |
| Certum Standard (OV) | from €139.00 | issuable to individuals |
| Certum EV | from €329.00 | registered companies only |
| Sectigo OV (via CodeSigningStore) | $302.10/yr (list $379) | "Removes SmartScreen warnings? **No**"; "Removes Unknown Publisher warnings? Yes" |
| DigiCert OV (via CodeSigningStore) | $404.00/yr (list $539) | organisations only on that listing |
| Sectigo EV (via CodeSigningStore) | $395.91/yr (list $498) | not worth it per §2.1 |
| USB token shipping (CodeSigningStore) | $90 US / $130 international | on top of certificate price |
| SignPath Foundation | **Free** for eligible OSS | see below |
| Microsoft Store | Free to submit, re-signed by Microsoft | the only option that fully avoids warnings |

Two industry changes visible on the reseller page, worth knowing: "February 2026 – Code
Signing Orders limited to 1-year", and "May 2023 – All new code signing certificate keys
are mandated to be stored on an HSM or compliant hardware token."

That last point is the CA/Browser Forum Code Signing Baseline Requirements
(<https://cabforum.org/working-groups/code-signing/requirements/>), verified directly:
*"Effective June 1, 2023, Subscriber Private Keys for Code Signing Certificates SHALL be
protected … in a Hardware Crypto Module with a unit design form factor certified as
conforming to at least FIPS 140-2 Level 2 or Common Criteria EAL 4+"* — satisfied by your
own FIPS/CC-certified HSM, a cloud key-protection service whose key never leaves its HSM,
or a Signing Service per §6.2.7.3. Individual Applicants are explicitly contemplated: the
CSBRs define *Individual: A natural person*, and §3.1 permits `subject:organizationName`
to convey a natural person's name. §3.2.3.1 governs individual identity verification
(government photo ID plus address verification via ID/QIIS/QGIS).

**Practical consequence:** any new OV certificate means either a physical USB token
in the mail, or a cloud-HSM signing service. You cannot sign from a key file in CI any
more. That is a real, permanent operational cost on top of the money.

### 2.4 The free option for open source: SignPath Foundation

Verified at <https://signpath.org/> and <https://signpath.org/terms.html>:

- "For OSS projects, our services are free of charge." "No need for personal
  identification, we verify that the binary was built from your open source repository and
  vouch for that with our name."
- **Eligibility conditions** (subset, verbatim): OSI-approved Open Source license **without
  commercial dual-licensing** for all components; no proprietary/non-open-source component;
  actively maintained; **already released in the form that should be signed**; functionality
  documented on the download page.
- **A reputation bar exists, and it is the blocker here:** "we cannot sign binaries based
  on source code that nobody knows. For executable programs that may be downloaded and
  executed based on our signature, we require a certain verifiable reputation."
- **The certificate is issued to SignPath Foundation, not to you** — "SignPath Foundation
  is the publisher of the OSS project." The publisher name on Windows would be SignPath
  Foundation.
- Additional requirements: MFA for all team members; a documented "Code signing policy"
  section on the project home page naming committers/reviewers/approvers; a privacy policy;
  signed binaries must carry product name/version metadata.

SemaClip is MIT (`README.md` §License), so the licence condition is satisfiable. The
**"already released" + "verifiable reputation"** conditions are not: the repo has no
remote (`git remote -v` is empty) and no users. This is a genuine future option at zero
cost, not a now option.

### 2.5 Not verified

Stated plainly rather than guessed:

- **SSL.com's IV Code Signing price.** The product page is client-rendered and returned no
  price to a plain fetch; I could not read it. Product existence and framing ("No business
  docs required") are verified.
- **Whether Certum's €25 Open Source certificate is publicly trusted for Windows
  SmartScreen / usable for Authenticode.** I verified it exists at that price with that
  description and a 1-year validity. I did **not** verify its full eligibility terms or its
  trust-chain behaviour. Check before buying.
- **Microsoft Store individual registration cost** (commonly quoted around $19 one-time,
  frequently waived) — I did not fetch a page confirming it, so treat as unverified.
- **Your country of residence**, which determines whether Artifact Signing's individual
  path is open to you at all.
- **Whether SmartScreen treats a `.msi` identically to an `.exe`** — Microsoft's reputation
  doc speaks of "downloaded files" generically and does not distinguish. Assume the warning
  applies to a `.msi` downloaded from GitHub Releases.

---

## 3. Recommendation

### Do now — manifest signing (§1)

**Cost: €0. Time: ~1 hour. No identity, no CA, no payment, no application process.**
There is no reason to defer it, and one strong reason to do it before the first public
release: signing is all-or-nothing (§1.1), so enabling it after users exist means either
breaking their updater or maintaining two manifests.

Concretely:

1. Generate the keypair (§1.2). Keep `manifest-signing.pem` **out of the repo** — add it to
   `.gitignore` and back it up somewhere you will not lose (a lost private key cannot sign
   future manifests, and you cannot rotate it without shipping a new app build).
2. Store the base64 private key as the GitHub secret `MANIFEST_SIGNING_KEY`.
3. **Fix the public key plumbing**: add a committed `release-key.ts` constant and make
   `auto-update.ts` read `Deno.env.get("SEMACLIP_UPDATE_PUBKEY") ?? MANIFEST_PUBLIC_KEY`.
   As written today the env-only read will be `undefined` in a real install (§1.3).
4. Add `scripts/sign-manifest.ts` + `scripts/verify-manifest.ts`; wire both into
   `release.yml`'s `publish` job, with the verify step gating the publish.

This is a private key in a secret store signing a file whose URL you control — the threat
model is "the Pages host / release branch is compromised", which is exactly the one
`docs/DISTRIBUTION-PLAN.md` was already worried about.

### Defer — Windows Authenticode (§2)

**Do not buy a certificate now.** Reasons, in order of weight:

1. **It would not achieve its goal.** The whole point is to stop SmartScreen warnings, and
   Microsoft states plainly that OV *and* EV both still show the warning until reputation
   accumulates over "several weeks and hundreds of clean installs". A pre-alpha personal
   project has neither users nor download volume, so a €139–400/yr certificate plus a
   $90–130 token buys: your real name instead of "Unknown publisher" in the dialog, plus
   reputation that does not reset every release. That is worth something — **but only once
   there is an audience to accumulate it with.** Buying now starts a renewal clock on a
   benefit that cannot begin to accrue.
2. **EV is now a trap.** Microsoft: "Paying a premium for EV solely to avoid SmartScreen
   warnings is no longer justified." If any vendor pitches EV for this purpose, the
   premise is false as of the March 2024 change.
3. **The ongoing operational cost is not just money** — hard-token or cloud-HSM key
   storage is mandatory post-June-2023, so signing needs a physical token or a signing
   service wired into CI forever.
4. **There is a free path that fits this project better later.** Once SemaClip is released
   publicly with some reputation, **SignPath Foundation** signs it for free, with no
   personal identification required and no key custody problem. Mitigating: the publisher
   name becomes "SignPath Foundation", and eligibility needs the project to be "already
   released" with "verifiable reputation".

**Prerequisites before Windows distribution is worth caring about at all:** `deno desktop`
currently cannot swap in updates on Windows (per the Deno docs and correctly noted in
`auto-update.ts`), so Windows users re-download a full installer every release. That is a
UX problem worth more attention than signing, and it is also what makes unsigned Windows
builds so punishing.

### If and when to revisit

Revisit when *all* of these hold: there is a public GitHub repo; Windows users exist;
someone other than you is downloading the installer; and Deno's Windows auto-update story
has been resolved.

Then, in order of preference:

1. **SignPath Foundation** — free, OSS-appropriate, no personal ID. Requires adding a
   "Code signing policy" section to the README naming approvers, plus a privacy policy.
2. **Certum Open Source (€25/yr)** — cheapest paid route, explicitly "Dedicated to Open
   Source Licenses" and issuable for open source. *Verify SmartScreen/trust-chain
   suitability first.*
3. **An OV certificate issued to you as an individual** (Certum Standard from €139, or
   SSL.com IV) — the straightforward answer to "I have no registered business." Never EV.
4. **Azure Artifact Signing Basic ($9.99/mo)** — the cheapest and most CI-friendly option
   *if* you qualify. Only available to individuals **resident in the USA or Canada**
   (organizations: US/CA/EU/UK + 3-year tax history). **Not available to an EU-based
   individual**, which likely rules it out here.

### One line of advice to the user

Tell Windows users to expect a SmartScreen prompt on first run and to click "More info →
Run anyway", and post the SHA-256 of each installer next to the download. That is the
practical mitigation available at zero cost, and it is honest about what an unsigned
pre-alpha build is.

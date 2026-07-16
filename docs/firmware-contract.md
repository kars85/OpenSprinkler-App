# Firmware Contract

App repo role: **CONSUMER**
Firmware repo role: **PRODUCER**

This document is the app-side counterpart to the firmware-owned API reference in `OpenSprinkler-Firmware/docs/docs/2.2.1/221_4_api.md`. The endpoint set and JSON field names are canonical there — the `_url_keys[]` / `urls[]` tables in `opensprinkler_server.cpp:2209-2266` are the source of truth. This document records the consumer constraints the producer must preserve for existing app builds, and the app-side assumptions that break if the producer changes them.

This axis is **axis D** in `OpenSprinkler-Firmware/docs/ecosystem.md`.

> **Note the inverted direction versus the weather axis.** On Weather↔Firmware the *producer* (weather) is canonical and the firmware adapts. Here the *producer* (firmware) is canonical and the app adapts. The frozen legacy App retains its broad compatibility policy; the modern fork UI deliberately supports only the authenticated `2214 + kars85` floor below.

## Scope

The app is not a general client of a versioned API. It reads firmware JSON responses by direct key access. The frozen legacy UI gates ~100 features on version helpers; the modern UI uses a pre-auth floor followed by authenticated `fwv`, `fwm`, `fwf`, and field-presence checks. The Axis-D CI job starts the native Firmware DEMO, exercises success shapes and mutations, and pins the `/jo`/`/ja` auth-failure contract.

Deployment makes both directions live simultaneously: authenticated `/cu` persists `jsp`; unauthenticated `/su` is the recovery/settings page. A published app update reaches every controller pointing at that host with no firmware flash, and old app builds keep hitting new controllers. **Neither side may assume the other was updated.**

## Hard Constraints On The Producer

1. **`_url_keys[]` and `urls[]` are positional and must stay index-aligned.**
   The firmware dispatches by finding the 2-char key's index in `_url_keys[]` (`opensprinkler_server.cpp:2209-2236`) and calling `urls[i]` (`:2239-2266`). There is no compile-time link between the tables. Inserting or removing an entry in one without the other silently shifts every handler after that point — the app receives a well-formed 200 response from the *wrong* handler.

2. **`/jo` and `/ja` must keep emitting `fwv` when the password check fails.**
   `opensprinkler_server.cpp:2449-2455` special-cases these two endpoints: on `check_password()==false` the firmware returns **HTTP 200** with `{"fwv":<n>}` (`iopt_json_names+0` is `fwv`, `OpenSprinkler.cpp:118-119`) instead of an auth error. This is not an information leak to be cleaned up — it is the app's **auth bootstrap**, and removing it breaks adding any site. See "Auth bootstrap" below for the exact dependency.
   `/su` bypasses password checks entirely (`:2445-2448`) so recovery remains reachable; authenticated `/cu` is the only path that persists `jsp`.

3. **Never bump `fwv` for a fork feature.**
   A changed `OS_FW_VERSION` can trigger `factory_reset()` and rewrite device configuration. Keep the fork baseline at `fwv=221`, `fwm=4`; the first firmware-visible addition uses `fwm=5` and is consumed only when `fwf` starts with `kars85.`, combined version is at least `2215`, and the field is present.

4. **`fwv` and `fwm` must remain integers with the documented arithmetic.**
   The app computes 4-digit checks as `fwv * 10 + fwm` (`www/js/modules/firmware.js:164-170`) and formats display as `(fwv/100>>0) + "." + ((fwv/10>>0)%10) + "." + (fwv%10)` (`firmware.js:261`). Both are iopts in `/jo` (`OpenSprinkler.cpp:118` for `fwv`, `:159` for `fwm`). A string `fwv` is interpreted as OSPi (see below), not as a version.

5. **Use each version signal for one job.**
   `fwv` is the upstream/storage epoch, `fwf` is fork identity/build display, and `fwm` is the reset-free capability level. The kars85 fork emits `fwf` as read-only `/jo` data (`opensprinkler_server.cpp:1122-1125`, `defines.h:47-50`). Never parse the `fwf` counter as a capability and never use `fwv` as fork identity.

## Version Gating

### Modern fork floor

1. Probe unauthenticated `/jo`. A nonnumeric `fwv` or numeric value below `221` is Unsupported; do not send credentials.
2. For numeric `221+`, send only md5-hash authentication. A `fwv`-only response is Authentication required/failed, never Unsupported.
3. After a full `/jo` response, require `fwv === 221`, `fwv * 10 + fwm >= 2214`, `fwf` beginning with `kars85.`, and every field the current feature consumes.
4. Future firmware-visible features additionally require combined version `>=2215` and their field presence. Do not add a cleartext fallback or bump `fwv`.

Every Unsupported screen points to the frozen legacy UI or the firmware upgrade path. Official builds, OSPi's string `fwv`, and unapproved future storage epochs are outside the modern support matrix.

### Frozen legacy gates

`OSApp.Firmware.checkOSVersion( n )` (`www/js/modules/firmware.js:158-182`) is the single detection primitive. Behavior worth knowing:

- **Empty controller object returns `false`** (`firmware.js:159-161`) — gates fail closed before the first `/jo` lands.
- **3-digit checks compare `fwv` alone; 4-digit checks (`>= 1000`) fold in the minor version** as `fwv * 10 + fwm`, returning `false` if `fwm` is `NaN` (`firmware.js:164-170`). So `checkOSVersion( 2214 )` means firmware 2.2.1(4) — current `defines.h` is `OS_FW_VERSION 221` / `OS_FW_MINOR 4`.
- **OSPi always returns `false`** (`firmware.js:172-173`). `isOSPi()` triggers on a *string* `fwv` matching `/ospi/i` (`firmware.js:184-193`). Frozen legacy features therefore use data-presence checks where needed; the modern fork UI does not support OSPi.
- Comparison is digit-array based, not numeric (`versionCompare`, `firmware.js:195+`).

Live gate tiers, for reference when deciding whether a change needs a bump:

| Gate | Guards (examples) |
|---|---|
| 206 | log viewing (`ui-dom.js:300`) |
| 208 | string options / location (`options.js:286`, `import-export.js:204`) |
| 210 | program data format `pd` bitfield, NTP/DHCP options, log deletion (`programs.js:1838`, `options.js:907-913`, `logs.js:612`) |
| 211 | flow logging, import format boundary (`logs.js:545`, `import-export.js:214`) |
| 213 | **md5 password hashing** (`network.js:796`), sunrise/sunset programs (`programs.js:2354`) |
| 214 | `ip4` change detect, station attributes, option ranges (`network.js:318`, `stations.js:322`, `options.js:1567`) |
| 215 | `wto` weather options, `bst` (`import-export.js:221`, `options.js:854`) |
| 216 | firmware update capability, `/ja` all-in-one fetch (`firmware.js:353`, `sites.js:1027`) |
| 217 | HTTP station type, `ifkey`, program sensor type 240 (`dashboard.js:474-478`, `options.js:43`, `import-export.js:226`) |
| 219 | soil sensor, weather API key verification, extra log metrics (`options.js:41`, `supported.js:84`, `logs.js:605`) |
| 2162 | Zimmerman baseline ETo (`weather.js:81`) |
| 2191 | `dname`, `mqtt`, `email`, `otc` config import (`import-export.js:231-245`) |
| 2199 | interval-day minimum of 1 (`programs.js:2591`) |
| 220 | date-range programs, latch on/off, sequential retirement, ±600 option ranges (`supported.js:57-76`, `options.js:891-899`, `options.js:1525`) |
| 2211 | pause change, single-run/monthly, repeated runonce, `runorder` (`supported.js:80-94`, `programs.js:664`) |
| 2213 | weather restrictions, `imin`/`imax` (`supported.js:99`, `options.js:875-883`) |
| 2214 | queue order, `tpdv`, weather option (`programs.js:2832`, `options.js:863`, `weather.js:707`) |
| 221 | large `sopt` support (`options.js:1748`) |
| 300 | **`POST` for change commands — no such firmware exists; see below** |

### The dormant POST path

`OSApp.Firmware.sendToOS` selects `POST` over `GET` for change commands only when `checkOSVersion( 300 )` (`firmware.js:53-58`) — i.e. firmware 3.0.0. **No such firmware exists**, so every change command ships as a `GET` with the password in the query string today. The comment there says "requires firmware 2.1.8 or newer," which the `300` gate contradicts. Treat this as reserved, not live: **if firmware ever reaches 3.0.0, this path silently activates** and `POST` bodies must be accepted for `cv|cs|cr|cp|uwa|dp|co|cl|cu|up|cm`. Do not reach 3.0.0 without checking this line.

### Capability detection that does not use `fwv`

`www/js/modules/supported.js` is the app's preferred detection layer and is the pattern to extend. It splits into two kinds:

- **Data-presence checks** — work on OSPi, where numeric gates are dead: `master` (`mas`/`mas2` iopts), `ignoreRain` / `ignoreSensor` / `actRelay` / `disabled` / `special` (typed keys under `controller.stations`), `pausing` (`settings.pq !== undefined`), `groups` (option count `>= 4`).
- **Version-backed checks** — `dateRange` (220), `changePause` (2211), `verifyWeatherAPIKey` (219 + `uwt` + `wto`), `restrictions` (2213 + `wto`).

These helpers document frozen legacy behavior. New modern fork capability checks use the layered policy above.

## Auth Bootstrap

The modern flow probes `/jo` without credentials, rejects values below `221`, and hash-authenticates plausible `221+` devices. It never sends cleartext. The firmware's HTTP-200 `{"fwv":N}` failure response remains load-bearing because it distinguishes Authentication from Unsupported without exposing full options.

### Frozen legacy cleartext fallback

The add-site flow below exists only in the frozen legacy UI (`www/js/modules/sites.js:814-815`, `:671-696`). It must remain compatible during rollback, but it is not the modern authentication policy.

The probe **always** sends `/jo?pw=md5(<password>)` — the app does not yet know the firmware version, so it cannot know whether to hash. Two outcomes:

| Firmware | What happens | App reads | Result |
|---|---|---|---|
| `fwv >= 213` (expects md5) | Hash matches, `/jo` returns the full option set | `data.fwv >= 213` **and** `data.wl` is a number | stores **md5(pw)** (`sites.js:692-696`) |
| `fwv < 213` (expects cleartext) | Hash is the *wrong* password → the `:2449-2455` escape hatch returns **HTTP 200** `{"fwv":N}` | `data.fwv` present, **`data.wl` undefined** | stores **cleartext pw** |

So `wl` (water level, an iopt in `/jo` — `OpenSprinkler.cpp:142`) doubles as the **auth-success sentinel**: its presence means the full option set came back, which means the md5 was accepted. The `fwv < 213` branch depends on the failure response being a *success-shaped* 200 that carries `fwv` and omits everything else.

**Consequences for the producer:**
- Returning `401`/`403` instead of the 200+`fwv` shape on `/jo` auth failure breaks add-site for all pre-2.1.3 firmware.
- Adding `wl` to the auth-failure response breaks the cleartext branch (the app would store md5 for a controller expecting cleartext).
- Removing `wl` from a successful `/jo` breaks the md5 branch the same way, in reverse.

Firmware 1.8.3 is detected out-of-band by response shape — `data.match( /var (en|sd)\s*=/ )` or `fwv === 203` (`sites.js:675-677`) — and gets a `cache: true` workaround for a timestamp bug in its GET handling (`firmware.js:82-88`).

Beyond the probe, every request injects the password by string replacement on `pw=` (`firmware.js:44`), and optional HTTP Basic auth is layered on top for reverse-proxied controllers (`firmware.js:70-78`, `sites.js:823-835`).

## Response Contract

`sendToOS` normalizes replies (`firmware.js:90-130`) and couples to the `result` code numbering:

| `result` | App behavior |
|---|---|
| `1` | success, data returned |
| `2` | rejected as **HTTP 401** internally to prevent retry; shows "Check device password and try again." on change commands |
| `32` | rejected as **HTTP 404** |
| `48` | "The selected station is already running or is scheduled to run." |

Responses are parsed as JSON with a string fallback (`firmware.js:93-100`), and a missing/non-numeric `result` is passed through untouched — that path exists for OSPi and pre-2.1.0 firmware.

## Endpoints Consumed

Read endpoints (JSON field names are part of the contract — the app reads keys directly):

| Endpoint | Purpose | App call site |
|---|---|---|
| `/jo` | options (`fwv`, `fwm`, `wl`, `uwt`, `hwv`, `fwf`) | `sites.js:1169`, `stations.js:206` |
| `/jc` | controller status and string/config data (`jsp`, `wsp`, `wto`, `wtdata`, `wterr`, `wtrestr`, `otc`/`otcs`) | `sites.js:1243`, `network.js:845` |
| `/js` | station status | `sites.js:1194` |
| `/jn` | stations | `sites.js:1126` |
| `/jp` | programs | `sites.js:1093` |
| `/ja` | all-in-one (gated 216) | `sites.js:1028` |
| `/je` | special stations | `sites.js:1347` |
| `/jl` | logs | `logs.js:546-555` |
| `/su` | recovery/settings page (**no auth**) | firmware-served recovery |

Change endpoints (`cv|cs|cr|cp|uwa|dp|co|cl|cu|up|cm` are the set `sendToOS` routes to the "change" AJAX queue and error-reports on — `firmware.js:52`):

`/cv` values · `/co` options · `/cs` stations · `/cm` manual · `/cp` program · `/dp` delete program · `/up` move program up · `/cr` run-once · `/mp` manual program · `/dl` delete log · `/sp` set password · `/cu` change script URL · `/pq` pause queue

Sensor endpoints (`/se`, `/sl`, `/sh`, `/sf`, `/sa`, `/sc`, `/sb`, `/sn`, `/so`) are called from `www/js/modules/analog.js`.

## Other Direct Dependencies

- **Weather.** The legacy UI calls the configured `wsp` directly for `/weatherData` and `/baselineETo`, and calls `api.weather.com/v2/pws/` to validate Weather Underground data (`www/js/modules/weather.js:469-486`, `:559-593`, `:665-699`). It also reads options (`uwt`, `wl`) from `/jo` and cached Weather results (`wtdata`, `wterr`, `wtrestr`) from `/jc`. The modern UI must not add a direct Weather dependency; these legacy calls retire with the legacy surface.
- **The OTF library.** The app compiles nothing from `OpenThings-Framework-Firmware-Library`. It couples to the same **OpenThings Cloud service**, routing through `https://cloud.openthings.io/forward/v1/<token>` in place of the controller IP (`firmware.js:56`, `sites.js:396`), with tokens matching `^OT[a-fA-F0-9]{30}$` (`dashboard.js:169`). Every endpoint above works through that prefix unchanged, which is why the URL shape is a contract in its own right (`OpenSprinkler-Firmware/docs/external-contracts.md`).

## Maintenance Contract

**The firmware is canonical on this axis.** Before changing anything above:

1. **Never renumber or reorder `_url_keys[]`.** Endpoint keys and JSON field names are append-only in practice — old app builds and old controllers coexist in the field in both directions.
2. **Never bump `fwv` for a fork capability.** Bundle firmware-visible additions under `fwm=5`, require `kars85.` identity and field presence, and retain an absence fallback.
3. **Before removing or renaming a field or endpoint, grep the App's call sites and extend the Axis-D contract test.** The typed test intentionally validates only fields the modern App consumes.
4. **Treat `/jo`+`/ja` fwv-on-auth-failure and `/su`-without-auth as load-bearing**, not as security defects to be tidied.
5. Update this doc and the firmware-side API reference together, and keep `OpenSprinkler-Firmware/docs/ecosystem.md` axis D in sync.

---
*Consumer-side counterpart to `OpenSprinkler-Firmware/docs/docs/2.2.1/221_4_api.md`. Hub map: `OpenSprinkler-Firmware/docs/ecosystem.md` (axis D). See also `external-contracts.md` for the OTC URL shapes this app shares with the firmware.*

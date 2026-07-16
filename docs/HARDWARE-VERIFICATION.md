# Hardware verification runbook

> **OPERATOR-GATE:** every step that contacts or changes a controller is performed by the device
> owner. Automation may prepare commands, tests, and checklists, but it must not run them against
> hardware. Never commit controller credentials, tokens, location, network addresses, station names,
> program names, or captured secret-bearing responses.

This runbook verifies the modern App without assuming factory defaults. The software gate is an
authenticated `fwv=221`, combined version `fwv * 10 + fwm >= 2214`, `fwf` starting with
`kars85.`, and every required field being present. A future App-visible firmware addition uses
`fwm=5` plus field presence; **never bump `fwv` for a fork feature** because a `fwv` change can
factory-reset device configuration.

## 0. Before any controller access

- [ ] Rotate every credential exposed before this runbook was sanitized.
- [ ] Store the controller base, credentials, OTC token, and physical recovery method in an
  approved secret store—not in this repository, issue comments, shell history, or screenshots.
- [ ] Confirm direct `/su` recovery access. `/su` displays recovery settings; authenticated
  `/cu` persists `jsp`.
- [ ] Privately inventory enabled state, programs, special outputs, disabled/master zones,
  weather configuration, and network configuration.
- [ ] Select a physically disconnected test zone, or skip all actuation checks. A disabled bit or
  an unfamiliar name is not proof that a conductor is safe.

Suggested local variables (replace placeholders only in the operator's shell):

```powershell
$env:OS_LIVE_BASE = '<controller-base>'
$env:OS_LIVE_PW = '<controller-password>'
$env:OS_LIVE_FWV = '221'
```

Do not place a password or hash in a command-line URL. The repository harnesses read credentials
from environment variables.

## 1. Capture a private baseline (read-only)

Save full authenticated responses outside the repository before any write:

- `/jc`: `en`, `rd`, `rdst`, `dname`, `loc`, `jsp`, `wsp`, `wto`, `mqtt`,
  `email`, `otc`, `wterr`, `wtrestr`, `sbits`, `ps`, and `nq`.
- `/jo`: `fwv`, `fwm`, `fwf`, `wl`, `uwt`, sensor/master options, timezone, logging,
  HTTP port, NTP, DHCP, and network octets.
- `/jn`: names and every station attribute/group array.
- `/je`: every special-output type and definition.
- `/jp`: `nprogs` and every complete program tuple.
- `/js`: station state.

`jsp` is emitted by `/jc`, not `/jo`. If any required read fails, stop before writes.

### Sanitized contract capture

The capture command is read-only and writes a scrubbed corpus under
`test/fixtures/live/<fwv-combined>/`; it never overwrites `test/fixtures/api/`.

```powershell
npm run capture
npm run verify:live
```

The capture command performs endpoint shape checks; `verify:live` runs the App parsers against the
controller. Review the diff before committing a corpus. The sanitizer removes credentials, network/location
identity, device/station/program names, and special-output definitions while retaining response
shapes. If a new secret-bearing field appears, update the sanitizer before committing anything.

## 2. Read-only protocol proof

```powershell
npm run verify:live
```

- [ ] Pre-auth `/jo` returns a numeric `fwv` without credentials.
- [ ] Nonnumeric or below-`221` values are rejected without sending credentials.
- [ ] Numeric `221+` uses hash authentication; a `fwv`-only response means Login/Auth failed,
  not Unsupported.
- [ ] A full response passes only with storage epoch `221`, combined version `>=2214`,
  `kars85.` identity, and required fields.
- [ ] `/jc`, `/jo`, `/jn`, `/je`, `/jp`, `/js`, and `/ja` parse without exposing raw
  secrets.
- [ ] `/jn.stn_spe` joins to `/je.st`; raw `/je.sd` never appears in homeowner copy.

CI exercises the same shapes against an isolated Firmware DEMO data directory.

## 3. UI render proof

### Mock data (safe)

```powershell
npm run demo
```

- [ ] Every section renders from 320 px through desktop without page-level horizontal scroll.
- [ ] Keyboard focus is visible and follows visual order.
- [ ] Dark mode, reduced motion, and 44 px coarse-pointer targets remain usable.

### Live LAN and OTC (read-only operator check)

- [ ] Capture the section 1 baseline first.
- [ ] Load the device-injected LAN shell and click no mutation control.
- [ ] Load the immutable HTTPS build through the full OTC `/forward/v1/<token>/` base and confirm
  the prefix is preserved.
- [ ] Confirm no mixed-content or CORS error. Hosted HTTPS-to-HTTP standalone LAN access is not a
  supported route; do not bypass browser policy.
- [ ] Confirm a wrong password returns to Login and an authenticated `221/4/kars85.*` controller
  loads normally.

## 4. Reversible non-actuating write proof

> **OPERATOR-GATE:** this changes controller state. Run only after the private baseline exists and
> restore the captured value, not an assumed default.

The permitted first proof is rain delay:

1. Fresh-read the current state.
2. Write an operator-approved temporary value.
3. Re-read and verify it.
4. Restore the captured value in cleanup that runs on failure.
5. Independently re-read before reporting success.

```powershell
$env:OS_LIVE_WRITE = '1'
npm run verify:live
Remove-Item Env:OS_LIVE_WRITE -ErrorAction SilentlyContinue
```

If transport fails between write and restore, restore manually before leaving the controller.
Neither HTTP 200 nor a UI toast proves restoration.

## 5. Actuation smoke test

> **OPERATOR-GATE:** `/cm`, `/cr`, and Run now can energize real outputs even while normal
> scheduling is disabled. Skip unless the operator approved a physically disconnected zone.

- [ ] Confirm the target is neither master nor special and is physically disconnected.
- [ ] Fresh-read `/jc`, `/jn`, `/je`, and `/js`; name the target and consequence in
  confirmation.
- [ ] Start for the approved short duration; verify `/jc` and `/js` readback.
- [ ] Stop it; verify runtime bits, queue, and remaining time clear.
- [ ] Repeat with Stop all only if approved.
- [ ] Do not enable the controller or run a saved program for this test.

## 6. Settings and schedule write proof

> **OPERATOR-GATE:** use throwaway data only. Every mutation follows fresh read, validation, named
> confirmation, dirty-key write, and readback.

- [ ] An option edit sends only changed keys and preserves adjacent options and secrets.
- [ ] A zone edit sends only changed names/attributes and preserves other bitfields.
- [ ] A new test program starts disabled with zero durations unless explicitly approved.
- [ ] Editing only its name preserves raw durations `1`, `59`, `60`, `61`, `90`,
  `65533`, `65534`, and `65535`.
- [ ] A stale tuple produces a conflict instead of an overwrite.
- [ ] Delete the throwaway and verify original tuples are unchanged.
- [ ] Never test network settings without a physical recovery path.

## 7. UI-source flip and rollback

> **OPERATOR-GATE:** do not perform a live `/cu` flip until this procedure and the immutable
> release have been reviewed.

1. Read authenticated `/jc.jsp` and save it privately.
2. Verify direct `/su` recovery access.
3. If `jsp` is blank, do not plan to restore it with `/cu?jsp=`. The handler ignores a
   zero-length value. First write the explicit compiled default
   `https://ui.opensprinkler.com/js` through authenticated `/cu`, then verify that exact
   nonblank value via `/jc.jsp` and load the legacy shell.
4. Record that value as the effective rollback base. If exact blank preservation is required, stop
   until a hardware-proven method exists.
5. Verify `<parallel-base>/home.js`, then write the site root through `/cu`. Do not append
   `/js` because the Vite build emits `home.js` at the root.
6. Re-read `/jc.jsp` and verify LAN and OTC read-only behavior.
7. Roll back by writing the recorded nonblank effective rollback base through `/cu`.
8. Re-read `/jc.jsp` and load the legacy shell. UI rollback never requires a firmware flash or
   factory reset.

## 8. Close-out

- [ ] Fresh authenticated reads match the complete private baseline.
- [ ] Weather-driven values are judged by configuration/health, not a moving literal.
- [ ] No throwaway program or test name remains.
- [ ] No live-write environment flag remains.
- [ ] Previously exposed credentials have been rotated.
- [ ] Comment **OPERATOR-GATE** with skipped hardware/browser checks. Do not mark hardware-only
  checkboxes complete from software evidence.

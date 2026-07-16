# API fixtures — curated, derived from source

These JSON fixtures were reconstructed from the OpenSprinkler-Firmware **emit code**
(`opensprinkler_server.cpp`), not captured from a live device. They model a
**1-board / 8-station / 1-program** controller and pin the *shapes* the typed client
(`www/src/api/`) depends on.

These fixtures are deterministic parser examples and are never overwritten by live capture.
`npm run capture` writes sanitized hardware evidence under
`test/fixtures/live/<fwv*10+fwm>/`; `npm run verify:live` runs the same parsers against the
controller. Firmware DEMO contract coverage runs separately in CI.

Known shape notes baked into these fixtures (verified against firmware source):
- `/jc.lrun` is `[station, program, duration, endtime]` — **station first**.
- `/jc.eip` is a uint32 IPv4 here; IPv6 builds may emit a string (`number | string`).
- `/jl` is a **bare array** of mixed rows; station rows have a number at index 1,
  special rows have a string (`s1|s2|rd|wl|fl|cu`) — discriminate before indexing.
- `/jp` `daterange` ints are int16 (`-32768/32767`), not 32-bit.
- Signed options (`tz`, `mton/mtof`, `mton2/mtof2`) are decoded-signed integers.
